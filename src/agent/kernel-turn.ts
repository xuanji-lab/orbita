/**
 * 新内核（pi-durable）跑一轮：把旧内核 openTurn 装配的同一套东西——工具、审批闸门、系统提示——接到 durable 上。
 * 不 import electron，`node --test` 直接测（Harness 用 MemoryStorage、模型用 faux）。
 *
 * 装配方式：每条会话一个 durable 扩展 `orbita-session-<会话 id>`，**每轮按这一轮的开轮命令重建并装上**
 * （registry.install 同名即原地替换），会话的 agent 只选这一个扩展。与旧内核「每轮开一个 AgentSession、
 * 装配全部重来」同一个节奏：中途切档、MCP 重载、挂新目录，下一轮生效。
 *
 * - 工具：内建七件（pi 同一个工厂）+ turn-tools.ts 的同一份清单，经 durable-tools.ts 薄适配；顺序按
 *   「已在的保持原位、新的接后面」（kernel-prompt.ts 的 loadoutOrder），与旧内核从本子回放出来的顺序同规则。
 * - 闸门：`beforeTool` 调**同一个** createToolCallGate（permission.ts）与 createPlanGate；询问档的等待经
 *   awaitWithContext 听 abort（停止时不卡住）。拒绝语经 `afterTool` 还原成旧内核那样的一段原文，
 *   不让 durable 包成 `<harness>[error] Tool call blocked: …</harness>`。
 * - 系统提示：pi 基础提示（kernel-prompt.ts）→ adaptSystemPrompt → orbitaSystemSegments，每段一个不加标签的
 *   section；durable 把它们按 `\n\n` 拼起来，与 joinSystemPrompt 逐字节相同。
 * - 逐请求注入：`beforeRequest` 跑 kernel-wire.ts（图片预算、目标账、记忆附件、用户情境，与旧内核同一串函数）。
 */
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  defineExtension,
  GenerationTask,
  hook,
  section,
  ToolTask,
  type Conversation,
  type EntryRecord,
  type Extension,
  type HookApi,
  type JsonObject,
  type Registry,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelTurnCommand } from "../shared/kernel.ts";
import type { PermissionAnswer } from "../shared/permission.ts";
import { composePromptText } from "../shared/prompt-attachments.ts";
import { builtinToolDefinitions, toDurableTool } from "./durable-tools.ts";
import { liftMessages, TurnWire } from "./kernel-wire.ts";
import { loadoutOrder, loadPiResources } from "./kernel-prompt.ts";
import type { McpHub } from "./mcp.ts";
import { recallMemories } from "./memory-inject.ts";
import { createToolCallGate, type ToolCallLike } from "./permission.ts";
import { createPlanGate, type PlanToolOptions } from "./plan-tools.ts";
import { forModel, preparePromptImages } from "./prompt-images.ts";
import { adaptSystemPrompt } from "./prompt-narration.ts";
import type { RequestBroker } from "./request-broker.ts";
import { orbitaSystemSegments } from "./system-prompt.ts";
import { createTurnTools, extraToolNames, isChildSession, turnToolFlags } from "./turn-tools.ts";

/** 每条会话的扩展名：会话 id 已过白名单（字母数字 _ -） */
export function sessionExtensionName(sessionId: string): string {
  return `orbita-session-${sessionId}`;
}

/**
 * 审批的等待表：请求 id → 回答。与旧内核 runtime.ts 的 pendingPermissions 同一个请求-应答形状
 * （permission 事件出去、permissionAnswer 命令回来），差别只在等待**听 abort**：durable 的 abort 会等
 * beforeTool 返回，不听的话停止会卡在一个没人点的审批上（方案 §2.2 第 6b 行的实测）。
 */
export class PermissionWaiter {
  private readonly pending = new Map<string, (answer: PermissionAnswer) => void>();
  private readonly send: (event: AgentEvent) => void;

  constructor(send: (event: AgentEvent) => void) {
    this.send = send;
  }

  ask(sessionId: string, request: ToolCallLike, context: Context): Promise<PermissionAnswer> {
    const requestId = `${sessionId}:${request.toolCallId}`;
    const answered = new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, resolve);
      this.send({ type: "permission", sessionId, requestId, toolName: request.toolName, input: request.input });
    });
    return awaitWithContext(answered, context).finally(() => this.pending.delete(requestId));
  }

  /** 回答到得比请求晚是正常的（停止、超时之后）：请求已不在就丢弃 */
  answer(requestId: string, answer: PermissionAnswer): void {
    this.pending.get(requestId)?.(answer);
    this.pending.delete(requestId);
  }

  /** 正在等用户回答的请求数（测试与排障用） */
  get size(): number {
    return this.pending.size;
  }
}

/** 一轮要的进程级依赖（kernel-runtime.ts 持有，跨会话共用） */
export interface KernelTurnRuntime {
  broker: RequestBroker;
  mcpHub: McpHub;
  permissions: PermissionWaiter;
  send: (event: AgentEvent) => void;
  resolveShellPath: () => string | undefined;
}

