/**
 * 侧栏分组的折叠状态。
 *
 * 折的是「一组会话」：每个工作区组一组，TASKS 节点一组。key 带命名空间——
 * workspace id 是不透明字符串，裸用它当 key，将来和 TASKS 的固定 key 撞车都不容易被发现。
 *
 * **不持久化**：折叠是当次浏览的临时安排，与整栏手动折叠（Sidebar 的 collapsed）同一个
 * 立场；会话列表每次启动从盘上重读，落一套 key 反而要处理「组已不存在」的清理。
 */

/** TASKS 节点的固定折叠 key。 */
export const TASKS_FOLD_KEY = "tasks";

/** 折叠中的分组 key 集合。不在集合里 = 展开。 */
export type SidebarFolds = ReadonlySet<string>;

/** 工作区组的折叠 key。 */
export function foldKeyForWorkspace(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** 翻转一组的折叠态。返回新集合——原集合不动，React 靠新引用才知道要重渲染。 */
export function toggleFold(folds: SidebarFolds, key: string): SidebarFolds {
  const next = new Set(folds);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * 展开一组（幂等）。新建任务落进折叠着的组时必须先展开——
 * 会话不能无声无息地消失在一个收起的组里。
 * 没折过的组原集合原样返回（同一引用，省一次无谓的重渲染）。
 */
export function unfold(folds: SidebarFolds, key: string): SidebarFolds {
  if (!folds.has(key)) return folds;
  const next = new Set(folds);
  next.delete(key);
  return next;
}
