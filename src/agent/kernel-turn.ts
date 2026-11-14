/**
 * 新内核（pi-durable）跑一轮：把旧内核 openTurn 装配的同一套东西——工具、审批闸门、系统提示——接到 durable 上。
 * 不 import electron，`node --test` 直接测（Harness 用 MemoryStorage、模型用 faux）。
 *
 * 装配方式：每条会话一个 durable 扩展 `orbita-session-<会话 id>`，**每轮按这一轮的开轮命令重建并装上**
 * （registry.install 同名即原地替换），会话的 agent 只选这一个扩展。与旧内核「每轮开一个 AgentSession、
 * 装配全部重来」同一个节奏：中途切档、MCP 重载、挂新目录，下一轮生效。
 *
 * - 工具：内建七件（pi 同一个工厂）+ turn-tools.ts 的同一份清单，经 durable-tools.ts 薄适配；顺序按
 *   旧内核同一套规则：激活顺序（loadoutOrder）定基础提示里的工具小节，发给模型的数组顺序用 pi-ai 同两个函数回放
 *   （offeredOrder）；「此前看到的」取会话自己的 pi.system，刚迁来的会话取迁移时从旧本子带来的那份。
 * - 闸门：`beforeTool` 调**同一个** createToolCallGate（permission.ts）与 createPlanGate；询问档的等待经
 *   awaitWithContext 听 abort（停止时不卡住）。拒绝语经 `afterTool` 还原成旧内核那样的一段原文，
 *   不让 durable 包成 `<harness>[error] Tool call blocked: …</harness>`（参数校验失败、工具不存在同理，见 unwrapHarnessError）。
 * - 系统提示：pi 基础提示（kernel-prompt.ts）→ adaptSystemPrompt → orbitaSystemSegments，每段一个不加标签的
 *   section；durable 把它们按 `\n\n` 拼起来，与 joinSystemPrompt 逐字节相同。
 * - 逐请求注入：`beforeRequest` 跑 kernel-wire.ts（图片预算、目标账、记忆附件、用户情境，与旧内核同一串函数）。
 */
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
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
  type Submission,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelContinueCommand, KernelTurnCommand } from "../shared/kernel.ts";
import type { PermissionAnswer, PermissionMode } from "../shared/permission.ts";
import { composePromptText } from "../shared/prompt-attachments.ts";
import { builtinToolDefinitions, toDurableTool } from "./durable-tools.ts";
import { liftMessages, TurnWire } from "./kernel-wire.ts";
import { loadoutOrder, loadPiResources, offeredOrder } from "./kernel-prompt.ts";
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
  /** 给 bash 子进程挂的环境变量（kernel 进程的孤儿善后标签）；缺席 = 不挂 */
  childEnv?: Readonly<Record<string, string>>;
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

/**
 * 把 durable 自己写的错误结果还原成旧内核（pi-agent-core）的样子：一段原文的错误结果，不带
 * `<harness>[error] …</harness>` 诊断包装。四种：
 * - blocked：闸门的拒绝语（去掉 durable 加的 "Tool call blocked: " 前缀；pi 用 createErrorToolResult(reason)）；
 * - invalid_arguments：参数校验失败（两边都是 pi-ai validateToolArguments 的同一段文字）；
 * - tool_unavailable：模型调了没提供的工具（pi 写 "Tool <name> not found"）。
 * - aborted：被停止——pi-agent-core 对被停调用的通用说法 "Operation aborted"。
 * 被崩溃截断（interrupted / restart_limit）的不改：那是 durable 独有的恢复语义，旧内核没有对位。
 */
const BLOCKED_PREFIX = "Tool call blocked: ";
export function unwrapHarnessError(call: { name: string }, result: ToolExecutionResult): ToolExecutionResult | undefined {
  for (const diagnostic of result.diagnostics ?? []) {
    if (diagnostic.code === "blocked") {
      const reason = diagnostic.message.startsWith(BLOCKED_PREFIX) ? diagnostic.message.slice(BLOCKED_PREFIX.length) : diagnostic.message;
      return { output: [{ type: "text", text: reason }], isError: true };
    }
    if (diagnostic.code === "invalid_arguments") return { output: [{ type: "text", text: diagnostic.message }], isError: true };
    if (diagnostic.code === "tool_unavailable") return { output: [{ type: "text", text: `Tool ${call.name} not found` }], isError: true };
    // 被停止：durable 在工具自己报错之前就结了这次调用，工具那句话（bash 的 "Command aborted"）拿不到；
    // 用 pi-agent-core 对被停调用的通用说法 "Operation aborted"（报告里列为已知差别：措辞不同，形状相同）
    if (diagnostic.code === "aborted") return { output: [{ type: "text", text: "Operation aborted" }], isError: true };
  }
  return undefined;
}

