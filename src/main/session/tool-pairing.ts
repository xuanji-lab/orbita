/**
 * 转换类来源（Kimi Code、opencode）共用的收尾：消息按源的顺序排好之后，做配对审计并摘出
 * transcript 需要的旁路信息。纯模块。
 *
 * 配对审计：Anthropic / OpenAI 的接口都要求每个 toolCall 紧跟着它的结果，孤儿任意一侧续聊时都会
 * 被拒。孤儿结果（前面没有对应的 toolCall，或已经被补过占位）丢弃；悬空的 toolCall（被打断、
 * 结果没写出来）在下一条 user / assistant 或末尾之前补一条合成结果，内容说明这是导入时补的。
 * claude-legacy 的配对审计与行的清洗交织在一起，没有并进来。
 */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type ConvertedEntry =
  /** display：这条在 transcript 里的原文；null = 模型读到、用户没写的，不显示 */
  | { kind: "user"; message: UserMessage; display: string | null }
  | { kind: "assistant"; message: AssistantMessage }
  | { kind: "result"; message: ToolResultMessage }
  /** 源应用在这里压缩过上下文：摘要全文、压缩前上下文的 token 数、压缩的时刻 */
  | { kind: "compaction"; summary: string; tokensBefore: number; timestamp: number };

/**
 * 一处压缩在消息序列里的位置：at = 它前面有几条 messages（落 pi 时在第 at 条之前插一条
 * compaction entry）。与 messages 同一次审计产出——审计会补占位、丢孤儿，位置只能在这里定。
 */
export interface ConvertedCompaction {
  at: number;
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface AuditedMessages {
  messages: Message[];
  /** 每条 user 消息的 transcript 原文（按 messages 里 user 消息的顺序） */
  userDisplays: (string | null)[];
  /** 第一句用户写的话（标题兜底） */
  firstPrompt: string | null;
  /** 第一条与最后一条 user / assistant 消息的时间 */
  firstAt: number | null;
  lastAt: number | null;
  orphanToolResults: number;
  patchedToolCalls: number;
  /** 源里的压缩（没有的来源为空数组） */
  compactions: ConvertedCompaction[];
}

/** source 写进合成结果的说明里（「[kimi-code import] …」），排障时认得出是哪一路补的。 */
export function auditToolPairs(entries: readonly ConvertedEntry[], source: string): AuditedMessages {
  const messages: Message[] = [];
  const userDisplays: (string | null)[] = [];
  const pending = new Map<string, string>();
  let orphanToolResults = 0;
  let patchedToolCalls = 0;
  let patchTime = 0;
  const patch = (): void => {
    for (const [toolCallId, toolName] of pending) {
      patchedToolCalls += 1;
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: `[${source} import] 原会话在此处被打断，工具结果缺失，导入时补此占位。` }],
        isError: true,
        timestamp: patchTime,
      });
    }
    pending.clear();
  };
  let firstPrompt: string | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  const compactions: ConvertedCompaction[] = [];
  for (const entry of entries) {
    if (entry.kind === "compaction") {
      // 压缩发生在两轮之间：先把悬着的工具调用收口，压缩前的对话才是完整的
      patch();
      compactions.push({ at: messages.length, summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: entry.timestamp });
      continue;
    }
    if (entry.kind === "result") {
      const name = pending.get(entry.message.toolCallId);
      if (name === undefined) {
        orphanToolResults += 1;
        continue;
      }
      pending.delete(entry.message.toolCallId);
      messages.push({ ...entry.message, toolName: name });
      patchTime = entry.message.timestamp;
      continue;
    }
    patch();
    messages.push(entry.message);
    patchTime = entry.message.timestamp;
    firstAt ??= entry.message.timestamp;
    lastAt = entry.message.timestamp;
    if (entry.kind === "assistant") {
      for (const block of entry.message.content) {
        if (block.type === "toolCall") pending.set(block.id, block.name);
      }
    } else {
      userDisplays.push(entry.display);
      if (firstPrompt === null && entry.display !== null && entry.display.trim() !== "") firstPrompt = entry.display;
    }
  }
  patch();
  return { messages, userDisplays, firstPrompt, firstAt, lastAt, orphanToolResults, patchedToolCalls, compactions };
}