/** 一轮要的会话级对象 */
export interface KernelTurnTarget {
  registry: Registry;
  conversation: Conversation;
  /** 这一轮的模型（服务商已注册进模型目录） */
  model: Model<Api>;
  /** 这条会话发给服务商的 sessionId（durable 的 ProviderDoc；旧会话迁来时沿用本子头 id） */
  providerSessionId: string;
}

/**
 * 叶子路径上的条目，换成 pi SessionEntry 的形状（`{ type: "message", message }` / `{ type: "compaction" }`）——
 * update_plan / update_goal 找上一份、压缩后挂目标账读的都是这个形状（plan-tools / goal-tools / goal-compaction）。
 * 增量拉：只拉上次之后的新条目（长会话每次工具调用都全量翻一遍太贵）。
 */
export class DurableBranch {
  private readonly items: unknown[] = [];
  private lastId = 0;

  get entries(): readonly unknown[] {
    return this.items;
  }

  async refresh(reader: Pick<HookApi, "entries">, context: Context): Promise<void> {
    let cursor: Parameters<HookApi["entries"]>[2];
    for (;;) {
      const page = await reader.entries(
        { minEntryId: (this.lastId + 1) as EntryRecord["id"], order: "ascending" },
        500,
        cursor,
        context,
      );
      for (const entry of page.items) {
        this.lastId = Math.max(this.lastId, entry.id);
        const piEntry = asPiEntry(entry);
        if (piEntry !== null) this.items.push(piEntry);
      }
      if (page.next === undefined) return;
      cursor = page.next;
    }
  }
}

function asPiEntry(entry: EntryRecord): unknown {
  if (entry.kind === "pi.compaction") return { type: "compaction", id: String(entry.id) };
  if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result") return null;
  const message = entry.model?.[0];
  if (message === undefined) return null;
  return { type: "message", id: String(entry.id), message };
}

/** 把 durable 写的拒绝结果还原成旧内核的样子：一段拒绝原文（pi-agent-core 的 createErrorToolResult） */
const BLOCKED_PREFIX = "Tool call blocked: ";
export function unwrapBlocked(result: ToolExecutionResult): ToolExecutionResult | undefined {
  const blocked = result.diagnostics?.find((diagnostic) => diagnostic.code === "blocked");
  if (blocked === undefined) return undefined;
  const reason = blocked.message.startsWith(BLOCKED_PREFIX) ? blocked.message.slice(BLOCKED_PREFIX.length) : blocked.message;
  return { output: [{ type: "text", text: reason }], isError: true };
}

/** 这一轮装进 durable 的东西（测试直接看它） */
export interface AssembledTurn {
  extension: Extension;
  /** 发给模型的工具名，按发出顺序 */
  toolNames: string[];
  /** 发给模型的系统提示全文（各段按 `\n\n` 拼接后） */
  systemPrompt: string;
}

/**
 * 按开轮命令装配这一轮（不提交、不跑模型）。`previousTools` 是模型此前看到的工具清单（durable 回放出来的）。
 */
