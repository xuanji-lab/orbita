/**
 * 新内核（pi-durable）的工具注册：把璇玑自己的 ToolDefinition（agent-shapes.ts）
 * 包成 durable 的 ToolRegistration。只做形状翻译，工具逻辑一行不碰——实现只有一份（各 `*-tools.ts`
 * 与 pi 的内建工具工厂），旧内核注册是 pi 的 customTools / defaultTools，新内核注册是这里。
 *
 * 翻译要守住的，是「模型看到的东西」与旧内核逐字节相同：
 * - 声明：name / description / parameters（JSON 化，durable 的 toToolDeclaration 也是这么转）/ constrainedSampling 原样；
 * - 结果：content 原样当 output；`isError` 原样；**抛错**按 pi-agent-core 的 createErrorToolResult 折成
 *   「一段文字 = error.message」的错误结果，而不是让 durable 记成 `<harness>[error] …</harness>` 诊断；
 * - 截断：工具自己截（pi 的内建工具都带截断与提示语），durable 不再截第二遍（outputLimits 放到最大）；
 * - 结果里的图：过一道归一化（images.ts 的 normalizeToolResultImages：按模型的图片上限缩放、附坐标换算提示），
 *   旧内核在 agent-session 的 _afterToolCall 里对每个工具结果做同样的一步。
 *
 * - 流式进度：onUpdate 原样交给 scope.onUpdate（视图适配层翻成 tool_execution_update，与旧内核同一个回调）。
 *
 * 不翻的：renderCall / renderResult（TUI 用）。
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { Model, Api } from "@earendil-works/pi-ai";
import { open } from "node:fs/promises";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ToolContext, ToolDefinition } from "./agent-shapes.ts";
import { imageProcessor, normalizeToolResultImages } from "./images.ts";
import { ENABLED_BUILTIN_TOOLS } from "./permission.ts";
import { toolPathArgument, toolTargetPath } from "./tool-paths.ts";

/**
 * 工具执行时要的那几样会话事实（agent-shapes.ts 的 ToolContext）：
 * - cwd：内建工具把相对路径 resolve 到它（`ctx?.cwd || cwd`）；
 * - model：read / read_pdf / read_docx / show_image 判断模型看不看得见图；
 * - thinkingLevel、providerSessionId：bash 给子进程挂 PI_REASONING_LEVEL / PI_SESSION_ID（pi 的约定环境变量）。
 */
export interface DurableToolScope {
  cwd: string;
  /** pi 设置的 images.autoResize（旧内核 _afterToolCall 读同一项） */
  autoResizeImages: boolean;
  model: () => Model<Api> | undefined;
  thinkingLevel: () => string;
  providerSessionId: () => string;
  /** 执行前等一下（一批工具「全部准备完才一起执行」的节奏，kernel-turn.ts 的 ToolRounds） */
  beforeExecute?: (callId: string, signal: AbortSignal | undefined) => Promise<void>;
  /** 工具的流式输出（pi 工具的 onUpdate，partialResult 原样）：界面上 bash 等的实时输出 */
  onUpdate?: (callId: string, toolName: string, partialResult: unknown) => void;
}

/** durable 的输出上限放到最大：截断是工具自己的事，旧内核不截第二遍 */
const NO_LIMIT = { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER } as const;

/**
 * 新内核实际提供给工具的上下文字段。各 `*-tools.ts` 与 pi 内建工具的
 * 执行路径只读这几项（逐一核过：内建工具读 cwd / model / thinkingLevel / sessionManager 的两个 getter，read_pdf /
 * read_docx / show_image 读 model）。会话文件（PI_SESSION_FILE）新内核没有——对话存在 SQLite 里，不给一个过期的 JSONL 路径。
 */
export interface KernelToolContext {
  readonly cwd: ToolContext["cwd"];
  readonly model: ToolContext["model"];
  readonly thinkingLevel: ToolContext["thinkingLevel"];
  readonly sessionManager: {
    getSessionId: ToolContext["sessionManager"]["getSessionId"];
    getSessionFile: () => undefined;
  };
}

/**
 * 只暴露 KernelToolContext 那几项的工具上下文：工具读了别的字段**当场报错**（哪个工具、哪个字段），而不是悄悄拿到
 * undefined 走进另一条分支。类型层已经只给这几项；这里再兜住经 `as` 绕过类型去读别的字段的情形，
 * `then` 与 symbol 键放行（await / 打印会探测它们，不是工具在读字段）。
 */
export function strictToolContext(toolName: string, provided: KernelToolContext): ToolContext {
  const guard = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property === "symbol" || property === "then" || property === "toJSON") return Reflect.get(object, property, receiver);
        if (!(property in object)) {
          throw new Error(`新内核的工具上下文没有提供 ${path}${property}（工具 ${toolName} 读了它）：要么在 durable-tools.ts 的 KernelToolContext 里补上，要么让工具不读它`);
        }
        return Reflect.get(object, property, receiver);
      },
    });
  return guard({ ...provided, sessionManager: guard(provided.sessionManager, "sessionManager.") }, "");
}

