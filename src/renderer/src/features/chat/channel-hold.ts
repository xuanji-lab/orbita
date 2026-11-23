/**
 * 子会话回报的「不打岔」——纯函数部分（不碰 React / DOM / 时钟，`now` 由调用方传入）。
 *
 * 背景（2026-11-23 用户）：「我刚刚正在读这个内容，但是子会话不知道我在读，直接打岔进来了。」
 * 以前子会话的 done / failed / progress / question 一到，父会话空闲就立刻开一轮，
 * 正在读的内容被新回答顶开。这里把「要不要现在投给父模型」拆成两个可测的判定：
 *
 * 1. **用户在读 / 在写吗**（`readingReason`）：输入框有未发送的字、对话列没在底部、
 *    最近几秒内有滚动 / 选字 / 键盘输入、窗口不在前台——任一条成立就先攒着。
 * 2. **开关**（`holdOn`，按会话记，**默认开**——2026-11-23 用户：开关给他掌控感，由他决定什么时候讨论）：
 *    开着时 done / failed / progress 一律不自动开轮，只有用户点「现在讨论」才投；question 同样不自动投，
 *    但要给明显的提示（见 summarizeHeld）。关掉以后才轮到第 1 条的读写判定当兜底。
 *
 * 攒着的东西叫 `HeldReport`；投递时合成一条信封（shared/channel.ts 的 composeChannelBatchPrompt）。
 */
import { channelStatus, sortChannelMessages, type ChannelMessage, type ChannelMessageKind } from "../../../../shared/channel.ts";
import type { TranscriptRecord } from "../../../../shared/session.ts";

/**
 * 「静止」的窗口：最后一次滚动 / 选字 / 键盘输入之后过这么久才算读完。
 * 12 秒的取舍：太短（3–5 秒）会在用户停下来想的间隙里把新一轮顶上来；
 * 太长（30 秒以上）用户已经读完、子会话的结果却迟迟不来。正文读到一半、
 * 手停在鼠标上不动的情形输入信号看不见，12 秒大致盖得住一屏的阅读停顿。
 */
export const READING_QUIET_MS = 12_000;

/** 自动投递的复查节拍（只在有攒着的东西时才走） */
export const HOLD_POLL_MS = 1_000;

/** 判定「在读 / 在写」要用的输入信号。全部来自代码里拿得到的事实，不猜意图 */
export interface ReadingSignals {
  /** 窗口在前台（document.hasFocus() 且可见） */
  windowFocused: boolean;
  /** 这条会话的输入框里有未发送的字（trim 后非空 / 有附件由调用方折算） */
  draftNonEmpty: boolean;
  /** 这条会话的对话列此刻正被看着（聊天面挂着它）。没被看着的会话谈不上「在读」 */
  viewed: boolean;
  /** 对话列离开了底部（跟随态 = Reading，往上翻着在读） */
  scrolledUp: boolean;
  /** 最近一次滚动 / 选中文字 / 键盘输入的时刻（ms）；null = 还没有 */
  lastActivityAt: number | null;
}

export type ReadingReason = "draft" | "scrolled-up" | "active" | "background";

/**
 * 用户此刻在读 / 在写吗？是则返回原因（界面要告诉用户「为什么先没打扰」），否则 null。
 * 优先级只影响提示文案：输入框里的字最具体，其次往上翻，其次刚动过，最后才是窗口在后台。
 * - 输入框有字：不论看没看着这条会话都算（草稿按会话存，字在那里就是还没写完）。
 * - 往上翻 / 刚动过：只有这条会话正被看着才算。
 * - 窗口不在前台：用户不在，等他回来再投（回来后的 `active` 静止窗口接着生效）。
 */
export function readingReason(
  signals: ReadingSignals,
  now: number,
  quietMs: number = READING_QUIET_MS,
): ReadingReason | null {
  if (signals.draftNonEmpty) return "draft";
  if (signals.viewed && signals.scrolledUp) return "scrolled-up";
  if (signals.viewed && signals.lastActivityAt !== null && now - signals.lastActivityAt < quietMs) return "active";
  if (!signals.windowFocused) return "background";
  return null;
}

