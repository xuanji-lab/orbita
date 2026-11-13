/**
 * 压缩时，目标与改动账原样保留（2026-10-30）。
 *
 * 为什么需要：压缩把早期对话折成一段摘要，update_goal / update_plan 的调用跟着被折进去——摘要由模型改写，
 * 「用户原话怎么说的、什么时候从什么改成什么、为什么」会被抹平。用户 14:29 要的正是这本账：
 * 「你有记录这个变化的过程和理由，反而对 agent 来说会比较有帮助」。所以压缩之后账要**原样**回到 agent 手里。
 *
 * ## 放哪里（缓存最友好的位置，理由）
 *
 * 否决的位置：
 * - **系统提示词**：必须整会话不变，账一改就打断提示缓存（AGENTS.md 的纪律）；
 * - **每次请求临时拼在尾部**（transformContext 临时块）：Anthropic 的缓存断点打在最后一条用户消息上，临时块
 *   每次都换，上一次写下的缓存条目在下一次请求里不存在；自动前缀缓存的家（DeepSeek / GLM / Kimi）则每次按原价重算临时块。
 *
 * 选定：**压缩摘要消息的末尾，固定附段**（wire-only，在 context 事件里挂上去，pi 本子与 orbita 转录不动）。
 * 压缩本来就让整段前缀失效、要从头 prefill 一遍，附段跟着摘要一起进新前缀，此后每一轮都在前缀里、逐字节相同，
 * 命中缓存；只多出几百 token，且只在下一次压缩（摘要本身要换）时才变。
 *
 * 逐字节稳定靠的是**确定性**：账只读「压缩条目之前」的本子条目（它们不可变），同一份本子推出同一段文字，
 * 不需要另落一条「定格」记录——另落的 custom 条目会排在压缩条目之后，让 pi 的「Already compacted」判断
 * （最后一条是不是压缩条目）失效。再按压缩条目 id 缓存，免得每次请求重扫长本子。
 *
 * 账之后的新改动（压缩之后才发生的 update_goal / update_plan）就在消息流里，不用附。
 *
 * 纯模块：本子条目 → 账本事件的适配 + 挂载；不 import electron，可被 node --test 直接加载。
 */
import { GOAL_TOOL_NAME } from "../shared/goal.ts";
import { buildGoalLedger, renderLedgerForModel, type LedgerEvent } from "../shared/goal-ledger.ts";
import { PLAN_TOOL_NAME } from "../shared/plan.ts";
import type { ContextMessage } from "./image-byte-budget.ts";

interface EntryLike {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown; timestamp?: unknown; toolCallId?: unknown; isError?: unknown };
}

function atOf(entry: EntryLike): number {
  const own = entry.message?.timestamp;
  if (typeof own === "number") return own;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => ((block as { type?: unknown; text?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** pi 本子条目（路径上的 message 条目）→ 账本事件。被拒 / 报错的调用（toolResult.isError）标 failed */
export function ledgerEventsFromEntries(entries: readonly unknown[]): LedgerEvent[] {
  const failedCalls = new Set<string>();
  for (const raw of entries) {
    const entry = raw as EntryLike;
    if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.isError === true) {
      if (typeof entry.message.toolCallId === "string") failedCalls.add(entry.message.toolCallId);
    }
  }
  const events: LedgerEvent[] = [];
  for (const raw of entries) {
    const entry = raw as EntryLike;
    if (entry.type !== "message" || entry.message === undefined) continue;
    const message = entry.message;
    if (message.role === "user") {
      events.push({ kind: "user", id: typeof entry.id === "string" ? entry.id : "", at: atOf(entry), text: userText(message.content) });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }[]) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        if (block.name !== GOAL_TOOL_NAME && block.name !== PLAN_TOOL_NAME) continue;
        events.push({
          kind: "call",
          id: block.id,
          at: atOf(entry),
          tool: block.name,
          input: block.arguments,
          failed: failedCalls.has(block.id),
        });
      }
    }
  }
  return events;
}

/** 路径上最近一条压缩条目的位置；没压缩过 = -1 */
function lastCompactionIndex(branch: readonly unknown[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    if ((branch[i] as EntryLike | undefined)?.type === "compaction") return i;
  }
  return -1;
}

/** 一轮之内的缓存：压缩条目 id → 附段文字（null = 账是空的，不附） */
export type LedgerAttachCache = Map<string, string | null>;

/**
 * context 事件里调用：消息列表里有压缩摘要（role === "compactionSummary"）时，把「压缩条目之前」的账
 * 原样附在摘要后面。没有摘要 / 账是空的 = null（调用方不改消息）。
 */
export function attachGoalLedger(
  messages: readonly ContextMessage[],
  branch: () => readonly unknown[],
  cache: LedgerAttachCache,
  /** 缓存未命中、真算了一次时回调（验收看日志用）；text 为 null = 账是空的 */
  onBuilt?: (text: string | null) => void,
): ContextMessage[] | null {
  const at = messages.findIndex((message) => (message as { role?: unknown }).role === "compactionSummary");
  if (at < 0) return null;
  const entries = branch();
  const index = lastCompactionIndex(entries);
  if (index < 0) return null;
  const compactionId = String((entries[index] as EntryLike).id ?? index);
  let text = cache.get(compactionId);
  if (text === undefined) {
    text = renderLedgerForModel(buildGoalLedger(ledgerEventsFromEntries(entries.slice(0, index))));
    cache.set(compactionId, text);
    onBuilt?.(text);
  }
  if (text === null) return null;
  const summary = messages[at] as unknown as { summary?: unknown };
  if (typeof summary.summary !== "string") return null;
  const next = [...messages];
  next[at] = { ...messages[at], summary: `${summary.summary}\n\n${text}` } as unknown as ContextMessage;
  return next;
}