function toolContext(toolName: string, scope: DurableToolScope): ToolContext {
  return strictToolContext(toolName, {
    cwd: scope.cwd,
    get model() {
      return scope.model();
    },
    get thinkingLevel() {
      return scope.thinkingLevel() as ToolContext["thinkingLevel"];
    },
    sessionManager: {
      getSessionId: () => scope.providerSessionId(),
      getSessionFile: () => undefined,
    },
  });
}

/** 工具的 details 要进 durable 的库：只留 JSON 能表示的部分（undefined 字段丢掉，与 pi 写 JSONL 时一致） */
function jsonDetails(details: unknown): JsonValue | undefined {
  if (details === undefined) return undefined;
  const text = JSON.stringify(details);
  return text === undefined ? undefined : (JSON.parse(text) as JsonValue);
}

/** 一个 ToolDefinition → durable 的 ToolRegistration（同一个对象的 execute，薄包一层） */
export function toDurableTool(definition: ToolDefinition, scope: DurableToolScope): ToolRegistration {
  const parameters = JSON.parse(JSON.stringify(definition.parameters)) as object;
  const prepare = definition.prepareArguments;
  return {
    name: definition.name,
    description: definition.description,
    parameters,
    ...(definition.constrainedSampling === undefined || definition.constrainedSampling === false
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    ...(prepare === undefined ? {} : { prepareArguments: (args: unknown) => prepare(args) as object }),
    outputLimits: NO_LIMIT,
    async execute(args, api, context): Promise<ToolExecutionResult> {
      try {
        await scope.beforeExecute?.(api.callId, context.abortSignal);
        const onUpdate = scope.onUpdate;
        const result = await definition.execute(
          api.callId,
          args as never,
          context.abortSignal,
          onUpdate === undefined ? undefined : (partial: unknown) => onUpdate(api.callId, definition.name, partial),
          toolContext(definition.name, scope),
        );
        const details = jsonDetails(result.details);
        const resizeOptions = scope.model()?.inputLimits?.images?.resize;
        const content = await normalizeToolResultImages(result.content ?? [], {
          autoResizeImages: scope.autoResizeImages,
          ...(resizeOptions === undefined ? {} : { limits: resizeOptions }),
        });
        return {
          output: content,
          ...(result.isError === true ? { isError: true } : {}),
          ...(details === undefined ? {} : { details }),
        };
      } catch (error) {
        // 被停止时 durable 丢掉这个返回值、改记它自己的 aborted 结果（kernel-turn.ts 的 unwrapHarnessError 再还原成一段原文）
        // pi-agent-core 的 createErrorToolResult 同形：一段原文 + 空的 details
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: {} };
      }
    },
  };
}

/** 内建工具的装配选项：从 pi 的设置读（commandPrefix / shellPath / 图片自动缩放），每轮现读 */
export interface BuiltinToolOptions {
  autoResizeImages: boolean;
  commandPrefix: string | undefined;
  shellPath: string | undefined;
  /** 给 bash 命令打标签（kernel 进程的孤儿善后，kernel-children.ts 的 tagShellCommand）；缺席 = 不打 */
  tagCommand?: (command: string) => string;
  /** 平台（测试注入）：只有 win32 才把 Git Bash / MSYS 的盘符路径折成 Windows 路径 */
  platform?: NodeJS.Platform;
}

/** bash 子进程里留给智能体自己查的会话事实（名字沿用旧内核，用户的技能与验收脚本靠 PI_SESSION_ID 认人） */
const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_PACKAGE_DIR"] as const;

/**
 * bash 子进程的环境：本进程的环境去掉继承来的 PI_*（Orbita 自己可能是被别的智能体拉起来的，那些是别人的会话），
 * 再写上这一轮的 PI_SESSION_ID / PI_PROVIDER / PI_MODEL / PI_REASONING_LEVEL。PI_SESSION_FILE、PI_PACKAGE_DIR 不给：
 * 新内核没有会话 JSONL，pi 的包目录也随旧库删了。
 */
export function bashSessionEnv(base: NodeJS.ProcessEnv, scope: Pick<DurableToolScope, "model" | "thinkingLevel" | "providerSessionId">): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !(SESSION_ENV_KEYS as readonly string[]).includes(key)) env[key] = value;
  }
  env["PI_SESSION_ID"] = scope.providerSessionId();
  const model = scope.model();
  if (model !== undefined) {
    env["PI_PROVIDER"] = model.provider;
    env["PI_MODEL"] = model.id;
  }
  const level = scope.thinkingLevel();
  if (level !== "") env["PI_REASONING_LEVEL"] = level;
  return env;
}