export async function assembleTurn(
  command: KernelTurnCommand,
  runtime: KernelTurnRuntime,
  target: KernelTurnTarget,
  previousTools: readonly string[],
  wire: TurnWire,
  memoryTurn: number,
): Promise<AssembledTurn> {
  const flags = turnToolFlags(command);
  const currentMode = () => command.mode;
  const branch = new DurableBranch();
  const planOptions: PlanToolOptions = {
    getMode: currentMode,
    planFirst: command.planFirst === true,
    branch: () => branch.entries,
    state: { stopping: false },
  };
  const planGate = createPlanGate(planOptions);
  // MCP：与旧内核同一个 hub 语义（按工作区分片、ensure 幂等、连不上不拦开轮）
  const mcpScope = command.workspaceId ?? "";
  await runtime.mcpHub.ensure(mcpScope, command.mcpServers, command.workspaceId === null ? "" : command.cwd);
  runtime.send({ type: "mcp", servers: runtime.mcpHub.describe() });
  const mcpTools = runtime.mcpHub.toolsFor(mcpScope);

  const resources = await loadPiResources({ cwd: command.cwd, skillsDirs: command.skillsDirs, resolveShellPath: runtime.resolveShellPath });
  const definitions = [
    ...builtinToolDefinitions(command.cwd, resources.builtinOptions),
    ...createTurnTools({
      command,
      flags,
      broker: runtime.broker,
      mcpTools,
      currentMode,
      planOptions,
      branch: () => branch.entries,
      attachedImages: () => wire.attachedImages(),
      memoryTurn: () => memoryTurn,
    }),
  ];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const toolNames = loadoutOrder(previousTools, definitions.map((definition) => definition.name));
  const scope = {
    cwd: command.cwd,
    model: () => target.model,
    thinkingLevel: () => command.thinkingLevel,
    providerSessionId: () => target.providerSessionId,
  };
  const tools = toolNames.flatMap((name) => {
    const definition = byName.get(name);
    return definition === undefined ? [] : [toDurableTool(definition, scope)];
  });

  const segments = orbitaSystemSegments({
    piBase: adaptSystemPrompt(resources.basePrompt(toolNames, definitions)),
    mode: command.mode,
    extraToolNames: extraToolNames(
      mcpTools.map((tool) => tool.name),
      flags,
    ),
    role: flags.role,
    workspace: command.workspaceId === null ? null : { name: command.workspaceName },
    cwd: command.cwd,
    directories: command.directories,
    gitAttribution: command.gitAttribution ?? true,
    attributionLanguage: command.attributionLanguage,
    intentGuideline: command.intent !== undefined,
    memoryToolsGuideline: flags.memoryTools,
    longTaskAutomationGuideline: flags.automationTools,
  });
  // 空段（Git 标识关了）不渲染：与 joinSystemPrompt 滤掉空串同效
  const sections = segments.map((segment) => section(segment.name, () => (segment.text === "" ? undefined : segment.text), { tag: false }));

  const extension = defineExtension({
    name: sessionExtensionName(command.sessionId),
    tools,
    sections,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          await branch.refresh(api, context);
          // 闸门原地改入参（超时下限、用户在审批里改的参数）：给它一份拷贝，改了就回传新参数
          const input = JSON.parse(JSON.stringify(call.arguments)) as Record<string, unknown>;
          const event: ToolCallLike = { toolCallId: call.id, toolName: call.name, input };
          const held = planGate(event);
          if (held !== null) return held.block === true ? { block: held.reason ?? "" } : undefined;
          const gate = createToolCallGate(
            currentMode,
            (request) => runtime.permissions.ask(command.sessionId, request, context),
            command.protectedPaths,
            command.cwd,
          );
          const verdict = await gate(event);
          if (verdict.block === true) return { block: verdict.reason ?? "Tool execution was blocked" };
          return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input as JsonObject };
        },
        afterTool: (_call, result) => unwrapBlocked(result),
      }),
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          await branch.refresh(api, context);
          return { messages: await wire.transform(request.messages, () => branch.entries, context) };
        },
      }),
    ],
  });
  return { extension, toolNames, systemPrompt: segments.map((segment) => segment.text).filter((text) => text !== "").join("\n\n") };
}

/** 模型此前看到的工具清单：会话上下文里 pi.system 条目回放出来的 */
export function previousToolNames(messages: readonly Message[]): string[] {
  return getCurrentTools([...messages]).map((tool) => tool.name);
}

/**
 * 跑一轮：装配 → 装扩展 → 配会话的 agent → 提交这一句 → 等它结局。
 * 模型、思考档、cwd 每轮都随命令写进会话的 agent（与旧内核「每轮显式给，不退全局配置」同一条纪律）。
 */
export async function runTurn(
  command: KernelTurnCommand,
  runtime: KernelTurnRuntime,
  target: KernelTurnTarget,
  compaction: NonNullable<Parameters<Conversation["configure"]>[0]["compaction"]>,
): Promise<{ status: "done" | "unanswered"; reason?: string }> {
  const context = BACKGROUND_CONTEXT;
  const wire = await TurnWire.open(target.conversation, command.attachmentsDir, context);
  const { messages } = await target.conversation.context(context);
  // 本轮轮号（按用户消息计，1 起；与旧内核 echoAndPrompt 同口径：模型上下文里的 user 消息，不数压缩摘要与扩展消息）
  const memoryTurn = liftMessages(messages, new Set()).filter((message) => (message as { role?: unknown }).role === "user").length + 1;
  const assembled = await assembleTurn(command, runtime, target, previousToolNames(messages), wire, memoryTurn);
  target.registry.install(assembled.extension);
  await target.conversation.configure(
    {
      model: { provider: target.model.provider, modelId: target.model.id },
      thinkingLevel: command.thinkingLevel,
      cwd: command.cwd,
      compaction,
      extensions: [assembled.extension],
    },
    context,
  );
  // 用户这一句：正文（粘贴块、文件引用拼进去，与旧内核同一个 composePromptText）+ 附图（同一个缩放）
  const images = await preparePromptImages(command.images);
  await wire.notePromptImages(images, command.attachmentsDir, context);
  // 轮前记忆召回（与旧内核同一个函数）：召回块不拼进原话，首个请求时由 beforeRequest 挂到这一句上
  wire.memory.pending =
    command.sessionMemory === true
      ? await recallMemories(
          runtime.broker,
          command.sessionId,
          command.text,
          memoryTurn,
          { workspaceId: command.workspaceId, cwd: command.cwd },
          !isChildSession(command),
        )
      : null;
  const text = composePromptText(command.text, command.pasted ?? [], command.files ?? []);
  const submission = await target.conversation.submit({ type: "input", content: [{ type: "text", text }, ...forModel(images)] }, context);
  const settled = await submission.wait(context);
  return settled.status === "done" ? { status: "done" } : { status: "unanswered", reason: "reason" in settled ? String(settled.reason) : undefined };
}
