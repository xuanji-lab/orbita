/**
 * 折叠行展开态的记忆（模块级、按稳定 key）——历史段虚拟化后，行滚出视口就会
 * 卸载；组件内的 `useState` 随之丢失，滚回来会突然收起，用户展开的细节没了。
 *
 * 只记「用户/自动改过的最后状态」，不记默认值：没有记录时由组件按自己的默认值
 * 初始化（例如活跃轮的过程块默认展开）。key 用 entry.key / toolCallId 这类稳定
 * 标识，不用数组下标。上限 1000 条（LRU），长期会话不会无限涨。
 */
const FOLD_STATE_LIMIT = 1000;
const foldState = new Map<string, boolean>();

/** 读记忆；命中即刷新 LRU 位置。没有记录返回 undefined（调用方用默认值） */
export function readFoldState(key: string): boolean | undefined {
  const value = foldState.get(key);
  if (value === undefined) return undefined;
  foldState.delete(key);
  foldState.set(key, value);
  return value;
}

/** 写记忆（LRU 上限淘汰最旧） */
export function writeFoldState(key: string, open: boolean): void {
  foldState.delete(key);
  foldState.set(key, open);
  while (foldState.size > FOLD_STATE_LIMIT) {
    const oldest = foldState.keys().next().value;
    if (oldest === undefined) break;
    foldState.delete(oldest);
  }
}

/** 测试 / 会话级清理用 */
export function clearFoldState(): void {
  foldState.clear();
}

/** 当前条数（测试用） */
export function foldStateSize(): number {
  return foldState.size;
}