/** 二进制文档读成文本是乱码：read 碰到它们改回一句「用哪个工具读」（PDF 认文件头魔数，Word 按扩展名——PK 是通用 zip 魔数） */
export const PDF_POINTER = "[This is a PDF document. Its binary content cannot be shown as text. Use the read_pdf tool to extract its text layer.]";
export const DOCX_POINTER = "[This is a Word document (.docx). Its binary content cannot be shown as text. Use the read_docx tool to read it as structured markdown.]";
export const DOC_POINTER = "[This is a legacy Word document (.doc). It is not supported directly — save it as .docx first, then use the read_docx tool.]";

export async function binaryDocumentPointer(absolutePath: string): Promise<string | undefined> {
  let head: Buffer;
  try {
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(buffer, 0, 1024, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined; // 不存在 / 是目录 / 读不了：交给 read 工具自己报
  }
  if (head.toString("latin1").includes("%PDF-")) return PDF_POINTER;
  if (/\.docx$/i.test(absolutePath)) return DOCX_POINTER;
  if (/\.doc$/i.test(absolutePath)) return DOC_POINTER;
  return undefined;
}

/** 流式输出给界面的那份尾巴：与旧 bash 的 onUpdate 同量级（最后 2000 行 / 50KB） */
const LIVE_TAIL_BYTES = 50 * 1024;
const LIVE_TAIL_LINES = 2000;

function liveTail(text: string): string {
  let tail = text.length > LIVE_TAIL_BYTES ? text.slice(-LIVE_TAIL_BYTES) : text;
  const lines = tail.split("\n");
  if (lines.length > LIVE_TAIL_LINES) tail = lines.slice(-LIVE_TAIL_LINES).join("\n");
  return tail;
}

/**
 * 新内核自带的工具外面那一层 Orbita 包装：
 * - 执行环境：本轮的 cwd 与 shell（NodeExecutionEnv），经 api.env 交给工具——工具只认 api.env；
 * - 路径：Windows 上把 `/c/…`、`/cygdrive/c/…` 这类 Git Bash 写法折成盘符路径再交给工具（tool-paths.ts，文件账与闸门同一套）；
 * - read 碰到 PDF / Word 改回指路；
 * - 一批工具「全部准备完才一起执行」的节奏（beforeExecute）；
 * - bash 的实时输出交给界面（onUpdate，partialResult 与旧内核同形）。
 */
function wrapBuiltin(tool: ToolRegistration, env: NodeExecutionEnv, scope: DurableToolScope, cwd: string, platform: NodeJS.Platform): ToolRegistration {
  const hasPath = tool.name === "read" || tool.name === "write" || tool.name === "edit";
  return {
    ...tool,
    async execute(args, api, context) {
      await scope.beforeExecute?.(api.callId, context.abortSignal);
      let input = args as Record<string, unknown>;
      if (hasPath && typeof input["path"] === "string") {
        const path = toolPathArgument(input["path"], platform);
        if (path !== input["path"]) input = { ...input, path };
        if (tool.name === "read") {
          const pointer = await binaryDocumentPointer(toolTargetPath(path, cwd, { platform }));
          if (pointer !== undefined) return { output: [{ type: "text", text: pointer }] };
        }
      }
      let streamed = "";
      const onUpdate = scope.onUpdate;
      const wrapped = new Proxy(api, {
        get(target, property) {
          if (property === "env") return env;
          if (property === "output" && onUpdate !== undefined) {
            return (chunk: string | Uint8Array, skipped?: Parameters<typeof target.output>[1]) => {
              streamed = liveTail(streamed + (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)));
              onUpdate(api.callId, tool.name, { content: [{ type: "text", text: streamed }] });
              target.output(chunk, skipped);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
        },
      });
      return tool.execute(input as never, wrapped, context);
    },
  };
}

/**
 * 内建四件（read / write / edit / bash，新内核自带的实现），按 ENABLED_BUILTIN_TOOLS 的顺序。
 * 截断是工具与 durable 自己的事（bash 留尾、read 留头，各 2000 行 / 50KB），不另设上限。
 */
export function builtinTools(cwd: string, options: BuiltinToolOptions, scope: DurableToolScope): ToolRegistration[] {
  const platform = options.platform ?? process.platform;
  const env = new NodeExecutionEnv({ cwd, ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }) });
  const tag = options.tagCommand;
  const all: Record<(typeof ENABLED_BUILTIN_TOOLS)[number], ToolRegistration> = {
    bash: createBashTool({
      ...(options.commandPrefix === undefined || options.commandPrefix === "" ? {} : { commandPrefix: options.commandPrefix }),
      prepare: (execution) => {
        if (tag !== undefined) execution.command = tag(execution.command);
        execution.inheritEnv = false;
        execution.env = bashSessionEnv(process.env, scope);
      },
    }) as unknown as ToolRegistration,
    edit: createEditTool() as unknown as ToolRegistration,
    read: createReadTool(options.autoResizeImages ? { images: imageProcessor } : {}) as unknown as ToolRegistration,
    write: createWriteTool() as unknown as ToolRegistration,
  };
  return ENABLED_BUILTIN_TOOLS.map((name) => wrapBuiltin(all[name], env, scope, cwd, platform));
}
