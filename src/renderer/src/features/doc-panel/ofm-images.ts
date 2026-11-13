/**
 * 文档里的图片：解析出真文件后，经文件面板同一条只读通道（`fs:read`，白名单在主进程）读成 data: URL。
 * 同一路径只读一次（小 LRU）：编辑视图 / 阅读视图来回切、agent 改字时图片不重读。
 * 读不到 / 太大 / 不是图 = null（调用方画占位，不抛）。
 */
import { api } from "../../api";
import type { OfmResolved } from "../../../../shared/doc.ts";

const MAX_CACHED = 40;
const cache = new Map<string, Promise<string | null>>();

export interface ImageScope {
  sessionId: string | null;
  workspaceId: string | null;
}

export function loadImageUrl(scope: ImageScope, resolved: NonNullable<OfmResolved>): Promise<string | null> {
  const key = `${resolved.path}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // 命中的挪到末尾（最近用过）
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const promise = api.files
    .read({ sessionId: scope.sessionId, workspaceId: scope.workspaceId, root: resolved.root, dir: resolved.path })
    .then((data) => (data.kind === "image" ? `data:${data.mime};base64,${data.base64}` : null))
    .catch(() => null);
  cache.set(key, promise);
  // 读失败不留缓存（文件可能稍后才出现）
  void promise.then((url) => {
    if (url === null) cache.delete(key);
  });
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return promise;
}

/** 刚插进图片 / 图片被替换后，丢掉某个路径的缓存 */
export function forgetImage(path: string): void {
  cache.delete(path);
}