/**
 * 计划闸门的「按调用顺序」包装。旧内核里 pi 在执行前**按调用顺序**逐个过 tool_call 钩子：一批里 update_plan 决定停，
 * 排在它后面的调用被拦、排在它前面的不受影响，下一批（同一轮里模型若还调工具）照样被拦。durable 把一批的工具任务
 * 一起建、并发跑，beforeTool 的先后不保证。所以不靠钩子的先后：每次判定都把这一批里排在本调用之前的调用按顺序
 * 重放一遍**同一个** createPlanGate（它对 update_plan 只改 stopping、不拦；对别的只读 stopping），起点是上一批全部
 * 重放完的状态。重放是确定的：同一批的调用、同一份叶子路径，算出来的 stopping 与旧内核按序判的一致。
 */
export class PlanRoundGate {
  private readonly gate: (event: ToolCallLike) => { block: true; reason: string } | null;
  private readonly state: { stopping: boolean };
  private roundKey: string | undefined;
  private roundStart = false;
  private roundCalls: ToolCallLike[] = [];

  constructor(gate: (event: ToolCallLike) => { block: true; reason: string } | null, state: { stopping: boolean }) {
    this.gate = gate;
    this.state = state;
  }

  check(event: ToolCallLike, branch: readonly unknown[]): { block: true; reason: string } | null {
    const round = findRound(branch, event.toolCallId);
    if (round === null) return this.gate(event);
    if (round.key !== this.roundKey) {
      // 新的一批开始：上一批已全部结束，把它按顺序完整重放一遍得到它结束时的状态，作为这一批的起点
      if (this.roundKey !== undefined) {
        this.state.stopping = this.roundStart;
        for (const call of this.roundCalls) this.gate(call);
      }
      this.roundKey = round.key;
      this.roundStart = this.state.stopping;
      this.roundCalls = round.calls;
    }
    this.state.stopping = this.roundStart;
    for (const call of round.calls) {
      if (call.toolCallId === event.toolCallId) break;
      this.gate(call);
    }
    return this.gate(event);
  }
}

/** 叶子路径里含这个调用的那条 assistant 消息：它的 id 与全部调用（按调用顺序） */
function findRound(branch: readonly unknown[], callId: string): { key: string; calls: ToolCallLike[] } | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { id?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const calls = (entry.message.content as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }[])
      .filter((block) => block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string")
      .map((block) => ({
        toolCallId: block.id as string,
        toolName: block.name as string,
        input: (typeof block.arguments === "object" && block.arguments !== null ? block.arguments : {}) as Record<string, unknown>,
      }));
    if (calls.some((call) => call.toolCallId === callId)) return { key: String(entry.id ?? index), calls };
  }
  return null;
}

/** 一个等着被放行的承诺（ToolRounds 用） */
type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * 一批工具调用的「准备」与「执行」节奏，复刻 pi-agent-core 的 executeToolCalls：
 * - **准备按调用顺序**：pi 逐个跑 tool_execution_start → 参数校验 → tool_call 钩子（闸门、审批、快照跟踪的 before），
 *   一个审批没点完下一个不开始——界面上审批卡一张一张出，快照的 before 读的是这一批谁都还没动手时的盘。
 * - **并行批：全部准备完才一起执行**（executeToolCallsParallel 先 prepare 完整个循环，再 Promise.all 执行）；
 *   顺序批（有 executionMode: sequential 的工具）：准备一个执行一个。
 * durable 把一批的工具任务一起建、并发跑，这些先后它不保证，所以在 beforeTool 与工具的 execute 里各等一下。
 * 「准备完」的信号：beforeTool 判完（放行或拒绝），或调用根本没走到 beforeTool（工具不存在、参数不对——
 * durable 直接写错误结果，视图看到结果条目时报 settled），所以不会有谁永远等不到。
 */
