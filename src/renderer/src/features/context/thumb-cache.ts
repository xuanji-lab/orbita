/**
 * 状态卡缩略图数据的跨挂载缓存：卡按会话重挂，数据若只放组件 state，每次切回会话都要从零读一遍
 * （先空白、再一张张出来）。这里按「会话 + 路径」留住上次读到的结果，切回时第一帧就能画出来，
 * 后台再读一次校验——戳（stamp）没变就不动，变了才替换。纯逻辑，不碰 DOM / IPC。
 */
import { LruCache } from "../../../../shared/lru.ts";

export interface ThumbEntry<T> {
  data: T;
  /** 校验戳：文件 mtime（图片 / 文本 / 网页缩略图），PDF 没有 mtime 就用字节数 */
  stamp: number;
}

const THUMB_CACHE_LIMIT = 60;

export function createThumbCache<T>(limit: number = THUMB_CACHE_LIMIT) {
  const lru = new LruCache<ThumbEntry<T>>(limit);
  return {
    key: (sessionId: string | null, path: string): string => `${sessionId ?? ""}\u0000${path}`,
    get: (key: string): ThumbEntry<T> | undefined => lru.get(key),
    set: (key: string, entry: ThumbEntry<T>): void => lru.set(key, entry),
    /**
     * 读回来的新结果该不该替换缓存 / 状态：没有旧的、或戳不同才算变。
     * 新结果是 null（读不到）时只在旧的也不是 null 时才算变——由调用方把 null 传成 stamp -1。
     */
    changed: (prev: ThumbEntry<T> | undefined, stamp: number): boolean => prev === undefined || prev.stamp !== stamp,
  };
}
