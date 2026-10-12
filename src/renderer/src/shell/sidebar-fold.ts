/**
 * 侧栏分组的状态：折不折叠、超长列表放出来多少条。
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

/** TASKS 默认最多列出的会话数。超出的收进「Show N more」一行，点了全量铺开。 */
export const SESSIONS_PREVIEW_LIMIT = 10;

/**
 * 工作区组展开后默认列几条、每点一次「Show more」再多列几条（2026-10 用户裁决：
 * 5 / 5）。工作区是收纳容器，一点开就铺十几条会把下面的组挤出视野；分批放出来。
 */
export const WORKSPACE_PREVIEW_LIMIT = 5;
export const WORKSPACE_PAGE_SIZE = 5;

/** TASKS 节点的固定 key。 */
export const TASKS_FOLD_KEY = "tasks";

/** 偏离默认折叠态的组的 key 集合。 */
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
  /** 每组点过几次「Show more」（没点过的不在表里）。TASKS 点一次即全量；工作区每次多放 WORKSPACE_PAGE_SIZE 条。 */
  pages: ReadonlyMap<string, number>;
}

/** 一组眼下最多列几条（Infinity = 全量）。 */
export function groupVisibleLimit(state: SidebarGroupState, key: string): number {
  const pages = state.pages.get(key) ?? 0;
  if (key === TASKS_FOLD_KEY) return pages > 0 ? Number.POSITIVE_INFINITY : SESSIONS_PREVIEW_LIMIT;
  return WORKSPACE_PREVIEW_LIMIT + WORKSPACE_PAGE_SIZE * pages;
}

/** 下一次「Show more」会多放出几条：TASKS 一次放完，工作区按页、不超过剩下的。 */
export function nextPageSize(key: string, hidden: number): number {
  return key === TASKS_FOLD_KEY ? hidden : Math.min(WORKSPACE_PAGE_SIZE, hidden);
}

function withoutPages(pages: ReadonlyMap<string, number>, key: string): ReadonlyMap<string, number> {
  if (!pages.has(key)) return pages;
  const next = new Map(pages);
  next.delete(key);
  return next;
}

/** 一组当前是否折叠：默认态被 override 翻转。 */
export function isGroupFolded(state: SidebarGroupState, key: string): boolean {
  return defaultGroupFolded(key) !== state.overrides.has(key);
}

/**
 * 翻转一组的折叠态。结果等于默认态时把 key 从 overrides 里摘掉（归位），
 * 否则记上。**折叠时一并清掉「Show more」放出的页**——折叠是把整组收好，
 * 重开应该回到默认的前 N 条预览；否则折一次再开，长列原样回来，
 * 「折叠」就没有真正归位。unfoldGroup 不清（新建任务走的就是它，不该动组的状态）。
 */
export function toggleGroupFold(state: SidebarGroupState, key: string): SidebarGroupState {
  const targetFolded = !isGroupFolded(state, key);
  const overrides = new Set(state.overrides);
  if (targetFolded === defaultGroupFolded(key)) overrides.delete(key);
  else overrides.add(key);
  if (!targetFolded) return { overrides, pages: state.pages };
  return { overrides, pages: withoutPages(state.pages, key) };
}

/** 只展开一组（不动「Show more」放出的页）——新建任务落进折叠着的组时先展开，不能无声无息。 */
export function unfoldGroup(state: SidebarGroupState, key: string): SidebarGroupState {
  if (!isGroupFolded(state, key)) return state;
  const overrides = new Set(state.overrides);
  // 目标 = 展开：默认折叠的组要靠 override 翻成展开，默认展开的组回到默认就是展开
  if (defaultGroupFolded(key)) overrides.add(key);
  else overrides.delete(key);
  return { overrides, pages: state.pages };
}

/** 「Show more」：这组再多放一页。 */
export function showMoreInGroup(state: SidebarGroupState, key: string): SidebarGroupState {
  const pages = new Map(state.pages);
  pages.set(key, (state.pages.get(key) ?? 0) + 1);
  return { overrides: state.overrides, pages };
}

/**
 * 「Show less」：收回默认预览。排序是置顶优先、按最近更新，
 * 预览的那 N 条就是最近的 N 条（置顶的恒在，不计较先后）。
 */
export function showLessInGroup(state: SidebarGroupState, key: string): SidebarGroupState {
  return { overrides: state.overrides, pages: withoutPages(state.pages, key) };
}