/** 一条攒着的子会话回报。`id` = 通道消息 id（账本铸的，全局唯一，也用来去重） */
export interface HeldReport {
  id: string;
  childId: string;
  childWorkbench: string;
  message: ChannelMessage;
  /**
   * 重启 / 刷新后从磁盘恢复出来的：用户可能早已在别处处理过，不自动投，
   * 只留在提示条里等用户点「现在讨论」。
   */
  recovered: boolean;
}

/**
 * 子会话回报到了，现在该不该先攒着？
 * forced = 用户点过「现在讨论」（或排队条的「立即发送」）——永不攒。
 * holdOn 开着、或用户在读 / 在写，就攒；否则照旧投。所有类别（done / failed / progress / question）
 * 走同一个判定：question 的特殊在提示，不在路由——开关开着它也不能偷偷投给父模型开轮。
 */
export function shouldHold(input: { holdOn: boolean; reading: ReadingReason | null; forced: boolean }): boolean {
  if (input.forced) return false;
  return input.holdOn || input.reading !== null;
}

/**
 * 攒着的要不要自动投了。四个条件同时成立：开关关着、父会话空闲、用户没在读 / 写、
 * 且至少有一条不是「重启恢复出来的」。恢复出来的只能由用户点「现在讨论」投
 * （一打开旧会话就自己开一轮是更大的打岔）。
 */
export function shouldAutoRelease(input: {
  holdOn: boolean;
  phase: "idle" | "turn" | "compaction";
  reading: ReadingReason | null;
  held: readonly HeldReport[];
}): boolean {
  if (input.holdOn || input.phase !== "idle" || input.reading !== null) return false;
  return input.held.some((item) => !item.recovered);
}

/** 入攒：按 id 去重；同一子会话只留最新一条 progress，done / failed / question 全留 */
export function addHeld(held: readonly HeldReport[], item: HeldReport): readonly HeldReport[] {
  if (held.some((entry) => entry.id === item.id)) return held;
  const kept =
    item.message.kind === "progress"
      ? held.filter((entry) => !(entry.childId === item.childId && entry.message.kind === "progress"))
      : held;
  return [...kept, item];
}

/** 出攒：按 id 移出，找不到的原样返回同一引用 */
export function removeHeld(held: readonly HeldReport[], ids: ReadonlySet<string>): readonly HeldReport[] {
  return held.some((entry) => ids.has(entry.id)) ? held.filter((entry) => !ids.has(entry.id)) : held;
}

/**
 * 用户已经直接回答了这个子会话的问题（收件箱代父回复）：同一子会话里比这条回复早的
 * question 就不必再留着——它等的回答已经有了。只动 question；done / failed / progress 照留，
 * 父模型还没看过它们。
 */
export function dropAnsweredQuestions(
  held: readonly HeldReport[],
  childId: string,
  answeredAt: number,
): readonly HeldReport[] {
  const next = held.filter(
    (item) => !(item.childId === childId && item.message.kind === "question" && item.message.createdAt <= answeredAt),
  );
  return next.length === held.length ? held : next;
}

/**
 * 合并投递的顺序：先按子会话（rank 小的在前，通常是派出的先后），同一个子会话里按消息时间。
 * rank 对不认识的子会话返回 Infinity，它们排在最后、彼此按到达先后（sort 稳定）。
 */
export function orderForDelivery(
  held: readonly HeldReport[],
  rank: (childId: string) => number,
): HeldReport[] {
  // 先按子会话分组（组的先后 = 首次到达先后），组内按消息时间，再按 rank 给组排序；
  // 全程稳定排序，rank 相同（含都不认识）的组保持到达先后
  const groups = new Map<string, HeldReport[]>();
  for (const item of held) {
    const list = groups.get(item.childId);
    if (list === undefined) groups.set(item.childId, [item]);
    else list.push(item);
  }
  return [...groups.entries()]
    .map(([childId, list]) => ({ rank: rank(childId), list: [...list].sort((a, b) => a.message.createdAt - b.message.createdAt) }))
    .sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1))
    .flatMap((group) => group.list);
}

