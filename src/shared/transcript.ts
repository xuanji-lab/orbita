/**
 * 转录协议类型 —— 从 @earendil-works/pi-protocol 0.84.3 收编的自有契约。
 *
 * 收编原因：pi-protocol 1.x 已改造成 wire 封包 / CBOR 协议库，TranscriptItem /
 * SessionSnapshot / ThinkingLevel 等转录类型全部移除；而 orbita 的内部消息协议
 * 就是块数组转录（AGENTS.md「架构边界」），这批类型由我们自己持有——收编后
 * 全仓不再直接依赖 pi-protocol。
 *
 * 来源：@earendil-works/pi-protocol@0.84.3（MIT License，
 * https://github.com/earendil-works/pi 的 packages/protocol/src/schemas.ts，
 * 对照安装版 dist/schemas.d.ts 逐字段核对）。原包类型经 typebox Static 定义，
 * 这里是结构等价的手写 TS 类型；原 schema 的 minLength / minimum 等数值约束
 * 是运行时校验，不在类型面，故未保留。
 *
 * 只收编 orbita 实际 import 的符号及其类型闭包（消费者纪律）：导出的 9 个符号
 * 各有真实 import 点；构建用的中间类型（内容块联合、Usage、各 status 变体）
 * 留在模块内不导出，需要时再开放。原包的运行时值（CBOR codec、framing、
 * schema 常量、PROTOCOL_VERSION）与协议面类型（SessionMetadata、ServerSnapshot、
 * ModelMetadata、Command / Result / Envelope 家族）无人使用，故意未抄。
 */

/** JSON 值：工具入参与 details 字段的形状（原包 JsonValue）。 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * 思考档词汇表（7 档，off…max），与 pi 同源。
 * 顺序真源与解析在 ./thinking.ts，这里只持类型。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 会话阶段。原包注明「与 AgentHarnessPhase 对齐，适配层不需要第二套词汇表」。 */
export type SessionPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

/** 模型引用：provider + id 两段定位。 */
export type ModelRef = {
  provider: string;
  id: string;
};

// ---- 内容块（消息 content 数组的元素） ----

type TextContent = { type: "text"; text: string };
type ThinkingContent = { type: "thinking"; thinking: string; redacted?: boolean };
/** 图片块：base64 数据 + MIME 类型（prompt-images 等直接消费，故导出）。 */
export type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolCallContent = { type: "toolCall"; toolCallId: string; toolName: string; input: JsonValue };

/** user 消息内容块：文本或图片。 */
type UserContent = TextContent | ImageContent;
/** assistant 消息内容块：文本、思考或工具调用。 */
type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
/** tool 结果内容块：文本或图片。 */
type ToolContent = TextContent | ImageContent;

/** 一轮的用量记账（token 数 + 折算费用）。 */
type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

// ---- 转录条目（一行一个，块数组协议的主体） ----

/** 用户条目。 */
type UserTranscriptItem = {
  id: string;
  role: "user";
  content: UserContent[];
  timestamp: number;
};

/** assistant 条目的公共字段，status 判别在变体上。 */
type AssistantItemBase = {
  id: string;
  role: "assistant";
  content: AssistantContent[];
  model: ModelRef;
  responseModel?: string;
  usage?: Usage;
  timestamp: number;
};
type StreamingAssistantItem = AssistantItemBase & { status: "streaming" };
type CompleteAssistantItem = AssistantItemBase & {
  status: "complete";
  stopReason: "stop" | "length" | "toolUse";
};
type ErrorAssistantItem = AssistantItemBase & { status: "error"; stopReason: "error"; errorMessage?: string };
type AbortedAssistantItem = AssistantItemBase & { status: "aborted"; stopReason: "aborted"; errorMessage?: string };

/** assistant 条目：streaming → complete / error / aborted 四态。 */
export type AssistantTranscriptItem =
  | StreamingAssistantItem
  | CompleteAssistantItem
  | ErrorAssistantItem
  | AbortedAssistantItem;

/** 工具条目的公共字段，status 与 isError 判别在变体上。 */
type ToolItemBase = {
  id: string;
  role: "tool";
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  content: ToolContent[];
  details?: JsonValue;
  usage?: Usage;
  timestamp: number;
};
type RunningToolItem = ToolItemBase & { status: "running"; isError: false };
type CompleteToolItem = ToolItemBase & { status: "complete"; isError: false };
type ErrorToolItem = ToolItemBase & { status: "error"; isError: true };

/** 工具条目：running / complete / error 三态，error 态必带 isError: true。 */
export type ToolTranscriptItem = RunningToolItem | CompleteToolItem | ErrorToolItem;

/** 转录条目：会话 JSONL 一行的 message 形状（块数组协议）。 */
export type TranscriptItem = UserTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;

// ---- 增量进度事件（快照才是权威状态，progress 只是 UI 提示） ----

/**
 * 归一化的增量活动事件。item_finished 只收终态变体（complete / error / aborted
 * 的 assistant 与 complete / error 的 tool），与原包一致。
 */
export type TranscriptProgress =
  | { type: "item_started"; item: TranscriptItem }
  | {
      type: "assistant_delta";
      messageId: string;
      contentIndex: number;
      kind: "text" | "thinking" | "toolCall";
      delta: string;
    }
  | { type: "item_updated"; item: AssistantTranscriptItem | ToolTranscriptItem }
  | {
      type: "item_finished";
      item: CompleteAssistantItem | ErrorAssistantItem | AbortedAssistantItem | CompleteToolItem | ErrorToolItem;
    };

// ---- 会话快照 ----

/** 会话快照：远端协议面的权威状态形状。 */
export type SessionSnapshot = {
  id: string;
  name?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  phase: SessionPhase;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  attached: boolean;
  locked: boolean;
  revision: number;
  transcript: TranscriptItem[];
  queuedSteer: UserTranscriptItem[];
  queuedSteerCount: number;
};
