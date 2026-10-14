/**
 * 设置 › 记忆库的纯函数层：筛选、搜索、分组、统计。不碰 React、不碰 IPC，
 * `node --test` 直接测（memory-page.test.ts）。
 *
 * 作用域按 token 寻址（MemoryScopeToken）；这一页只管「一个作用域内的条目怎么摆」。
 * 分组、筛选、排序的口径都在这里定死——组件层只做渲染与动作。
 */
import type { MemoryEntry, MemoryLibraryItem } from "@shared/memory";

/** 筛选 chip 的五个档。 */
export type MemoryFilter = "all" | "distilled" | "excerpt" | "conflict" | "stale";

export const MEMORY_FILTERS: readonly MemoryFilter[] = ["all", "distilled", "excerpt", "conflict", "stale"];

/** 待处理的冲突建议（新条目一侧）：判过、没拍板、自己还活着。 */
export function isPendingConflict(entry: MemoryEntry): boolean {
  return (
    entry.supersedes !== undefined &&
    entry.conflictResolution === undefined &&
    (entry.status ?? "active") === "active"
  );
}

/** 90 天没参与过召回（从没注入过、或最近一次注入在 90 天前）。 */
export function isStale(item: MemoryLibraryItem, now: number): boolean {
  const last = item.usage.lastAt ?? item.entry.timestamp;
  return now - last > 90 * 86_400_000;
}

/** 条目落在哪个筛选档（conflict / stale 可与来源档叠加，chip 只看主档）。 */
export function matchesFilter(item: MemoryLibraryItem, filter: MemoryFilter, now: number): boolean {
  if (filter === "all") return true;
  if (filter === "conflict") return isPendingConflict(item.entry);
  if (filter === "stale") return isStale(item, now);
  const source = item.entry.source ?? "distilled";
  if (filter === "excerpt") return source === "excerpt" || source === "manual";
  return source === "distilled";
}

/** 搜索：正文、关键词、出处会话标题、态度文案（态度的本地化词由组件传入）。 */
export function matchesQuery(
  item: MemoryLibraryItem,
  query: string,
  stanceWords: Readonly<Record<string, string>>,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const stance = item.entry.stance !== undefined ? stanceWords[item.entry.stance] ?? "" : "";
  const fields = [item.entry.text, ...item.entry.keywords, item.sessionTitle ?? "", stance];
  return fields.some((field) => field.toLowerCase().includes(needle));
}

export interface LibraryGroup {
  id: "conflicts" | "excerpts" | "distilled";
  items: MemoryLibraryItem[];
}

/**
 * 分组：待处理冲突（新条目 + 被它指着的那条旧条目）→ 我的摘抄（excerpt / manual）→
 * 自动蒸馏。其余状态（已替代 / 不再注入）留在原组里，由行上的标签交代。
 * 组内按「最近使用」（最近一次注入，没用过按创建时刻）降序。
 */
export function libraryGroups(
  items: readonly MemoryLibraryItem[],
  now: number,
): { groups: LibraryGroup[]; pendingOldIds: Set<string> } {
  const pendingOldIds = new Set(
    items.filter((item) => isPendingConflict(item.entry)).map((item) => item.entry.supersedes as string),
  );
  const byUse = (a: MemoryLibraryItem, b: MemoryLibraryItem): number =>
    (b.usage.lastAt ?? b.entry.timestamp) - (a.usage.lastAt ?? a.entry.timestamp);
  const conflicts = items
    .filter((item) => isPendingConflict(item.entry) || pendingOldIds.has(item.entry.id))
    .sort(byUse);
  const excerpts = items
    .filter((item) => {
      const source = item.entry.source ?? "distilled";
      return source !== "distilled" && !conflicts.includes(item);
    })
    .sort(byUse);
  const distilled = items
    .filter((item) => (item.entry.source ?? "distilled") === "distilled" && !conflicts.includes(item))
    .sort(byUse);
  const groups: LibraryGroup[] = [];
  if (conflicts.length > 0) groups.push({ id: "conflicts", items: conflicts });
  if (excerpts.length > 0) groups.push({ id: "excerpts", items: excerpts });
  if (distilled.length > 0) groups.push({ id: "distilled", items: distilled });
  return { groups, pendingOldIds };
}

/** 头部统计：总数 · 本周新增 · 待处理冲突。 */
export function libraryStats(items: readonly MemoryLibraryItem[], now: number): {
  total: number;
  week: number;
  conflicts: number;
} {
  const weekAgo = now - 7 * 86_400_000;
  return {
    total: items.length,
    week: items.filter((item) => item.entry.timestamp >= weekAgo).length,
    conflicts: items.filter((item) => isPendingConflict(item.entry)).length,
  };
}
