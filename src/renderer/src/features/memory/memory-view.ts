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
