/**
 * 一份从磁盘读回来的列表此刻处于哪一步。
 *
 * 这个类型存在的理由是**把「一个都没有」和「读不出来」分开**。以前侧栏的会话列表
 * 与工作区列表的读取失败都被 `.catch(() => setX([]))` 拍成空数组——磁盘权限坏了，
 * 用户看到的是「你的会话全没了」，而不是「读不出来」。这两句话的下一步完全不同：
 * 前者让人去翻回收站，后者让人去修权限。
 *
 * 纯判定，不 import React、不 import pi。
 */
export type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export const LOADING: LoadState = { kind: "loading" };
export const READY: LoadState = { kind: "ready" };

/** 把 catch 到的任何东西压成一条能贴在界面上的错误 */
export function failed(cause: unknown): LoadState {
  return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * 列表区该画什么。
 *
 * - `error`：失败原文，null = 没失败。**失败不清空手里的数据**——刷新失败时
 *   上一份还在，照常列出来，错误行贴在它上面；只有从没读成功过才是空空的错误。
 * - `body`：列表本体。`none` 只在「失败且一无所有」时出现：这时既不能说
 *   「一个都没有」（那是谎话），也没东西可列。
 */
export function describeList(
  state: LoadState,
  count: number,
): { error: string | null; body: "loading" | "empty" | "list" | "none" } {
  const error = state.kind === "failed" ? state.message : null;
  if (count > 0) return { error, body: "list" };
  if (state.kind === "loading") return { error, body: "loading" };
  if (state.kind === "failed") return { error, body: "none" };
  return { error, body: "empty" };
}