/** 界面上 delegate 结果卡的出现顺序：与用户在对话流里看到的委派顺序一致。 */
export function delegateOrderFromTranscript(records: readonly TranscriptRecord[]): readonly string[] {
  const out: string[] = [];
  for (const record of records) {
    if (record.role !== "tool" || record.toolName !== "delegate") continue;
    const details: unknown = record.details;
    if (typeof details !== "object" || details === null) continue;
    const delegate = (details as Record<string, unknown>)["delegate"];
    if (typeof delegate !== "object" || delegate === null) continue;
    const childId = (delegate as Record<string, unknown>)["childId"];
    if (typeof childId === "string" && childId !== "" && !out.includes(childId)) out.push(childId);
  }
  return out;
}

/** 提示条里的一行：每个子会话一行，说它最新的那条 */
export interface HeldRow {
  childId: string;
  /** 这个子会话攒了几条（≥2 时行尾写个数） */
  count: number;
  /** 最新一条的类别，决定图标与说法 */
  kind: ChannelMessageKind;
  /** 一句摘要：最新一条正文的首个非空行，截到 limit */
  summary: string;
}

export interface HeldSummary {
  /** 来自几个子会话（不是几条消息） */
  children: number;
  rows: readonly HeldRow[];
  /** 其中有子会话在等回答：开关开着也要给明显提示 */
  hasQuestion: boolean;
  /** 在等回答的子会话数（红点旁的数字用） */
  questions: number;
}

/** 摘要用的一行：首个非空行，去掉 markdown 标题 / 列表前缀，超长截断 */
export function oneLine(text: string, limit = 80): string {
  const first =
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, "").trim())
      .find((line) => line !== "") ?? "";
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
}

/**
 * 这条 question 是否仍在等回答：与 channelStatus / questionAnswered 同一条语义——
 * 通道仍处 waiting，而且最新一条就是这条 question。后续 done / failed / progress 都让它成为历史。
 */
export function questionIsWaiting(messages: readonly ChannelMessage[], questionId: string): boolean {
  const sorted = sortChannelMessages(messages);
  const latest = sorted[sorted.length - 1];
  return latest?.id === questionId && latest.kind === "question" && channelStatus(sorted) === "waiting";
}

export function summarizeHeld(held: readonly HeldReport[], limit = 80): HeldSummary {
  const byChild = new Map<string, HeldReport[]>();
  for (const item of held) {
    const list = byChild.get(item.childId);
    if (list === undefined) byChild.set(item.childId, [item]);
    else list.push(item);
  }
  const rows: HeldRow[] = [];
  let questions = 0;
  for (const [childId, list] of byChild) {
    const sorted = [...list].sort((a, b) => a.message.createdAt - b.message.createdAt);
    const latest = sorted[sorted.length - 1];
    if (latest === undefined) continue;
    const waiting = latest.message.kind === "question" && questionIsWaiting(sorted.map((entry) => entry.message), latest.id);
    if (waiting) questions += 1;
    rows.push({ childId, count: list.length, kind: latest.message.kind, summary: oneLine(latest.message.text, limit) });
  }
  return { children: rows.length, rows, hasQuestion: questions > 0, questions };
}

/* ───────────── 攒着的落盘（刷新 / 重启后还在） ───────────── */

/**
 * 落盘的只是「谁的哪条」——正文在通道账本里（只追加、已落盘），恢复时按 id 回读，
 * 不在 localStorage 里再存一份正文。入账（到达）时记，投递 / 撤回 / 被回答时抹。
 */
export interface PendingRef {
  childId: string;
  messageId: string;
  childWorkbench: string;
}

export type PendingMap = ReadonlyMap<string, readonly PendingRef[]>;

export function encodePending(pending: PendingMap): string {
  const obj: Record<string, readonly PendingRef[]> = {};
  for (const [parentId, refs] of pending) if (refs.length > 0) obj[parentId] = refs;
  return JSON.stringify(obj);
}

/** 逐条校验；坏条目 / 坏 JSON 跳过，不让一份被手改的存档拖垮启动 */
export function decodePending(raw: string | null): PendingMap {
  const out = new Map<string, PendingRef[]>();
  if (raw === null || raw === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [parentId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    const refs: PendingRef[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const value = entry as Record<string, unknown>;
      const childId = value["childId"];
      const messageId = value["messageId"];
      const workbench = value["childWorkbench"];
      if (typeof childId !== "string" || typeof messageId !== "string") continue;
      refs.push({ childId, messageId, childWorkbench: typeof workbench === "string" ? workbench : "" });
    }
    if (refs.length > 0) out.set(parentId, refs);
  }
  return out;
}
