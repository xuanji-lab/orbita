/**
 * 撤销 / 重做栈：存**快照**（不是命令）。Deck 是不可变结构，每次改动只新建被改的那页 / 那个元素，
 * 其余引用不变，所以存 100 份快照的内存开销约等于改动量，不是 100 份整文稿。
 *
 * coalesceKey：同一个键的连续改动合并成一步（方向键微移、连续输入字号），撤销一次回到这串改动之前。
 * 合并只在 `COALESCE_MS` 内成立：隔了几秒再按方向键是另一件事。
 */
export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  /** 最近一次推入的合并键与时间 */
  last: { key: string; at: number } | null;
}

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1200;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], last: null };
}

export function pushState<T>(history: History<T>, next: T, now: number, coalesceKey?: string): History<T> {
  if (next === history.present) return history;
  const merge = coalesceKey !== undefined && history.last !== null && history.last.key === coalesceKey && now - history.last.at <= COALESCE_MS;
  const past = merge ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], last: coalesceKey === undefined ? null : { key: coalesceKey, at: now } };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], last: null };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest, last: null };
}

/** 外部（agent）改动并进来：作为新的一步入栈，撤销能回到它之前；不触发合并 */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [], last: null };
}
