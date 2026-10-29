/**
 * 「整个任务」视野的取数编排 —— 纯状态机部分（hook 见 useContextInventory.ts）。
 *
 * renderer 的会话槽只装尾窗（500 条）：「本轮」够用，「整个任务」要更早的记录。
 * 取数用现成的 `session:loadOlder` 逐页往前拉，拉完**缓存在这里**（模块级 store，
 * 按会话 id 一份）：新轮的记录走实时槽、永远比缓存新，所以增量天然合并、
 * 切换视野不重拉。失效只有一个来源：**回退**——主进程重读会话、生效视图变短，
 * 缓存里的更早记录可能已被回退折掉。回退会在槽里追加一条 RevertRecord，
 * 以 `entry.reverts.length` 为指纹判失效（undo 不重建视图、分支另起新会话，
 * 都不用判）。
 *
 * 纯模块：不 import React、不碰 IPC，可被 `node --test` 直接加载；hook 只做
 * 「store ↔ IPC 循环 ↔ React」的接线。
 */
import type { SessionRecord, TranscriptRecord } from "../../../../shared/session.ts";

/**
 * 失效指纹：尾窗第一条记录 id + 回退计数（回退会在槽里追加 RevertRecord，
 * 是唯一会作废「更早记录」的操作；undo 不重建视图、分支另起新会话，都不用判）。
 * firstId 不参与失效判定（聊天面自己滚动分页也会前移它），只作拉取循环的起始锚。
 */
export interface HistoryAnchor {
  firstId: string | null;
  reverts: number;
}

/**
 * 拉取循环的页数上限（防失控）：200 页 × 500 条 = 10 万条记录，远超正常会话；
 * 撞上限就停在「已取到的」，`capped = true` 让界面如实标注「更早的没取完」。
 */
export const TASK_HISTORY_PAGE_LIMIT = 200;

export interface TaskHistoryState {
  status: "idle" | "loading" | "ready" | "error";
  /**
   * 已取到的更早记录（时间正序；**不含**尾窗里的记录——合并发生在 mergeHistory）。
   * loading 期间是已到手的部分，界面可以渐进显示。
   */
  records: SessionRecord[];
  /** 已取回的累计条数（进度显示用） */
  fetched: number;
  /** 已拉了几页（撞 TASK_HISTORY_PAGE_LIMIT 判 capped 用） */
  pages: number;
  /** 撞页数上限停了：这份「整个任务」不完整 */
  capped: boolean;
  error: string | null;
  /** 开拉那一刻的失效指纹：尾窗第一条记录 id + 回退计数 */
  anchor: { firstId: string | null; reverts: number };
}

/** 尚未开始取数的常量态（store 里没有会话的槽时给它的视图）。引用稳定。 */
export const TASK_HISTORY_IDLE: TaskHistoryState = {
  status: "idle",
  records: [],
  fetched: 0,
  pages: 0,
  capped: false,
  error: null,
  anchor: { firstId: null, reverts: 0 },
};

/** 开拉：记下失效指纹，进入 loading。 */
export function startHistory(anchor: HistoryAnchor): TaskHistoryState {
  return {
    ...TASK_HISTORY_IDLE,
    status: "loading",
    anchor: { firstId: anchor.firstId, reverts: anchor.reverts },
  };
}

/**
 * 一页到手：**整页前插**（loadOlder 的页是「锚之前的一段」，比已取到的都早），
 * 按 id 去重——与聊天面自己的滚动分页（prependOlder 进槽）可能取到同一批记录。
 * 空页 + hasMore=true 是主进程没对上盘的防御信号：停住标错，不空转。
 */
export function advanceHistory(state: TaskHistoryState, page: { records: SessionRecord[]; hasMore: boolean }): TaskHistoryState {
  const known = new Set(state.records.map((record) => record.id));
  const fresh = page.records.filter((record) => !known.has(record.id));
  const records = [...fresh, ...state.records];
  const pages = state.pages + 1;
  const capped = page.hasMore && pages >= TASK_HISTORY_PAGE_LIMIT;
  if (page.records.length === 0 && page.hasMore) {
    return { ...state, status: "error", error: "loadOlder 返回空页但声称还有更多", capped: false };
  }
  return {
    ...state,
    status: page.hasMore && !capped ? "loading" : "ready",
    records,
    fetched: state.fetched + fresh.length,
    pages,
    capped,
    error: null,
  };
}

/** 取数失败：保留已到手的（界面可退回部分视图），标错。 */
export function failHistory(state: TaskHistoryState, message: string): TaskHistoryState {
  return { ...state, status: "error", error: message };
}

/**
 * 缓存还能不能用：只有回退会作废更早的记录（见文件头）。指纹对不上 = 失效，
 * 下一次切到「整个任务」时重拉。
 */
export function historyStale(state: TaskHistoryState, anchor: HistoryAnchor): boolean {
  return state.status !== "idle" && state.anchor.reverts !== anchor.reverts;
}

/**
 * 合并成「整个任务」的完整生效视图：更早记录在前（它们在时间上全部早于尾窗），
 * 尾窗的合并视图（mergeSideRecords 产物）在后，按 id 去重——聊天面自己滚动
 * 分页装进尾窗的记录会同时出现在两边。
 */
export function mergeHistory(older: readonly SessionRecord[], current: readonly TranscriptRecord[]): TranscriptRecord[] {
  if (older.length === 0) return [...current];
  const seen = new Set(older.map((record) => record.id));
  return [...older, ...current.filter((record) => !seen.has(record.id))];
}

/**
 * 会话级缓存与订阅（useSyncExternalStore 的对面）。模块级单份：面板卸载再挂、
 * 或多个视图同时要「整个任务」，共享同一次拉取。snapshot 对未变更的会话返回
 * 同一引用（useSyncExternalStore 的要求）；没有任何状态时返回 TASK_HISTORY_IDLE。
 */
export class TaskHistoryStore {
  private readonly states = new Map<string, TaskHistoryState>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (sessionId: string): TaskHistoryState => this.states.get(sessionId) ?? TASK_HISTORY_IDLE;

  /** 写入并通知（引用相等就不动，白通知没有意义）。 */
  set(sessionId: string, next: TaskHistoryState): void {
    if (this.states.get(sessionId) === next) return;
    this.states.set(sessionId, next);
    this.notify();
  }

  /** 丢弃一份缓存（失效重拉前清掉，避免渐进视图里挂着已回退的记录）。 */
  drop(sessionId: string): void {
    if (!this.states.delete(sessionId)) return;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
