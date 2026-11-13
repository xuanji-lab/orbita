/**
 * 文档标签头部的「大小 · 修改时间」来自文件预览的读数，只在打开时读一次；文档视图自己读盘、自己监听，
 * agent 改了文档、插了图、用户自己存盘之后头部仍是旧的（验收：768 B · 19 分钟前，实际已是 915 B）。
 * 这里订阅「被监听文档变了」，合并一阵连续的变化（打字自动保存每隔几百毫秒就一次）后只让预览重读一次。
 *
 * 纯函数、定时器可注入：node:test 直接加载。返回退订函数。
 */
export interface MetaTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const DOC_META_REFRESH_DEBOUNCE_MS = 400;

export function watchDocMeta(
  subscribe: (listener: (event: { path: string }) => void) => () => void,
  path: string,
  refresh: () => void,
  timers: MetaTimers = {
    set: (callback, ms) => window.setTimeout(callback, ms),
    clear: (handle) => window.clearTimeout(handle as number),
  },
): () => void {
  let pending: unknown = null;
  const off = subscribe((event) => {
    if (event.path !== path) return;
    if (pending !== null) timers.clear(pending);
    pending = timers.set(() => {
      pending = null;
      refresh();
    }, DOC_META_REFRESH_DEBOUNCE_MS);
  });
  return () => {
    off();
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
}