export class ToolRounds {
  private readonly prepared = new Map<string, Gate>();
  private readonly rounds = new Map<string, { calls: string[]; sequential: boolean }>();

  private gateOf(callId: string): Gate {
    let found = this.prepared.get(callId);
    if (found === undefined) {
      found = gate();
      this.prepared.set(callId, found);
    }
    return found;
  }

  /** 记下一批（从叶子路径找到的回答里的全部调用，按调用顺序）；sequential = 这一批按顺序跑 */
  noteRound(calls: readonly string[], sequential: boolean): void {
    for (const callId of calls) this.rounds.set(callId, { calls: [...calls], sequential });
  }

  /** beforeTool 开头：等这一批里排在前面的调用都准备完 */
  async beforePrepare(callId: string, context: Context): Promise<void> {
    const round = this.rounds.get(callId);
    if (round === undefined) return;
    const earlier = round.calls.slice(0, round.calls.indexOf(callId));
    await awaitWithContext(Promise.all(earlier.map((id) => this.gateOf(id).promise)), context);
  }

  /** 准备完（beforeTool 判完 / 调用没走到 beforeTool 就有了结果） */
  settled(callId: string): void {
    this.gateOf(callId).open();
  }

  /** 工具 execute 开头：并行批等整批都准备完 */
  async beforeExecute(callId: string, signal: AbortSignal | undefined): Promise<void> {
    const round = this.rounds.get(callId);
    if (round === undefined || round.sequential) return;
    const all = Promise.all(round.calls.map((id) => this.gateOf(id).promise));
    if (signal === undefined) return all.then(() => undefined);
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      void all.then(() => resolve());
    });
  }
}

/**
 * 一轮里外面要插手的几处（kernel-session.ts 给；测试缺省）：
 * - mode：**现读**的权限档——对话进行中切档，正在跑的这一轮的下一个工具调用立刻按新档判（旧内核读账本，同语义）；
 * - toolStart / toolUpdate：给视图适配层报工具开始（审批之前）与流式输出；
 * - toolAllowed：闸门放行之后（文件快照跟踪记「改之前」，旧内核 tracker.noteAllowed 的同一个时点）；
 * - rounds：一批工具的准备 / 执行节奏（见 ToolRounds）。
 */
export interface TurnObserver {
  mode?: () => PermissionMode;
  toolStart?: (callId: string, name: string, args: unknown) => void;
  toolUpdate?: (callId: string, name: string, partialResult: unknown) => void;
  toolAllowed?: (callId: string, name: string, input: unknown) => Promise<void>;
  rounds?: ToolRounds;
  /** 「继续」要补发一句话时先回显它（与用户自己发的话同一套回显） */
  echoContinue?: (text: string) => void;
}

