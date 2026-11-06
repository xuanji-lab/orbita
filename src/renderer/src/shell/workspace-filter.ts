/**
 * 工作区选择条的纯逻辑：选项、默认选中、按工作区分桶。
 * 已归档 / 以后再做 / 能力面板三处共用——三处各写一份，「哪些算任务组、选中的工作区被删了怎么办」
 * 迟早走出分叉。单独成文件只为可测（`node --test` 只加载 .ts）。
 */
import type { Workspace } from "@shared/workspace";

/**
 * 选中的是哪一档：全部 / 不属于任何工作区的「任务」/ 对所有工作区生效的「全局」（只有能力面板有）/ 某个工作区。
 */
export type WsFilter =
  | { kind: "all" }
  | { kind: "tasks" }
  | { kind: "global" }
  | { kind: "workspace"; id: string };

export const FILTER_ALL: WsFilter = { kind: "all" };

/** 这一处的选择条有哪几档可选（全部与各工作区恒有）。 */
export interface WsAllow {
  tasks: boolean;
  global: boolean;
}

export function filterKey(filter: WsFilter): string {
  return filter.kind === "workspace" ? `ws:${filter.id}` : filter.kind;
}

export function sameFilter(a: WsFilter, b: WsFilter): boolean {
  return filterKey(a) === filterKey(b);
}

/** 默认选中：当前会话所在的工作区；没有工作区（Home / 任务 / 工作区已移除）选「全部」。 */
export function defaultFilter(currentWorkspaceId: string | null, workspaces: readonly Workspace[]): WsFilter {
  if (currentWorkspaceId !== null && workspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
    return { kind: "workspace", id: currentWorkspaceId };
  }
  return FILTER_ALL;
}

/**
 * 此刻生效的选择：用户选过的（picked）优先，没选过走默认；选中的工作区已被移除、
 * 或这一处不提供「任务 / 全局」档时退回「全部」——不留一个选了却无处可点的悬空态。
 */
export function resolveFilter(
  picked: WsFilter | undefined,
  fallback: WsFilter,
  workspaces: readonly Workspace[],
  allow: WsAllow,
): WsFilter {
  const filter = picked ?? fallback;
  if (filter.kind === "workspace") return workspaces.some((workspace) => workspace.id === filter.id) ? filter : FILTER_ALL;
  if (filter.kind === "tasks") return allow.tasks ? filter : FILTER_ALL;
  if (filter.kind === "global") return allow.global ? filter : FILTER_ALL;
  return filter;
}

/** 会话 / 事项归到哪个工作区组：`null` = 「任务」组（没有工作区，或归属指向已移除的工作区）。 */
export function workspaceBucket(workspaceId: string | null, workspaces: readonly Workspace[]): string | null {
  return workspaceId !== null && workspaces.some((workspace) => workspace.id === workspaceId) ? workspaceId : null;
}

/** 各桶的条数：每个工作区一格（没有的不在表里），加「任务」。 */
export function bucketCounts<T>(
  items: readonly T[],
  workspaceIdOf: (item: T) => string | null,
  workspaces: readonly Workspace[],
): { perWorkspace: Map<string, number>; tasks: number } {
  const perWorkspace = new Map<string, number>();
  let tasks = 0;
  for (const item of items) {
    const bucket = workspaceBucket(workspaceIdOf(item), workspaces);
    if (bucket === null) tasks += 1;
    else perWorkspace.set(bucket, (perWorkspace.get(bucket) ?? 0) + 1);
  }
  return { perWorkspace, tasks };
}

export interface WsGroup<T> {
  /** null = 「任务」组 */
  workspace: Workspace | null;
  items: T[];
}

/**
 * 按选择条分组：「全部」= 各工作区（侧栏顺序）再接「任务」，空组不出；
 * 选某个工作区 / 任务只剩那一组（可能为空，由调用方画空态）；「全局」档对会话类列表无意义，返回空。
 * 组内顺序保持入参顺序（调用方先排好）。
 */
export function groupByWorkspace<T>(
  items: readonly T[],
  workspaceIdOf: (item: T) => string | null,
  workspaces: readonly Workspace[],
  filter: WsFilter,
): WsGroup<T>[] {
  if (filter.kind === "global") return [];
  const byWorkspace = new Map<string, T[]>();
  const tasks: T[] = [];
  for (const item of items) {
    const bucket = workspaceBucket(workspaceIdOf(item), workspaces);
    if (bucket === null) tasks.push(item);
    else byWorkspace.set(bucket, [...(byWorkspace.get(bucket) ?? []), item]);
  }
  const groups: WsGroup<T>[] = [];
  if (filter.kind !== "tasks") {
    for (const workspace of workspaces) {
      if (filter.kind === "workspace" && filter.id !== workspace.id) continue;
      const list = byWorkspace.get(workspace.id);
      if (list !== undefined) groups.push({ workspace, items: list });
    }
  }
  if ((filter.kind === "all" || filter.kind === "tasks") && tasks.length > 0) groups.push({ workspace: null, items: tasks });
  return groups;
}

export interface WsOption {
  filter: WsFilter;
  count: number;
}

/**
 * 选择条的选项：全部、各工作区（侧栏顺序）、任务、全局。
 * `hideEmpty`：条数为 0 的工作区 / 任务不出（归档、以后再做里一排空胶囊比没有更吵），但选中的那档恒在——
 * 默认选中当前工作区而它恰好没有归档时，用户要看得到自己停在哪。`tasks` / `global` 为 null = 这一处没有这一档。
 */
export function buildOptions(input: {
  workspaces: readonly Workspace[];
  total: number;
  perWorkspace: ReadonlyMap<string, number>;
  tasks: number | null;
  global: number | null;
  selected: WsFilter;
  hideEmpty: boolean;
}): WsOption[] {
  const options: WsOption[] = [{ filter: FILTER_ALL, count: input.total }];
  const keep = (filter: WsFilter, count: number): boolean =>
    !input.hideEmpty || count > 0 || sameFilter(filter, input.selected);
  for (const workspace of input.workspaces) {
    const filter: WsFilter = { kind: "workspace", id: workspace.id };
    const count = input.perWorkspace.get(workspace.id) ?? 0;
    if (keep(filter, count)) options.push({ filter, count });
  }
  if (input.tasks !== null && keep({ kind: "tasks" }, input.tasks)) options.push({ filter: { kind: "tasks" }, count: input.tasks });
  if (input.global !== null) options.push({ filter: { kind: "global" }, count: input.global });
  return options;
}
