/**
 * 审查面板 ›「摘抄」页签的数据整形（纯函数，node:test 直接测）。
 * 两档（本会话 / 全部）与关键词过滤的口径都在这里定。
 */
import type { ExcerptItem } from "@shared/excerpt";

export type ExcerptMode = "session" | "all";

/**
 * 本会话档只留这条会话摘的；关键词按正文与出处会话标题匹配（大小写不敏感，
 * 多个词用空白分开时要求每个词都命中；空搜索 = 全过）。顺序保持主进程给的「新在前」。
 */
export function filterExcerpts(
  items: readonly ExcerptItem[],
  mode: ExcerptMode,
  sessionId: string | null,
  query: string,
): ExcerptItem[] {
  const scoped = mode === "session" ? items.filter((item) => item.excerpt.sessionId === sessionId) : [...items];
  const needles = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (needles.length === 0) return scoped;
  return scoped.filter((item) => {
    const haystack = `${item.excerpt.text}\n${item.sessionTitle ?? ""}`.toLowerCase();
    return needles.every((needle) => haystack.includes(needle));
  });
}
