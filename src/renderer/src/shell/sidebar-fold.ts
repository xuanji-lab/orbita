/**
 * 侧栏分组的状态：折不折叠、超长列表要不要全部铺开。
 *
 * 组的 key 带命名空间——workspace id 是不透明字符串，裸用它当 key，
 * 将来和 TASKS 的固定 key 撞车都不容易被发现。
 *
 * **不持久化**：这些都是当次浏览的临时安排，与整栏手动折叠（Sidebar 的 collapsed）
 * 同一个立场；会话列表每次启动从盘上重读，落一套 key 反而要处理「组已不存在」的清理。
 */

/** 每组默认最多列出的会话数。超出的收进「Show N more」一行，点了才全量铺开。 */
export const SESSIONS_PREVIEW_LIMIT = 10;

/** TASKS 节点的固定 key。 */
export const TASKS_FOLD_KEY = "tasks";

/** 一组布尔标志的 key 集合（折叠中的组 / 全量显示的组共用这个形状）。 */
export type SidebarFolds = ReadonlySet<string>;

/** 工作区组的 key。 */
export function foldKeyForWorkspace(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export interface SidebarGroupState {
  /** 折叠中的组：会话行整个不渲染，只剩组头。 */
  folds: SidebarFolds;
  /** 点过「Show N more」的组：超过预览数也全量列出。 */
  full: SidebarFolds;
}

/**
 * 翻转一组的折叠态。**折叠时一并清掉「全部显示」**——折叠是把整组收好，
 * 重开应该回到默认的前 N 条预览；否则折一次再开，全量长列原样回来，
 * 「折叠」就没有真正归位。unfoldGroup 不清（新建任务走的就是它，不该动组的状态）。
 */
export function toggleGroupFold(state: SidebarGroupState, key: string): SidebarGroupState {
  if (state.folds.has(key)) {
    const folds = new Set(state.folds);
    folds.delete(key);
    return { folds, full: state.full };
  }
  const full = new Set(state.full);
  full.delete(key);
  return { folds: new Set(state.folds).add(key), full };
}

/** 只展开一组（不动「全部显示」）——新建任务落进折叠着的组时先展开，不能无声无息。 */
export function unfoldGroup(state: SidebarGroupState, key: string): SidebarGroupState {
  if (!state.folds.has(key)) return state;
  const folds = new Set(state.folds);
  folds.delete(key);
  return { folds, full: state.full };
}

/**
 * 标记一组「全部显示」（Show N more）。**单向**——几十条列表想收回预览，
 * 折叠再展开就回去了，不为此多发一个反向按钮。
 */
export function expandGroup(state: SidebarGroupState, key: string): SidebarGroupState {
  if (state.full.has(key)) return state;
  return { folds: state.folds, full: new Set(state.full).add(key) };
}
