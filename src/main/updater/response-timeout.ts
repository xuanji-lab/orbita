/**
 * Electron net 请求的首响应超时计时器；纯逻辑，便于用 node:test 验证 settle/clear 语义。
 * body 收到响应后由调用方清除，后续传输空闲由各自的 body 读取器负责。
 */
export interface TimeoutScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/**
 * 装一个只触发一次的超时。返回的函数幂等：响应、错误、主动关闭都可安全调用。
 * 超时回调由调用方负责 reject/abort，避免这个纯模块知道 Electron 请求对象。
 */
export function armTimeout(
  scheduler: TimeoutScheduler,
  delayMs: number,
  onTimeout: () => void,
): () => void {
  let active = true;
  const handle = scheduler.set(() => {
    if (!active) return;
    active = false;
    onTimeout();
  }, delayMs);
  return () => {
    if (!active) return;
    active = false;
    scheduler.clear(handle);
  };
}
