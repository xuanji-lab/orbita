/**
 * 侧栏任务行的多选（批量迁移用）。纯函数，侧栏只负责把点击翻译成这里的输入。
 *
 * 手势与 Finder / VS Code 资源管理器同一套：
 *   - 普通点击：清空多选、打开这条（anchor 落在它身上，作为下一次 Shift 的起点）
 *   - Shift + 点击：从 anchor 到这条的**可见顺序**区间，整段替换当前多选；不打开
 *   - Cmd / Ctrl + 点击：把这条加进 / 移出多选；不打开
 * 第一次 Shift / Cmd 时还没有 anchor，就以「正打开的那条」为起点——用户眼里它就是
 * 当前选中的那一行。区间按可见顺序算：折叠的组、Show more 后面藏着的不进区间。
 */

export interface SidebarSelection {
  ids: ReadonlySet<string>;
  /** Shift 区间的起点；null = 还没点过 */
  anchor: string | null;
}

export const EMPTY_SELECTION: SidebarSelection = { ids: new Set(), anchor: null };

export type RowClickKind = "plain" | "range" | "toggle";

export function rowClickKind(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): RowClickKind {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "plain";
}

/**
 * 一次点击之后的多选状态。open = 这次点击要不要打开那条会话（只有普通点击打开）。
 * visible = 侧栏当前从上到下可见的任务行 id；openId = 正打开的那条（可能为 null）。
 */
export function nextSelection(
  current: SidebarSelection,
  kind: RowClickKind,
  id: string,
  visible: readonly string[],
  openId: string | null,
): { selection: SidebarSelection; open: boolean } {
  if (kind === "plain") return { selection: { ids: new Set(), anchor: id }, open: true };
  const anchor = current.anchor ?? (openId !== null && visible.includes(openId) ? openId : null);
  if (kind === "range") {
    const from = anchor === null ? -1 : visible.indexOf(anchor);
    const to = visible.indexOf(id);
    // 起点不可见了（折起来 / 被筛掉）或点的这条不在可见序里：退化成只选这一条
    if (from < 0 || to < 0) return { selection: { ids: new Set([id]), anchor: id }, open: false };
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    // 区间替换而不是累加：Shift 再点一次是「改区间的终点」，起点不动
    return { selection: { ids: new Set(visible.slice(lo, hi + 1)), anchor }, open: false };
  }
  // toggle：第一次 Cmd 点时把「正打开的那条」也带上——它本来就是选中的样子
  const ids = new Set(current.ids);
  if (ids.size === 0 && anchor !== null) ids.add(anchor);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { selection: { ids, anchor: id }, open: false };
}

/**
 * 勾选态（工作区「迁移任务…」进入的）里点一行：只切这一条。不像 Cmd 那样把正打开的
 * 那条带上——勾选态的意思是「从这一组里挑」，打开着的会话不一定在这一组。
 */
export function toggleOne(current: SidebarSelection, id: string): SidebarSelection {
  const ids = new Set(current.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/** 多选里还在可见列表上的那些（迁走 / 删掉 / 被筛掉的不该留在批量动作的目标里），按可见顺序。 */
export function selectedInOrder(selection: SidebarSelection, visible: readonly string[]): string[] {
  return visible.filter((id) => selection.ids.has(id));
}
