/**
 * transcript-adapter —— 把 pi 的 AgentSession 事件流翻成 pi-protocol 的 transcript 协议。
 *
 * 这是整条链路唯一有实质翻译工作的地方（docs/single-agent-guideline.md §三）。
 * 上游给的是 `AgentSessionEvent`（含整条 AssistantMessage 与流式增量），
 * 下游要的是 `TranscriptProgress`（item_started / assistant_delta / item_updated / item_finished），
 * 渲染层用 pi 自带的 `transcript.ts` 归约器消费它——**归约器不是我们写的，也不该我们写**。
 *
 * 为什么要翻：pi-ai 的 Message 没有 id、没有时间戳、没有「流式中/已完成」状态，
 * 而 protocol 的 TranscriptItem 三样都要。id 由本模块铸造并在一条消息的
 * start → update* → end 全程保持不变。
 *
 * 纯模块：不 import electron、不 import 进程相关的东西，可被 `node --test` 直接加载。
 */
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type {
  AssistantContent,
  ModelRef,
  TranscriptItem,
  TranscriptProgress,
  UserContent,
} from "@earendil-works/pi-protocol";

/** 铸 id 的能力注入进来：测试要可预测的 id，生产用 randomUUID。 */
export interface AdapterDeps {
  newId(): string;
  now(): number;
}

/** 本模块只消费这些事件；其余 AgentSessionEvent 一律忽略（返回空数组）。 */
export type AdaptableEvent =
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: Message; assistantMessageEvent: AssistantStreamEvent }
  | { type: "message_end"; message: Message };

/** pi-ai AssistantMessageEvent 里我们用得上的分支。 */
export type AssistantStreamEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: string; contentIndex?: number };

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

/** pi-ai 的内容块 → protocol 的内容块。字段名不同的只有 toolCall。 */
function toAssistantContent(block: TextContent | ThinkingContent | ToolCall): AssistantContent {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") {
    return block.redacted === undefined
      ? { type: "thinking", thinking: block.thinking }
      : { type: "thinking", thinking: block.thinking, redacted: block.redacted };
  }
  // pi-ai: {id, name, arguments} → protocol: {toolCallId, toolName, input}
  return {
    type: "toolCall",
    toolCallId: block.id,
    toolName: block.name,
    input: block.arguments as AssistantContent extends { input: infer I } ? I : never,
  };
}

function toModelRef(message: AssistantMessage): ModelRef {
  return { provider: message.provider, id: message.model };
}

/**
 * AgentSession 的事件流 → TranscriptProgress 流。
 *
 * 一条 assistant 消息的 id 在 message_start 时铸造，直到 message_end 都不变——
 * 这是增量帧（assistant_delta 带 messageId）能被归约器对上号的前提。
 */
export class TranscriptAdapter {
  private readonly deps: AdapterDeps;
  /** 当前正在流式的 assistant 消息 id；不在流式中时为 null。 */
  private activeAssistantId: string | null = null;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  /** 用户提交的 prompt：本地立刻造一条 user item，不等模型回。 */
  userPrompt(text: string): TranscriptProgress[] {
    const content: UserContent[] = [{ type: "text", text }];
    const item: TranscriptItem = {
      id: this.deps.newId(),
      role: "user",
      content,
      timestamp: this.deps.now(),
    };
    return [{ type: "item_started", item }];
  }

  /** 主转换。返回 0..n 条 progress——调用方按序发出去即可。 */
  apply(event: AdaptableEvent): TranscriptProgress[] {
    if (event.type === "message_start") {
      if (!isAssistant(event.message)) return [];
      const id = this.deps.newId();
      this.activeAssistantId = id;
      return [{ type: "item_started", item: this.assistantItem(id, event.message, "streaming") }];
    }

    if (event.type === "message_update") {
      const id = this.activeAssistantId;
      if (id === null || !isAssistant(event.message)) return [];
      const delta = this.toDelta(id, event.assistantMessageEvent);
      // 非增量帧（text_start / text_end / start 等）：整条重发一次，让归约器与上游对齐。
      // 这些帧稀疏，代价可以接受；而漏掉它们会让「块刚出现」这类结构变化丢失。
      return delta ?? [{ type: "item_updated", item: this.assistantItem(id, event.message, "streaming") }];
    }

    // message_end：终态帧，status 从 streaming 翻成 complete
    const id = this.activeAssistantId;
    if (id === null || !isAssistant(event.message)) return [];
    this.activeAssistantId = null;
    return [{ type: "item_finished", item: this.assistantItem(id, event.message, "complete") }];
  }

  /** 流式增量 → assistant_delta。不是增量帧就返回 null，由调用方走整条重发。 */
  private toDelta(messageId: string, event: AssistantStreamEvent): TranscriptProgress[] | null {
    const kind =
      event.type === "text_delta"
        ? "text"
        : event.type === "thinking_delta"
          ? "thinking"
          : event.type === "toolcall_delta"
            ? "toolCall"
            : null;
    if (kind === null) return null;
    const withDelta = event as { contentIndex?: number; delta?: string };
    if (typeof withDelta.contentIndex !== "number" || typeof withDelta.delta !== "string") return null;
    return [
      {
        type: "assistant_delta",
        messageId,
        contentIndex: withDelta.contentIndex,
        kind,
        delta: withDelta.delta,
      },
    ];
  }

  private assistantItem(
    id: string,
    message: AssistantMessage,
    status: "streaming" | "complete",
  ): TranscriptItem {
    return {
      id,
      role: "assistant",
      content: message.content.map(toAssistantContent),
      model: toModelRef(message),
      timestamp: this.deps.now(),
      status,
    };
  }
}
