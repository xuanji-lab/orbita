/**
 * 侧栏工作区下面列什么（常驻主智能体，2026-11-17 用户定稿的设计第 1 件 A）：
 * 工作区这一行就是主智能体本身；下面只露**还没了结**的活——主智能体派出去的子会话，
 * 加上这个工作区里以前攒下的会话——状态饼亮着（在跑 / 等你 / 没做成 / 做完没看）的那些；
 * 其余（做完看过的活、以前攒下的会话）收进最后一行「以前的会话 N」。
 *
 * 纯函数：状态由调用方给（runStateOf，与侧栏状态饼、铃铛清单同一份真源）；不读转录。
 */
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../features/notify/completion-notice.ts";

export interface WorkspaceRows {
  /** 这个工作区的主智能体那条会话；还没说过话（只预留了 id）或旧数据里没有 = null */
  main: SessionMeta | null;
  /** 没了结的，按急的在前（等你 › 没做成 › 在跑 › 做完没看），同档最近动过的在前 */
  open: SessionMeta[];
  /** 以前的会话：做完看过的活与以前攒下的会话，最近动过的在前 */
  earlier: SessionMeta[];
}

const URGENCY: Readonly<Record<Exclude<SessionRunState, null>, number>> = { waiting: 0, failed: 1, running: 2, done: 4 };
/** 暂停着的：在跑的之后、做完没看的之前 */
const HELD_RANK = 3;

export function workspaceRows(
  sessions: readonly SessionMeta[],
  workspaceId: string,
  stateOf: (meta: SessionMeta) => SessionRunState,
  /** 主智能体暂停着的活：没有状态饼，但也没了结（设计 7-5：停着的不自己退场），排在在跑的后面 */
  held: (meta: SessionMeta) => boolean = () => false,
): WorkspaceRows {
  const main = sessions.find((meta) => meta.role === "main" && meta.workspaceId === workspaceId && meta.parentId === undefined) ?? null;
  const candidates = sessions.filter((meta) => {
    if (meta.workspaceId !== workspaceId || meta.archived) return false;
    if (meta.id === main?.id) return false;
    // 主智能体派出去的活：它的直接子会话（子会话随母会话的工作区走）
    if (meta.parentId !== undefined) return main !== null && meta.parentId === main.id;
    // 根会话：用户以前自己开的；自动化开出的只在 promoted 之后才算（rootSessions 同口径）
    return meta.automationId === undefined || meta.promoted === true;
  });
  const open: { meta: SessionMeta; rank: number }[] = [];
  const earlier: SessionMeta[] = [];
  for (const meta of candidates) {
    const state = stateOf(meta);
    if (state !== null) open.push({ meta, rank: URGENCY[state] });
    else if (held(meta)) open.push({ meta, rank: HELD_RANK });
    else earlier.push(meta);
  }
  open.sort((a, b) => a.rank - b.rank || b.meta.updatedAt - a.meta.updatedAt);
  earlier.sort((a, b) => b.updatedAt - a.updatedAt);
  return { main, open: open.map((item) => item.meta), earlier };
}

/**
 * 当前工作区展开后「没了结的活」最多露几行（设计 11-sidebar-full：最多 6 行，超出折成「还有 N 件」）。
 * 等你的永远露出来——等你的多于 6 件就全露；点过「还有 N 件」（showAll）= 全露。
 * 不再套 groupVisibleLimit 的「每组 5 条 + 再显示」：那是给列会话用的，满载时第 6 件活被它藏了。
 * open 已按急的在前排好（等你在最前），所以前 N 行里必然先是等你的。
 */
export const OPEN_ROWS_MAX = 6;

export function openRowsLimit(
  open: readonly SessionMeta[],
  stateOf: (meta: SessionMeta) => SessionRunState,
  showAll: boolean,
): number {
  if (showAll) return open.length;
  return Math.max(OPEN_ROWS_MAX, open.filter((meta) => stateOf(meta) === "waiting").length);
}

/** 「以前的会话」里的搜索：标题与最近几次提问里有没有这几个字（不分大小写；空查询 = 全部） */
export function matchesSessionQuery(meta: SessionMeta, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [meta.title, ...meta.recentQueries].some((text) => text.toLowerCase().includes(needle));
}
