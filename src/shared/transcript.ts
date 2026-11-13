/**
 * 转录协议类型 —— 从 @earendil-works/pi-protocol 0.84.3 收编的自有契约。
 *
 * 收编原因：pi-protocol 1.x 已改造成 wire 封包 / CBOR 协议库，TranscriptItem /
 * SessionSnapshot / ThinkingLevel 等转录类型全部移除；而 orbita 的内部消息协议
 * 就是块数组转录（AGENTS.md「架构边界」），这批类型由我们自己持有——收编后
 * 全仓不再直接依赖 pi-protocol。
 *
 * 来源与版权（MIT License）：
 * Copyright (c) 2025 Mario Zechner
 * 源自 https://github.com/earendil-works/pi 的 packages/protocol/src/schemas.ts
 * （@earendil-works/pi-protocol@0.84.3，逐字段对照安装版 dist/schemas.d.ts）。
 * 原包类型经 typebox Static 定义，这里是结构等价的手写 TS 类型；typebox 的
 * Static 是 homomorphic 映射，schema 属性上的 readonly 传到了类型面——因此
 * 本文件所有对象字段带 readonly（转录条目一律不可原地改写），数组保持可变
 * 数组和原包一致。原 schema 的 minLength / minimum 等数值约束是运行时校验，
 * 不在类型面，故未保留。
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
  readonly provider: string;
  readonly id: string;
};

// ---- 内容块（消息 content 数组的元素） ----

type TextContent = { readonly type: "text"; readonly text: string };
type ThinkingContent = { readonly type: "thinking"; readonly thinking: string; readonly redacted?: boolean };
/** 图片块：base64 数据 + MIME 类型（prompt-images 等直接消费，故导出）。 */
export type ImageContent = { readonly type: "image"; readonly data: string; readonly mimeType: string };
type ToolCallContent = {
  readonly type: "toolCall";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonValue;
};

/** user 消息内容块：文本或图片。 */
type UserContent = TextContent | ImageContent;
/** assistant 消息内容块：文本、思考或工具调用。 */
type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
/** tool 结果内容块：文本或图片。 */
type ToolContent = TextContent | ImageContent;

/** 一轮的用量记账（token 数 + 折算费用）。 */
type Usage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
};

// ---- 转录条目（一行一个，块数组协议的主体） ----

/** 用户条目。 */
type UserTranscriptItem = {
  readonly id: string;
  readonly role: "user";
  readonly content: UserContent[];
  readonly timestamp: number;
};

/** assistant 条目的公共字段，status 判别在变体上。 */
type AssistantItemBase = {
  readonly id: string;
  readonly role: "assistant";
  readonly content: AssistantContent[];
  readonly model: ModelRef;
  readonly responseModel?: string;
  readonly usage?: Usage;
  readonly timestamp: number;
};
type StreamingAssistantItem = AssistantItemBase & { readonly status: "streaming" };
type CompleteAssistantItem = AssistantItemBase & {
  readonly status: "complete";
  readonly stopReason: "stop" | "length" | "toolUse";
};
type ErrorAssistantItem = AssistantItemBase & { readonly status: "error"; readonly stopReason: "error"; readonly errorMessage?: string };
type AbortedAssistantItem = AssistantItemBase & { readonly status: "aborted"; readonly stopReason: "aborted"; readonly errorMessage?: string };

/** assistant 条目：streaming → complete / error / aborted 四态。 */
export type AssistantTranscriptItem =
  | StreamingAssistantItem
  | CompleteAssistantItem
  | ErrorAssistantItem
  | AbortedAssistantItem;

/** 工具条目的公共字段，status 与 isError 判别在变体上。 */
type ToolItemBase = {
  readonly id: string;
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly content: ToolContent[];
  readonly details?: JsonValue;
  readonly usage?: Usage;
  readonly timestamp: number;
};
type RunningToolItem = ToolItemBase & { readonly status: "running"; readonly isError: false };
type CompleteToolItem = ToolItemBase & { readonly status: "complete"; readonly isError: false };
type ErrorToolItem = ToolItemBase & { readonly status: "error"; readonly isError: true };

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
  | { readonly type: "item_started"; readonly item: TranscriptItem }
  | {
      readonly type: "assistant_delta";
      readonly messageId: string;
      readonly contentIndex: number;
      readonly kind: "text" | "thinking" | "toolCall";
      readonly delta: string;
    }
  | { readonly type: "item_updated"; readonly item: AssistantTranscriptItem | ToolTranscriptItem }
  | {
      readonly type: "item_finished";
      readonly item: CompleteAssistantItem | ErrorAssistantItem | AbortedAssistantItem | CompleteToolItem | ErrorToolItem;
    };

// ---- 会话快照 ----

/** 会话快照：远端协议面的权威状态形状。 */
export type SessionSnapshot = {
  readonly id: string;
  readonly name?: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly phase: SessionPhase;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel;
  readonly attached: boolean;
  readonly locked: boolean;
  readonly revision: number;
  readonly transcript: TranscriptItem[];
  readonly queuedSteer: UserTranscriptItem[];
  readonly queuedSteerCount: number;
};
