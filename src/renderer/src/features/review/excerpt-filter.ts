/**
 * 审查面板 › 记忆 / 摘抄页签的数据整形（纯函数，node:test 直接测）。
 * 摘抄页签的两档（本会话 / 全部）与关键词过滤都在这里定口径。
 */
import type { MemoryExcerptItem } from "@shared/memory";

export type ExcerptMode = "session" | "all";

/** 态度词表（过滤要按本地化词匹配，组件把文案传进来）。 */
export type StanceWords = Readonly<Record<string, string>>;

/**
 * 摘抄页签的过滤：本会话档只留这条会话摘的；关键词按正文 / 出处标题 / 态度词匹配
 * （大小写不敏感；空搜索 = 全过）。顺序保持主进程给的「新在前」。
 */
export function filterExcerpts(
  items: readonly MemoryExcerptItem[],
  mode: ExcerptMode,
  sessionId: string,
  query: string,
  stanceWords: StanceWords,
): MemoryExcerptItem[] {
  const scoped = mode === "session" ? items.filter((item) => item.entry.sessionId === sessionId) : [...items];
  const needle = query.trim().toLowerCase();
  if (needle === "") return scoped;
  return scoped.filter((item) => {
    const stance = item.entry.stance !== undefined ? stanceWords[item.entry.stance] ?? "" : "";
    const fields = [item.entry.text, item.sessionTitle ?? "", stance];
    return fields.some((field) => field.toLowerCase().includes(needle));
  });
}
