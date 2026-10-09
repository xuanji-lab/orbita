/**
 * 侧栏分组的状态：折不折叠、超长列表要不要全部铺开。
 *
 * 组的 key 带命名空间——workspace id 是不透明字符串，裸用它当 key，
 * 将来和 TASKS 的固定 key 撞车都不容易被发现。
 *
 * **默认折叠态按组分**：工作区组默认折叠（只留组头，2026-10 用户裁决——
 * 工作区是收纳容器，不该一打开就把会话全铺开），TASKS 默认展开。
 * `overrides` 只记「与默认相反」的组，不记绝对状态——默认折叠的工作区
 * 被点开时在集合里，默认展开的 TASKS 被折起时才在集合里。
 *
 * **不持久化**：这些都是当次浏览的临时安排，与整栏手动折叠（Sidebar 的 collapsed）
 * 同一个立场；会话列表每次启动从盘上重读，落一套 key 反而要处理「组已不存在」的清理。
 */

/** 每组默认最多列出的会话数。超出的收进「Show N more」一行，点了才全量铺开。 */
export const SESSIONS_PREVIEW_LIMIT = 10;

/** TASKS 节点的固定 key。 */
export const TASKS_FOLD_KEY = "tasks";

/** 一组布尔标志的 key 集合（偏离默认折叠态的组 / 全量显示的组共用这个形状）。 */
export type SidebarFolds = ReadonlySet<string>;

/** 工作区组的 key。 */
export function foldKeyForWorkspace(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** 一组的默认折叠态：工作区组默认折叠，TASKS 默认展开。 */
export function defaultGroupFolded(key: string): boolean {
  return key !== TASKS_FOLD_KEY;
}

export interface SidebarGroupState {
  /** 折叠态与默认相反的组（默认折叠的工作区被点开 / 默认展开的 TASKS 被折起）。 */
  overrides: SidebarFolds;
  /** 点过「Show N more」的组：超过预览数也全量列出。 */
  full: SidebarFolds;
}

/** 一组当前是否折叠：默认态被 override 翻转。 */
export function isGroupFolded(state: SidebarGroupState, key: string): boolean {
  return defaultGroupFolded(key) !== state.overrides.has(key);
}

/**
 * 翻转一组的折叠态。结果等于默认态时把 key 从 overrides 里摘掉（归位），
 * 否则记上。**折叠时一并清掉「全部显示」**——折叠是把整组收好，
 * 重开应该回到默认的前 N 条预览；否则折一次再开，全量长列原样回来，
 * 「折叠」就没有真正归位。unfoldGroup 不清（新建任务走的就是它，不该动组的状态）。
 */
export function toggleGroupFold(state: SidebarGroupState, key: string): SidebarGroupState {
  const targetFolded = !isGroupFolded(state, key);
  const overrides = new Set(state.overrides);
  if (targetFolded === defaultGroupFolded(key)) overrides.delete(key);
  else overrides.add(key);
  if (!targetFolded) return { overrides, full: state.full };
  const full = new Set(state.full);
  full.delete(key);
  return { overrides, full };
}

/** 只展开一组（不动「全部显示」）——新建任务落进折叠着的组时先展开，不能无声无息。 */
export function unfoldGroup(state: SidebarGroupState, key: string): SidebarGroupState {
  if (!isGroupFolded(state, key)) return state;
  const overrides = new Set(state.overrides);
  // 目标 = 展开：默认折叠的组要靠 override 翻成展开，默认展开的组回到默认就是展开
  if (defaultGroupFolded(key)) overrides.add(key);
  else overrides.delete(key);
  return { overrides, full: state.full };
}

/**
 * 翻转一组的「全部显示」（Show more ↔ Show less）。
 * 收回时回到默认的前 N 条预览——排序是置顶优先、按最近更新，
 * 预览的那 N 条就是最近的 N 条（置顶的恒在，不计较先后）。
 */
export function toggleGroupFull(state: SidebarGroupState, key: string): SidebarGroupState {
  if (state.full.has(key)) {
    const full = new Set(state.full);
    full.delete(key);
    return { overrides: state.overrides, full };
  }
  return { overrides: state.overrides, full: new Set(state.full).add(key) };
}