/** 这一轮装进 durable 的东西（测试直接看它） */
export interface AssembledTurn {
  extension: Extension;
  /** 发给模型的工具名，按发出顺序 */
  toolNames: string[];
  /** 激活顺序（pi 基础提示里工具小节的顺序） */
  activeNames: string[];
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
  previousTools: readonly Tool[],
  wire: TurnWire,
  memoryTurn: number,
  observer: TurnObserver = {},
): Promise<AssembledTurn> {
  const flags = turnToolFlags(command);
  const currentMode = observer.mode ?? (() => command.mode);
  const rounds = observer.rounds ?? new ToolRounds();
  const branch = new DurableBranch();
  const planOptions: PlanToolOptions = {
    getMode: currentMode,
    planFirst: command.planFirst === true,
    branch: () => branch.entries,
    state: { stopping: false },
  };
  const planGate = new PlanRoundGate(createPlanGate(planOptions), planOptions.state);
  // MCP：与旧内核同一个 hub 语义（按工作区分片、ensure 幂等、连不上不拦开轮）
  const mcpScope = command.workspaceId ?? "";
  await runtime.mcpHub.ensure(mcpScope, command.mcpServers, command.workspaceId === null ? "" : command.cwd);
  runtime.send({ type: "mcp", servers: runtime.mcpHub.describe() });
  const mcpTools = runtime.mcpHub.toolsFor(mcpScope);

  const resources = await loadPiResources({ cwd: command.cwd, skillsDirs: command.skillsDirs, resolveShellPath: runtime.resolveShellPath });
  const definitions = [
    ...builtinToolDefinitions(command.cwd, { ...resources.builtinOptions, ...(runtime.childEnv === undefined ? {} : { childEnv: runtime.childEnv }) }),
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
  const activeNames = loadoutOrder(
    previousTools.map((tool) => tool.name),
    definitions.map((definition) => definition.name),
  );
  const scope = {
    cwd: command.cwd,
    autoResizeImages: resources.builtinOptions.autoResizeImages,
    model: () => target.model,
    thinkingLevel: () => command.thinkingLevel,
    providerSessionId: () => target.providerSessionId,
    beforeExecute: (callId: string, signal: AbortSignal | undefined) => rounds.beforeExecute(callId, signal),
    ...(observer.toolUpdate === undefined ? {} : { onUpdate: observer.toolUpdate }),
  };
  const active = activeNames.flatMap((name) => {
    const definition = byName.get(name);
    return definition === undefined ? [] : [toDurableTool(definition, scope)];
  });
  const toolNames = offeredOrder(previousTools, active.map((tool) => toToolDeclaration(tool)));
  const byTool = new Map(active.map((tool) => [tool.name, tool]));
  const tools = toolNames.flatMap((name) => {
    const tool = byTool.get(name);
    return tool === undefined ? [] : [tool];
  });

  const segments = orbitaSystemSegments({
    piBase: adaptSystemPrompt(resources.basePrompt(activeNames, definitions)),
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
          const round = findRound(branch.entries, call.id);
          if (round !== null) {
            rounds.noteRound(
              round.calls.map((each) => each.toolCallId),
              round.calls.some((each) => byTool.get(each.toolName)?.executionMode === "sequential"),
            );
          }
          // 按调用顺序准备（pi 的节奏）：前面的调用判完才轮到这一个；判完（放行 / 拒绝 / 抛错）都要放下一个
          await rounds.beforePrepare(call.id, context);
          try {
            observer.toolStart?.(call.id, call.name, call.arguments);
            // 闸门原地改入参（超时下限、用户在审批里改的参数）：给它一份拷贝，改了就回传新参数
            const input = JSON.parse(JSON.stringify(call.arguments)) as Record<string, unknown>;
            const event: ToolCallLike = { toolCallId: call.id, toolName: call.name, input };
            const held = planGate.check(event, branch.entries);
            if (held !== null) return held.block === true ? { block: held.reason ?? "" } : undefined;
            const toolGate = createToolCallGate(
              currentMode,
              (request) => runtime.permissions.ask(command.sessionId, request, context),
              command.protectedPaths,
              command.cwd,
            );
            const verdict = await toolGate(event);
            if (verdict.block === true) return { block: verdict.reason ?? "Tool execution was blocked" };
            // 放行之后记「改之前」（拒掉的调用不执行，记了是假账）——与旧内核 noteAllowed 同一个时点、同一份入参
            await observer.toolAllowed?.(call.id, call.name, input);
            return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input as JsonObject };
          } finally {
            rounds.settled(call.id);
          }
        },
        afterTool: (call, result) => unwrapHarnessError(call, result),
      }),
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          await branch.refresh(api, context);
          return { messages: await wire.transform(request.messages, () => branch.entries, context) };
        },
      }),
    ],
  });
  return { extension, toolNames, activeNames, systemPrompt: segments.map((segment) => segment.text).filter((text) => text !== "").join("\n\n") };
}

/**
 * 模型此前看到的工具声明：会话上下文里 pi.system 条目回放出来的；这条会话在新内核里还没发过请求（刚迁来）时，
 * 用迁移时从旧本子 system 记录回放出的那份。
 */
export function previousTools(messages: readonly Message[], wire: Pick<TurnWire, "legacyTools">): Tool[] {
  const own = getCurrentTools([...messages]);
  return own.length > 0 ? own : [...wire.legacyTools];
}

/**
 * 一轮里提交之前 / 之后外面要做的事（kernel-session.ts 给；测试缺省）：
 * - observer：见 TurnObserver；
 * - echo：这一句要提交了（附图已缩放）——kernel-session 在这里回显、跑意图闸门；返回 null = 这一轮不提交
 *   （停止 / 闸门取消），返回字符串 = 实际发给模型的正文（意图注入块 + 原话）；
 * - admitted：这一句已被 durable 收下（发 phase turn 用，旧内核的 agent_start）；
 * - continueRun：不加新消息，接着跑上次被中断的那一轮（durable 的 continue）。
 */
