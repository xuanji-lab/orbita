/**
 * 新内核（pi-durable）的工具注册：把旧内核用的**同一批** ToolDefinition（pi-coding-agent 的形状）
 * 包成 durable 的 ToolRegistration。只做形状翻译，工具逻辑一行不碰——实现只有一份（各 `*-tools.ts`
 * 与 pi 的内建工具工厂），旧内核注册是 pi 的 customTools / defaultTools，新内核注册是这里。
 *
 * 翻译要守住的，是「模型看到的东西」与旧内核逐字节相同：
 * - 声明：name / description / parameters（JSON 化，durable 的 toToolDeclaration 也是这么转）/ constrainedSampling 原样；
 * - 结果：content 原样当 output；`isError` 原样；**抛错**按 pi-agent-core 的 createErrorToolResult 折成
 *   「一段文字 = error.message」的错误结果，而不是让 durable 记成 `<harness>[error] …</harness>` 诊断；
 * - 截断：工具自己截（pi 的内建工具都带截断与提示语），durable 不再截第二遍（outputLimits 放到最大）。
 *
 * 不翻的：onUpdate 的流式进度（界面进度是主循环切过来那一步的事）、renderCall / renderResult（TUI 用）。
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { ENABLED_BUILTIN_TOOLS } from "./permission.ts";

/**
 * 工具执行时要的那几样会话事实（旧内核里 pi 经 ExtensionToolContext 给）：
 * - cwd：内建工具把相对路径 resolve 到它（`ctx?.cwd || cwd`）；
 * - model：read / read_pdf / read_docx / show_image 判断模型看不看得见图；
 * - thinkingLevel、providerSessionId：bash 给子进程挂 PI_REASONING_LEVEL / PI_SESSION_ID（pi 的约定环境变量）。
 */
export interface DurableToolScope {
  cwd: string;
  model: () => Model<Api> | undefined;
  thinkingLevel: () => string;
  providerSessionId: () => string;
}

/** durable 的输出上限放到最大：截断是工具自己的事，旧内核不截第二遍 */
const NO_LIMIT = { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER } as const;

/**
 * pi 的 ExtensionToolContext 里工具真读到的那几项。其余字段（UI、会话管理器的写方法……）
 * 工具执行路径上不碰（各 `*-tools.ts` 与 pi 内建工具逐一核过），新内核没有对应物，不造假实现。
 * 会话文件（PI_SESSION_FILE）新内核没有——对话存在 SQLite 里，不给一个已经过期的 JSONL 路径。
 */
function toolContext(scope: DurableToolScope): ExtensionToolContext {
  const partial = {
    cwd: scope.cwd,
    get model() {
      return scope.model();
    },
    get thinkingLevel() {
      return scope.thinkingLevel();
    },
    sessionManager: {
      getSessionId: () => scope.providerSessionId(),
      getSessionFile: () => undefined,
    },
  };
  return partial as unknown as ExtensionToolContext;
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
        const result = await definition.execute(api.callId, args as never, context.abortSignal, undefined, toolContext(scope));
        const details = jsonDetails(result.details);
        return {
          output: result.content,
          ...(result.isError === true ? { isError: true } : {}),
          ...(details === undefined ? {} : { details }),
        };
      } catch (error) {
        // 被停止时把错误交还 durable：它记成 aborted 结果（与 pi 对被停工具的处理同一个语义）
        if (context.abortSignal?.aborted === true) throw error;
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}

/** 内建工具的装配选项：旧内核里 pi 从它的设置读这三项（settingsManager），新内核从同一份设置读 */
export interface BuiltinToolOptions {
  autoResizeImages: boolean;
  commandPrefix: string | undefined;
  shellPath: string | undefined;
}

/**
 * 内建七件，按 ENABLED_BUILTIN_TOOLS 的顺序。工厂与旧内核里 pi 自己建内建工具用的是**同一组**
 * （agent-session 的 _buildRuntime → createAllToolDefinitions，它内部就是逐个调下面这些 create*ToolDefinition，
 * 只给 read 与 bash 传选项），所以实现只有一份；旧内核那一侧的注册是 pi 的 `defaultTools` 设置
 * （runtime.ts 里为什么不传 `tools` 的注释）。createAllToolDefinitions 本身不在 pi 的公开入口里。
 */
export function builtinToolDefinitions(cwd: string, options: BuiltinToolOptions): ToolDefinition[] {
  const all: Record<(typeof ENABLED_BUILTIN_TOOLS)[number], ToolDefinition> = {
    bash: createBashToolDefinition(cwd, { commandPrefix: options.commandPrefix, shellPath: options.shellPath }) as unknown as ToolDefinition,
    edit: createEditToolDefinition(cwd) as unknown as ToolDefinition,
    find: createFindToolDefinition(cwd) as unknown as ToolDefinition,
    grep: createGrepToolDefinition(cwd) as unknown as ToolDefinition,
    ls: createLsToolDefinition(cwd) as unknown as ToolDefinition,
    read: createReadToolDefinition(cwd, { autoResizeImages: options.autoResizeImages }) as unknown as ToolDefinition,
    write: createWriteToolDefinition(cwd) as unknown as ToolDefinition,
  };
  return ENABLED_BUILTIN_TOOLS.map((name) => all[name]);
}
