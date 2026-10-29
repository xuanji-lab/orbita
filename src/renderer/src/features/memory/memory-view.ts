/**
 * 记忆界面（审查面板 › 记忆页签、记忆库页）的数据整形——纯函数，node:test 直接测。
 * 分组顺序、筛选与搜索的口径都在这里定，组件只管画。
 */
import type {
  MemoryEntry,
  MemoryEntryType,
  MemoryEntryView,
  MemorySessionView,
  MemorySource,
} from "../../../../shared/memory.ts";

/**
 * 记忆库里三类的展示顺序：偏好最常被改、最影响下一次怎么做，放最前；
 * 经验次之；事实最多也最稳，放最后。
 */
export const MEMORY_TYPE_ORDER: readonly MemoryEntryType[] = ["preference", "insight", "fact"];

export type MemoryTypeFilter = "all" | MemoryEntryType;
export type MemorySourceFilter = "all" | MemorySource;

export interface MemoryFilter {
  type: MemoryTypeFilter;
  source: MemorySourceFilter;
  /** 搜索词：空白分开的多个词都要命中（大小写不敏感）；空 = 不过滤 */
  query: string;
}

/** 搜索命中的文本面：正文、理由 / 依据、原话、出处会话标题、关键词。 */
function haystackOf(view: MemoryEntryView): string {
  const { entry } = view;
  return [entry.text, entry.reason ?? "", view.quote ?? "", view.sessionTitle ?? "", entry.keywords.join(" ")]
    .join("\n")
    .toLowerCase();
}

/** 按类型、来源、搜索词过滤；顺序保持主进程给的顺序（新在前）。 */
export function filterMemoryEntries(items: readonly MemoryEntryView[], filter: MemoryFilter): MemoryEntryView[] {
  const needles = filter.query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  return items.filter((view) => {
    if (filter.type !== "all" && view.entry.type !== filter.type) return false;
    if (filter.source !== "all" && view.entry.source !== filter.source) return false;
    if (needles.length === 0) return true;
    const haystack = haystackOf(view);
    return needles.every((needle) => haystack.includes(needle));
  });
}

/** 按 MEMORY_TYPE_ORDER 分组；没有条目的类型不出组。 */
export function groupMemoryEntries(
  items: readonly MemoryEntryView[],
): { type: MemoryEntryType; items: MemoryEntryView[] }[] {
  return MEMORY_TYPE_ORDER.map((type) => ({ type, items: items.filter((view) => view.entry.type === type) })).filter(
    (group) => group.items.length > 0,
  );
}

/** 一条记忆现在还会不会被召回：缺席 = active；muted（用户说别再用）与 stale（被新说法取代）都不召回。 */
export function memoryIsActive(entry: MemoryEntry): boolean {
  return entry.status === undefined || entry.status === "active";
}

/** 某一轮的「用到 / 记住」条数（轮尾卡记忆行用）；没有这一轮的账 = null（不出记忆行）。 */
export function memoryTurnCounts(
  view: MemorySessionView | null,
  turn: number,
): { used: number; remembered: number } | null {
  const row = view?.turns.find((item) => item.turn === turn);
  if (row === undefined) return null;
  return { used: row.used.length, remembered: row.remembered.length };
}

/** 审查页签按轮倒序（最新的轮在上）；只列「记住了东西」的轮——页签只管产出，用到的去上下文面板。 */
export function rememberedTurns(view: MemorySessionView | null): MemorySessionView["turns"] {
  if (view === null) return [];
  return [...view.turns].filter((row) => row.remembered.length > 0).sort((a, b) => b.turn - a.turn);
}

/**
 * 召回发生在用户消息落进 pi 本子之前（轮前同步等记忆，最多 4–6 秒），所以账本里
 * 一轮的 `at` 会略早于那条用户消息的时间戳。按时间配对时给这么多余量。
 */
const RECALL_LEAD_MS = 10_000;

/**
 * 对话里每条用户消息对应记忆账本的哪一轮（「记忆 · 用到 N 条」行要挂在哪条气泡下）。
 *
 * **按时间配，不按计数**：一轮归给「时间不晚于它 + 余量」的最后一条用户消息，且不能
 * 越过下一条消息。计数（第 k 条用户消息 = 第 k 轮）只在 renderer 手上是完整历史时才对，
 * 而它常常不是：只加载了最近一页，或会话在后台跑（没打开时收到的实时事件只建出
 * 那几轮）——2026-10-29 实例 memui 实测，后台跑的第 7、8 轮被计数配成第 1、2 轮，
 * 气泡下挂了别的轮的账。账本的 `at` 与消息时间戳相差在一秒内，时间配两种情况都对。
 */
export function pairMemoryTurns(
  users: readonly { id: string; timestamp: number }[],
  view: MemorySessionView | null,
): Map<string, MemorySessionView["turns"][number]> {
  const paired = new Map<string, MemorySessionView["turns"][number]>();
  if (view === null || users.length === 0) return paired;
  const ordered = [...users].sort((a, b) => a.timestamp - b.timestamp);
  for (const row of view.turns) {
    let owner: string | null = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const user = ordered[index]!;
      if (user.timestamp - RECALL_LEAD_MS > row.at) break;
      const next = ordered[index + 1];
      if (next === undefined || next.timestamp - RECALL_LEAD_MS > row.at) owner = user.id;
    }
    // 同一条消息被两轮争（不该发生）时留轮号大的：它更可能是这条消息自己的轮
    const existing = owner === null ? undefined : paired.get(owner);
    if (owner !== null && (existing === undefined || existing.turn < row.turn)) paired.set(owner, row);
  }
  return paired;
}

/** 待确认清单里还没拍板的条数（侧栏「待你确认」角标、记忆库顶部提示条）。 */
export function openPendingCount(items: readonly { resolution?: string }[] | null): number {
  return items === null ? 0 : items.filter((item) => item.resolution === undefined).length;
}

/** 手动添加的校验：正文必填；偏好 / 经验必须写理由（服务侧同样会拒，这里先挡住给出原因）。 */
export function manualDraftProblem(draft: {
  type: MemoryEntryType;
  text: string;
  reason: string;
}): "text" | "reason" | null {
  if (draft.text.trim() === "") return "text";
  if (draft.type !== "fact" && draft.reason.trim() === "") return "reason";
  return null;
}

/**
 * 记忆库页的导航位置（侧栏在记忆库盖层下换成这份导航，与设置页同一种整页形态）：
 * 某个范围的条目（"all" = 全部）、待你确认、向量模型。
 */
export type MemoryNav = { kind: "scope"; token: string } | { kind: "pending" } | { kind: "vector" };