export interface TurnHooks {
  observer?: TurnObserver;
  echo?: (images: Awaited<ReturnType<typeof preparePromptImages>>, promptText: string) => Promise<string | null>;
  admitted?: () => void;
  continueRun?: boolean;
}

/** 「继续」落在半截回答上时发给模型、也回显给用户的那句话 */
const CONTINUE_PROMPT = "Continue from where you were interrupted.";

export type TurnOutcome = { status: "done" | "unanswered" | "skipped"; reason?: string };

/**
 * 跑一轮：装配 → 装扩展 → 配会话的 agent → 提交这一句 → 等会话空闲。
 * 模型、思考档、cwd 每轮都随命令写进会话的 agent（与旧内核「每轮显式给，不退全局配置」同一条纪律）。
 *
 * **等到会话空闲，而不是只等这一句的结局**：父会话的插话（steer）在这一轮回答之后才放进来时，durable 用它再开一个 run；
 * 旧内核里 pi 的 agent-loop 在同一次 prompt() 里接着处理它——对界面都是「这一轮还没完」，phase idle 要等它们都结束。
 */
export async function runTurn(
  command: KernelTurnCommand | KernelContinueCommand,
  runtime: KernelTurnRuntime,
  target: KernelTurnTarget,
  compaction: NonNullable<Parameters<Conversation["configure"]>[0]["compaction"]>,
  hooks: TurnHooks = {},
): Promise<TurnOutcome> {
  const context = BACKGROUND_CONTEXT;
  const turnCommand: KernelTurnCommand = command.type === "continueRun" ? { ...command, type: "submit", text: "" } : command;
  const wire = await TurnWire.open(target.conversation, turnCommand.attachmentsDir, context);
  const { messages } = await target.conversation.context(context);
  // 本轮轮号（按用户消息计，1 起；与旧内核 echoAndPrompt 同口径：模型上下文里的 user 消息，不数压缩摘要与扩展消息）
  const memoryTurn = liftMessages(messages, new Set()).filter((message) => (message as { role?: unknown }).role === "user").length + 1;
  const assembled = await assembleTurn(turnCommand, runtime, target, previousTools(messages, wire), wire, memoryTurn, hooks.observer);
  target.registry.install(assembled.extension);
  await target.conversation.configure(
    {
      model: { provider: target.model.provider, modelId: target.model.id },
      thinkingLevel: turnCommand.thinkingLevel,
      cwd: turnCommand.cwd,
      compaction,
      extensions: [assembled.extension],
    },
    context,
  );
  let submission: Submission;
  const last = messages.findLast((message) => message.role !== "system");
  if (command.type === "continueRun" && (last?.role === "user" || last?.role === "toolResult")) {
    // 上下文停在一句没答的话或工具结果上（被打断的工具得到 interrupted 结果）：durable 的 continue 直接接着答
    submission = await target.conversation.submit({ type: "continue" }, context);
  } else if (command.type === "continueRun") {
    // 停在半截回答上（模型说到一半进程没了：durable 把半截留成 aborted 条目，它也在上下文里，continue 会判「没东西可答」）：
    // 发一句明说的「接着说」，回显在转录里——不悄悄替用户补话
    const text = CONTINUE_PROMPT;
    hooks.observer?.echoContinue?.(text);
    submission = await target.conversation.submit({ type: "input", content: [{ type: "text", text }] }, context);
  } else {
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
    const promptText = composePromptText(command.text, command.pasted ?? [], command.files ?? []);
    const text = hooks.echo === undefined ? promptText : await hooks.echo(images, promptText);
    if (text === null) return { status: "skipped" };
    submission = await target.conversation.submit({ type: "input", content: [{ type: "text", text }, ...forModel(images)] }, context);
  }
  hooks.admitted?.();
  const settled = await submission.wait(context);
  await target.conversation.waitForIdle(context);
  return settled.status === "done" ? { status: "done" } : { status: "unanswered", ...("reason" in settled ? { reason: String(settled.reason) } : {}) };
}
