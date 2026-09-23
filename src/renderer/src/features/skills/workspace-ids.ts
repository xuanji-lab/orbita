import type { Workspace } from "@shared/workspace";

/**
 * 判断两份工作区列表的 **id 集合**是否相同——顺序无关，`name` / `path` 等
 * 其它字段的变化也不算数（改名、换路径不影响 skill 的 link 目标集合）。
 *
 * `useSkills.ts` 用它判断「侧栏那份工作区列表变没变」，只有真正的增删才
 * 触发 skill 列表重读。纯函数：不 import React，可被 `node --test` 直接加载
 * （同 `skill-filter.ts` 的先例）。
 */
export function sameWorkspaceIds(a: readonly Workspace[], b: readonly Workspace[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((w) => w.id));
  return b.every((w) => ids.has(w.id));
}
