import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";

/**
 * 演示文稿里图片的显示：deck 里存相对路径，渲染要一个可加载的 URL。
 * 经 `docs.readSlideAsset`（主进程白名单：只读演示文稿所在目录内的图片）取字节 → Blob URL，
 * 按「演示文稿路径 + 相对路径」缓存；取到后 bump 一个版本号让画布 / 缩略图重画。
 * 卸载时全部 revoke。找不到 / 读失败的记成失败，不反复重试（画占位框 + 文件名）。
 */
export interface AssetUrls {
  /** 现在能给的 URL；还没取到返回 null（并触发加载） */
  imageUrl(src: string): string | null;
  /** 缓存版本：取到新图时变，作为 memo 依赖 */
  version: number;
  /** 用户刚加进 assets 的图：立刻按字节放进缓存（不必再读一遍盘） */
  prime(src: string, bytes: Uint8Array, mime: string): void;
}

export function useAssetUrls(target: { sessionId: string | null; workspaceId: string | null; path: string }): AssetUrls {
  const { sessionId, workspaceId, path } = target;
  const cache = useRef(new Map<string, string | "pending" | "failed">());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const map = cache.current;
    return () => {
      for (const value of map.values()) if (value !== "pending" && value !== "failed") URL.revokeObjectURL(value);
      map.clear();
    };
  }, [path]);

  const imageUrl = useCallback(
    (src: string): string | null => {
      const hit = cache.current.get(src);
      if (hit !== undefined) return hit === "pending" || hit === "failed" ? null : hit;
      cache.current.set(src, "pending");
      void api.docs
        .readSlideAsset({ sessionId, workspaceId, path, src })
        .then((asset) => {
          const copy = new Uint8Array(asset.bytes);
          cache.current.set(src, URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: asset.mime })));
        })
        .catch(() => cache.current.set(src, "failed"))
        .finally(() => setVersion((v) => v + 1));
      return null;
    },
    [sessionId, workspaceId, path],
  );

  const prime = useCallback((src: string, bytes: Uint8Array, mime: string): void => {
    const old = cache.current.get(src);
    if (old !== undefined && old !== "pending" && old !== "failed") URL.revokeObjectURL(old);
    const copy = new Uint8Array(bytes);
    cache.current.set(src, URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: mime })));
    setVersion((v) => v + 1);
  }, []);

  return useMemo(() => ({ imageUrl, version, prime }), [imageUrl, version, prime]);
}
