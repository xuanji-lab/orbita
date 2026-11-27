/**
 * 子会话面板里「已交回 / 已停止」两组的开合，按母会话记住（2026-11-23 用户：「每个 session 的子会话面板的展开和收齐
 * 可以记忆住」）。存 localStorage，一条母会话一份「展开着的组」；上限 200 条，超出丢最早写的。
 * 纯函数部分（读、写、改）可测；读写 localStorage 的两行在 useFoldedGroups 里。
 */
import type { PanelGroup } from "./sub-sessions-rows.ts";

export const SUBSESSION_FOLD_KEY = "orbita.subsessions.unfolded";
export const SUBSESSION_FOLD_LIMIT = 200;

export type FoldBook = Record<string, PanelGroup[]>;

const GROUPS: ReadonlySet<string> = new Set(["attention", "running", "handed", "stopped"]);

/** 盘上那份解析成账本；坏的、形状不对的丢掉，不报错 */
export function parseFoldBook(raw: string | null): FoldBook {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: FoldBook = {};
    for (const [id, groups] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((group): group is PanelGroup => typeof group === "string" && GROUPS.has(group));
      out[id] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** 记下一条母会话展开着的组：放到末尾（最近写的），超出上限丢最早的；空集合也记（= 用户收起过，不回默认） */
export function writeFold(book: FoldBook, parentId: string, unfolded: ReadonlySet<PanelGroup>): FoldBook {
  const next: FoldBook = {};
  for (const [id, groups] of Object.entries(book)) if (id !== parentId) next[id] = groups;
  next[parentId] = [...unfolded];
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - SUBSESSION_FOLD_LIMIT))) delete next[id];
  return next;
}

/** 翻一组的开合 */
export function toggleFold(unfolded: ReadonlySet<PanelGroup>, group: PanelGroup): Set<PanelGroup> {
  const next = new Set(unfolded);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  return next;
}
