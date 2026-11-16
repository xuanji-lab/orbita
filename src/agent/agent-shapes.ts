/**
 * 璇玑自己的工具与消息形状。
 *
 * 这些形状以前从旧的 agent 库借（它的 ToolDefinition / ExtensionContext / SessionEntry / ContextEvent），
 * 那个库删掉之后由这里给出。只写我们真的读写的字段——工具上下文只有 durable-tools.ts 实际提供的那几项，
 * 工具读了别的字段就是类型错误，而不是运行时拿到 undefined。
 */
import type { Api, AssistantMessage, ConstrainedSamplingConfig, ImageContent, Message, Model, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../shared/transcript.ts";

/** 工具执行时拿得到的会话事实（durable-tools.ts 的 toolContext 给出） */
export interface ToolContext {
  readonly cwd: string;
  /** 这一轮的模型：read_pdf / read_docx / show_image 判断模型看不看得见图 */
  readonly model: Model<Api> | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly sessionManager: {
    getSessionId(): string;
    /** 新的运行时把对话存在 SQLite 里，没有会话 JSONL：恒为 undefined */
    getSessionFile(): string | undefined;
  };
}

/** 工具的返回：content 原样给模型，details 给界面与账本 */
export interface ToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  isError?: boolean;
}

/**
 * 璇玑注册的一个工具。parameters 是 JSON Schema（各工具手写的对象）；
 * execute 用方法语法声明，具体工具可以把 params 标成自己的形状。
 */
export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  /** 系统提示 <tools> 里的一行简介 */
  promptSnippet?: string;
  /** 系统提示 <rules> 里的规则 */
  promptGuidelines?: string[];
  parameters: object;
  constrainedSampling?: false | ConstrainedSamplingConfig;
  executionMode?: "sequential" | "parallel";
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((partialResult: ToolResult) => void) | undefined,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

/** 压缩摘要（旧会话的形状；新内核的压缩摘要在 kernel-wire.ts 的 liftMessages 里还原成它） */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** 分支摘要（同上） */
export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

/** 扩展消息：进上下文、但不是用户打的字（迁移来的旧扩展消息） */
export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
}

/** 请求前那串变换（图片预算、记忆、目标账、用户情境）看到的消息 */
export type ContextMessage = UserMessage | AssistantMessage | ToolResultMessage | Message | CompactionSummaryMessage | BranchSummaryMessage | CustomMessage;

/** 会话本子里的一行：读账函数只看 custom 条目的这三项 */
export interface BookEntry {
  type: string;
  customType?: string;
  data?: unknown;
}
