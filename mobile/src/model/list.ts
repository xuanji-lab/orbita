/**
 * 任务清单的分组与归约（纯函数，清单屏只管画）。规则照用户认可的设计稿（proto/mobile-look）：
 *
 * - 顶上四组：等你 → 在跑 → 跑完没看 → 出错，各有上限，超出的折成「还有 N 件」就地展开。
 *   出错排最后：天天出错的夜间回归这类任务看过一次就离组，没看也只占最后一组。
 * - 小屏（屏高 < 800）上限收紧：首屏放不下四组（设计稿 360×780 的图），等你 3、其余各 2。
 * - 「工作区」组：按最近一次活动排（不按名字），默认收起；展开后**顶上露过的不重复**，折成一行
 *   「另有 N 件在上面」，名额留给按最近活动排的空闲任务，其余是「更早的 N 条」（点了再露一页）。
 * - 「任务」组（不属于任何工作区的）与「工作区」并列，规则同上。
 * - 打开过的「跑完没看 / 出错」：选中时只清掉饼、行不动（不在手指下跳走），返回清单或切到
 *   别的任务后才离组。
 */
import type { MobileSessionState, SessionSummary } from "../../../src/shared/mobile.ts";

export const GROUP_ORDER = ["waiting", "running", "done", "failed"] as const;
export type GroupId = (typeof GROUP_ORDER)[number];

export const GROUP_CAPS: Readonly<Record<GroupId, number>> = { waiting: 4, running: 3, done: 3, failed: 3 };
export const GROUP_CAPS_SMALL: Readonly<Record<GroupId, number>> = { waiting: 3, running: 2, done: 2, failed: 2 };
/** 屏高低于这个（dp）按小屏收紧 */
export const SMALL_SCREEN_HEIGHT = 800;

/** 工作区展开后（以及「任务」组）一页露几条空闲任务 */
export const TASK_PAGE = 6;

export interface Seen {
  /** 这次在手机上打开过的「跑完没看 / 出错」 */
  viewed: ReadonlySet<string>;
  /** 此刻打开着的那条 */
  selectedId: string | null;
}

/** 一行此刻画什么饼、进哪一组 */
export function effective(row: SessionSummary, seen: Seen): { pie: MobileSessionState | null; group: GroupId | null } {
  if (row.state === "idle") return { pie: null, group: null };
  if ((row.state === "done" || row.state === "failed") && seen.viewed.has(row.id)) {
    return row.id === seen.selectedId ? { pie: null, group: row.state } : { pie: null, group: null };
  }
  return { pie: row.state, group: row.state };
}

export interface AttentionGroup {
  id: GroupId;
  /** 组里全部的行（按最近活动排）；画多少由上限与展开决定 */
  rows: SessionSummary[];
  cap: number;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  latest: number;
  sessions: SessionSummary[];
}

export interface ListModel {
  groups: AttentionGroup[];
  workspaces: WorkspaceGroup[];
  /** 不属于任何工作区的任务 */
  loose: SessionSummary[];
  empty: boolean;
}

const byRecent = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

export function buildList(sessions: readonly SessionSummary[], seen: Seen, small: boolean): ListModel {
  const caps = small ? GROUP_CAPS_SMALL : GROUP_CAPS;
  const sorted = [...sessions].sort(byRecent);
  const groups = GROUP_ORDER.map((id) => ({
    id,
    rows: sorted.filter((row) => effective(row, seen).group === id),
    cap: caps[id],
  })).filter((group) => group.rows.length > 0);
  const workspaces = new Map<string, WorkspaceGroup>();
  const loose: SessionSummary[] = [];
  for (const row of sorted) {
    if (row.workspaceId === null) {
      loose.push(row);
      continue;
    }
    let ws = workspaces.get(row.workspaceId);
    if (ws === undefined) {
      // 工作区没了（名字是 null）：用 id 兜底，总比整组消失好
      ws = { id: row.workspaceId, name: row.workspaceName ?? row.workspaceId, latest: row.updatedAt, sessions: [] };
      workspaces.set(row.workspaceId, ws);
    }
    ws.sessions.push(row);
    ws.latest = Math.max(ws.latest, row.updatedAt);
  }
  return {
    groups,
    workspaces: [...workspaces.values()].sort((a, b) => b.latest - a.latest),
    loose,
    empty: sessions.length === 0,
  };
}

/**
 * 一组任务行（工作区展开后、「任务」组）：顶上露过的折成 `above`；空闲的按最近活动排，
 * 露 `pages` 页；剩下的数成 `older`。
 */
export function taskRows(
  sessions: readonly SessionSummary[],
  seen: Seen,
  pages: number,
): { above: number; rows: SessionSummary[]; older: number } {
  const above = sessions.filter((row) => effective(row, seen).group !== null).length;
  const rest = sessions.filter((row) => effective(row, seen).group === null).sort(byRecent);
  const rows = rest.slice(0, TASK_PAGE * pages);
  return { above, rows, older: rest.length - rows.length };
}

/** 收到 `sessions.changed`：改过的覆盖、新来的加上、消失的删掉 */
export function applySessionsChanged(
  current: ReadonlyMap<string, SessionSummary>,
  changed: readonly SessionSummary[],
  removed: readonly string[],
): Map<string, SessionSummary> {
  const next = new Map(current);
  for (const id of removed) next.delete(id);
  for (const session of changed) next.set(session.id, session);
  return next;
}
