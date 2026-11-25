/**
 * 对话页的数据归约（纯函数）：尾部的翻页合并、「回一句」的本地排队条。
 */
import type { MobileError, TailEntry } from "../../../src/shared/mobile.ts";

export interface TailState {
  /** 从旧到新 */
  entries: TailEntry[];
  /** 最早那一条之前还有 */
  hasMore: boolean;
  rev: number;
}

/**
 * 拉到最新一页（打开、`tail.changed`、重连之后）：最新一页替换掉旧尾巴；用户已经往上翻过的
 * 更早几页留着——拿最新页的第一条在旧数据里找接缝，接得上就拼，接不上（中间断了一大截）就只留最新页。
 */
export function mergeLatest(current: TailState | null, page: TailState): TailState {
  if (current === null || current.entries.length === 0 || page.entries.length === 0) return page;
  const first = page.entries[0];
  const seam = first === undefined ? -1 : current.entries.findIndex((entry) => entry.id === first.id);
  if (seam <= 0) return page;
  return { entries: [...current.entries.slice(0, seam), ...page.entries], hasMore: current.hasMore, rev: page.rev };
}

/** 往上翻了一页（`before` = 当前第一条）：更早的接在前面，去掉重复 */
export function mergeOlder(current: TailState, page: TailState): TailState {
  const known = new Set(current.entries.map((entry) => entry.id));
  const older = page.entries.filter((entry) => !known.has(entry.id));
  return { entries: [...older, ...current.entries], hasMore: page.hasMore, rev: current.rev };
}

/** 手机上发出去的那句话（直到它确定发出去、或确定没发出去） */
export interface PendingReply {
  requestId: string;
  sessionId: string;
  text: string;
  /** 铸出来的时刻（毫秒） */
  at: number;
  /**
   * sending：等电脑回「排没排上」；queued：在跑，这一轮跑完后发出；
   * sent：已经发出去（不画，留 10 分钟等可能迟到的 `reply.failed`）；failed：没发出去 / 这一轮没跑成
   */
  status: "sending" | "queued" | "sent" | "failed";
  error?: MobileError;
}

/** 发出去的那句留多久等迟到的失败回执（与电脑侧 replyDedupMs 同长） */
export const SENT_KEEP_MS = 10 * 60_000;

export type ReplyEvent =
  | { kind: "accepted"; requestId: string; queued: boolean }
  | { kind: "rejected"; requestId: string; error: MobileError }
  | { kind: "sent"; requestId: string }
  | { kind: "failed"; requestId: string; error: MobileError }
  | { kind: "dismiss"; requestId: string };

/**
 * 回执怎么改排队条：
 * - 电脑说「没排队、直接发了」或 `reply.sent`：这句话马上会出现在转录里，条子收起（记成 sent）；
 * - 「排上了」：灰条留着，写「这一轮跑完后发出」；
 * - 被拒或 `reply.failed`：条子变红，写原因。`reply.failed` 可能在 sent 之后才到——话发出去了、
 *   这一轮没跑成——照样显示（契约要求按到达顺序处理），所以 sent 的不立刻删，留 10 分钟。
 * - 用户点「知道了」：删掉。
 */
export function applyReplyEvent(pending: readonly PendingReply[], event: ReplyEvent, now: number): PendingReply[] {
  const live = pending.filter((item) => item.status !== "sent" || now - item.at < SENT_KEEP_MS);
  const update = (patch: Partial<PendingReply>): PendingReply[] =>
    live.map((item) => (item.requestId === event.requestId ? { ...item, ...patch } : item));
  switch (event.kind) {
    case "accepted":
      return update({ status: event.queued ? "queued" : "sent" });
    case "sent":
      // 已经因为别的原因失败的，不被一条迟到的 sent 盖掉
      return live.map((item) => (item.requestId === event.requestId && item.status !== "failed" ? { ...item, status: "sent" } : item));
    case "dismiss":
      return live.filter((item) => item.requestId !== event.requestId);
    case "rejected":
    case "failed":
      return update({ status: "failed", error: event.error });
  }
}

/** 排队条要画的那几条（sent 不画） */
export function visibleReplies(pending: readonly PendingReply[], sessionId: string): PendingReply[] {
  return pending.filter((item) => item.sessionId === sessionId && item.status !== "sent");
}
