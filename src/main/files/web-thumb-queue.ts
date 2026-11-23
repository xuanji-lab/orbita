/**
 * 网页缩略图的纯逻辑：缓存键与「同时最多 N 个」的排队。
 * 与 Electron 无关，单独成文件好用 node --test 测。
 */

/** 缓存键 = 真实路径 + mtime + 大小：文件一改键就变，旧图自然不再命中 */
export function webThumbKey(path: string, modifiedAt: number, size: number): string {
  return `${path}\u0000${Math.floor(modifiedAt)}\u0000${size}`;
}

/**
 * 限并发的执行器：最多 `limit` 个任务同时跑，其余按到达顺序排队。
 * 一屏产物里有十个网页时，不会同时开十个渲染进程去吃 CPU / GPU。
 * 任务抛错只影响它自己的 promise，不堵队列。
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    running -= 1;
    const wake = waiting.shift();
    if (wake !== undefined) wake();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

/**
 * 同一个键同时只做一次：第二个请求直接等第一个的结果（同一份网页被两张卡、或快速切会话来回请求时）。
 */
export function createDedupe<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const inflight = new Map<string, Promise<T>>();
  return (key, run) => {
    const hit = inflight.get(key);
    if (hit !== undefined) return hit;
    const promise = run().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}
