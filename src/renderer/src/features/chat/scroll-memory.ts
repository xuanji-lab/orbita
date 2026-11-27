/**
 * 会话阅读位置的内存记忆——纯模块，不依赖 React / DOM，可被 `node --test` 直接加载。
 *
 * 用户读长回复是从上往下读的，切去别的会话再切回来不该被拉到底部。离开前记下
 * 「首个可见行 key + 行顶相对视口偏移」（不用裸 scrollTop：内容高度会变）；
 * 在底部（跟随态）离开记「在底部」。只放内存、按会话 id，应用重启后不保留。
 */

export type ReadPosition =
  | { kind: "bottom" }
  | { kind: "row"; key: string; offsetTop: number };

/** 最多记住多少条会话；超出丢最久没更新的 */
export const SCROLL_MEMORY_LIMIT = 200;

/** 恢复时最多为定位翻多少页（与引用跳转同一口径） */
export const RESTORE_MAX_PAGES = 20;

export interface ScrollMemory {
  record(sessionId: string, position: ReadPosition): void;
  get(sessionId: string): ReadPosition | undefined;
  forget(sessionId: string): void;
  readonly size: number;
}

export function createScrollMemory(limit: number = SCROLL_MEMORY_LIMIT): ScrollMemory {
  const map = new Map<string, ReadPosition>();
  return {
    record(sessionId, position) {
      // 删再设：Map 按插入序，最新写入的排最后，淘汰从最旧的开始
      map.delete(sessionId);
      map.set(sessionId, position);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get: (sessionId) => map.get(sessionId),
    forget(sessionId) {
      map.delete(sessionId);
    },
    get size() {
      return map.size;
    },
  };
}

/** 离开时该记什么：跟随态记「在底部」；否则记首个可见行；没有可锚的行返回 null（不记） */
export function positionToRecord(
  following: boolean,
  anchor: { key: string; offsetTop: number } | null,
): ReadPosition | null {
  if (following) return { kind: "bottom" };
  if (anchor === null) return null;
  return { kind: "row", key: anchor.key, offsetTop: anchor.offsetTop };
}

export type RestoreDecision =
  | { action: "bottom" }
  | { action: "scroll"; top: number; key: string; offsetTop: number }
  | { action: "load" };

/**
 * 回到会话时怎么定位。
 * - 没记录 / 记的是底部 → 跳底并跟随；
 * - 行在已加载窗口里（resolve 给出 scrollTop）→ 恢复到那一行那个偏移；
 * - 不在：还能翻页且没超上限就先翻页，否则（被删 / 回退掉了）跳底。
 */
export function decideRestore(
  position: ReadPosition | undefined,
  resolve: (key: string, offsetTop: number) => number | null,
  canLoadMore: boolean,
  pagesLoaded: number,
): RestoreDecision {
  if (position === undefined || position.kind === "bottom") return { action: "bottom" };
  const top = resolve(position.key, position.offsetTop);
  if (top !== null) return { action: "scroll", top, key: position.key, offsetTop: position.offsetTop };
  if (canLoadMore && pagesLoaded < RESTORE_MAX_PAGES) return { action: "load" };
  return { action: "bottom" };
}
