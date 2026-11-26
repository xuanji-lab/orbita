/**
 * 对话里看板「画好的样子」的跨挂载缓存。
 *
 * 看板按会话重挂；iframe 换一次性地址、加载、再收数据的期间，旧实现只留一块同高空白。
 * 这里把宿主窗口截到的像素留成 ImageBitmap，重挂时同步贴上，等真 iframe 画好再换下。
 * 留图不在切走 / 卸载时做：看板画好后在空闲时预先留一张（按布局分开存），切走时什么都不截，
 * 切回时有对得上的就直接贴；没有（新布局、被 LRU 挤掉）就照常等 iframe。
 *
 * 一张位图是看板的「一片」：从看板顶部往下 cssTop 像素起，cssWidth × cssHeight 大（CSS 像素）。
 * 整块都在对话区里时就是整块（cssTop = 0）；原地展开后比对话区高，只截得到此刻看得见的那一段，
 * 贴回去时钉在同一个位置。快照数据本身不可变，但主题、宽度、DPR 都会改变像素，对不上就不用。
 * 只按 LRU 失效，不做时间过期：切走多久都不该再白一帧。
 *
 * 贴的时候永远 1:1、左上角钉在它截下来的位置，不拉伸、不缩放；比此刻的外框宽的部分由外框裁掉。
 * 纯逻辑与 DOM 无关，可被 node --test 直接加载。
 */
import { LruCache } from "../../../../shared/lru.ts";

export interface BoardShot {
  bitmap: ImageBitmap;
  /** 属于哪块看板（boardShotKey） */
  cacheKey: string;
  /** 这一片从看板顶部往下多少 CSS 像素开始 */
  cssTop: number;
  /** 截图时看板外框的 CSS 宽、这一片的 CSS 高 */
  cssWidth: number;
  cssHeight: number;
  /** 截图时的设备像素比 */
  ratio: number;
  /** 截图时的应用主题（明 / 玄等主题的卡面像素不同，不能混贴） */
  theme: string;
  capturedAt: number;
}

/** 此刻看得见的那一片：从看板顶部往下 top 像素起、height 高 */
export interface BoardShotView {
  top: number;
  height: number;
}

export interface BoardShotQuery extends BoardShotView {
  /** 看板外框此刻的宽 */
  width: number;
  ratio: number;
  theme: string;
  now: number;
}

export const BOARD_SHOT_LIMIT = 8;
/** 看得见的那一片至少这么高才值得截、值得贴（再小就只是一条边） */
export const BOARD_SHOT_MIN_VIEW_PX = 24;

export const boardShots = new LruCache<BoardShot>(BOARD_SHOT_LIMIT);

/** 会话与工具调用一起作键：不同会话即使 toolCallId 撞了也绝不互贴。 */
export function boardShotKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

/** 同一块看板按「哪一片、多宽、倍率、主题」各留一张：右栏开合、原地展开都会换一张，互不覆盖。 */
export function boardShotVariantKey(
  cacheKey: string,
  shot: Pick<BoardShot, "cssTop" | "cssWidth" | "cssHeight" | "ratio" | "theme">,
): string {
  return `${cacheKey}:${Math.round(shot.cssTop)}:${Math.round(shot.cssWidth)}:${Math.round(shot.cssHeight)}:${shot.ratio}:${shot.theme}`;
}

/**
 * 看板外框（视口坐标下的 top 与高）与滚动容器的可见范围（clipTop..clipBottom）的交集。
 * 回「从看板顶部往下多少、多高」；不足一条边回 null。
 */
export function boardShotView(board: { top: number; height: number }, clip: { top: number; bottom: number }): BoardShotView | null {
  const top = Math.max(board.top, clip.top);
  const height = Math.min(board.top + board.height, clip.bottom) - top;
  return height >= BOARD_SHOT_MIN_VIEW_PX ? { top: Math.max(0, top - board.top), height } : null;
}

/** 这张位图盖不盖得住此刻看得见的那一片（上下都不缺） */
export function boardShotCovers(shot: Pick<BoardShot, "cssTop" | "cssHeight">, view: BoardShotView): boolean {
  return shot.cssTop <= view.top + 1 && shot.cssTop + shot.cssHeight >= view.top + view.height - 1;
}

function usable(shot: BoardShot, q: BoardShotQuery): boolean {
  return shot.ratio === q.ratio && shot.theme === q.theme && q.now - shot.capturedAt >= 0;
}

/**
 * 正好盖住此刻看得见的那一片、宽度也对得上的位图；有几张时取从最高处起的那张（贴回去露得最全）。
 * 「这一片是不是已经有图了」也问它：已经盖住就不再截。
 */
export function boardShotCovering(cacheKey: string, q: BoardShotQuery): BoardShot | undefined {
  let best: BoardShot | undefined;
  for (const shot of boardShots.values()) {
    if (shot.cacheKey !== cacheKey || !usable(shot, q) || Math.abs(shot.cssWidth - q.width) >= 2 || !boardShotCovers(shot, q)) continue;
    if (best === undefined || shot.cssTop < best.cssTop) best = shot;
  }
  return best === undefined ? undefined : (boardShots.get(boardShotVariantKey(cacheKey, best)) ?? best);
}

/** 宽度对不上时哪一张更贴近此刻的外框：先比上下盖不盖得住看得见的那一片，再比宽度盖不盖得住，最后比差多少 */
function nearer(left: BoardShot, right: BoardShot, q: BoardShotQuery): BoardShot {
  const leftCovers = boardShotCovers(left, q);
  const rightCovers = boardShotCovers(right, q);
  if (leftCovers !== rightCovers) return leftCovers ? left : right;
  // 宽度盖得住此刻外框的在前（贴上去右边不缺）；都盖得住时越窄越贴近，被裁掉的越少
  const leftWide = left.cssWidth >= q.width - 1;
  const rightWide = right.cssWidth >= q.width - 1;
  if (leftWide !== rightWide) return leftWide ? left : right;
  // 都盖不住（外框比哪一张都宽）时越宽越贴近，右边缺的越少
  return leftWide ? (left.cssWidth <= right.cssWidth ? left : right) : (left.cssWidth >= right.cssWidth ? left : right);
}

/**
 * 此刻该贴哪一张：有正好盖住的就贴它；没有（右栏开合、窗口缩放的过渡里宽度每帧都在变）就贴同一块看板里
 * 最接近的一张。都不拉伸——1:1 钉在截下来的位置，多出来的由外框裁掉。
 */
export function boardShotFor(cacheKey: string, q: BoardShotQuery): BoardShot | undefined {
  const covered = boardShotCovering(cacheKey, q);
  if (covered !== undefined) return covered;
  let best: BoardShot | undefined;
  for (const shot of boardShots.values()) {
    if (shot.cacheKey !== cacheKey || !usable(shot, q)) continue;
    if (best === undefined) best = shot;
    else if (nearer(shot, best, q) === shot) best = shot;
  }
  return best === undefined ? undefined : (boardShots.get(boardShotVariantKey(cacheKey, best)) ?? best);
}

/**
 * 主进程回的 BGRA 原始像素 → ImageData 要的 RGBA（就地换 R、B 两个通道，不再拷一份）。
 * 长度对不上 width × height × 4、尺寸不是正整数都回 null：宁可不贴，也不贴一张错位 / 局部的图。
 */
export function boardShotRgba(pixels: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (pixels.byteLength !== width * height * 4 || !(pixels.buffer instanceof ArrayBuffer)) return null;
  const buffer = pixels.buffer;
  if (pixels.byteOffset % 4 === 0) {
    // 小端下一个像素读成 0xAARRGGBB，换成 0xAABBGGRR：每像素一次位运算
    const words = new Uint32Array(buffer, pixels.byteOffset, width * height);
    for (let i = 0; i < words.length; i += 1) {
      const value = words[i] ?? 0;
      words[i] = (value & 0xff00ff00) | ((value & 0xff) << 16) | ((value >>> 16) & 0xff);
    }
  } else {
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      const blue = pixels[i] ?? 0;
      pixels[i] = pixels[i + 2] ?? 0;
      pixels[i + 2] = blue;
    }
  }
  return new Uint8ClampedArray(buffer, pixels.byteOffset, pixels.byteLength);
}

/** 到点后再等页面空闲才留图（滚动、输入、会话切换的那几帧不插队）；最多再等这么久 */
export const CAPTURE_IDLE_TIMEOUT_MS = 1000;

/** idleAfter 用到的计时器与空闲回调；requestIdle 不在（老环境）时到点直接跑 */
export interface IdleScheduler {
  setTimeout(run: () => void, delay: number): number;
  clearTimeout(id: number): void;
  requestIdle: ((run: () => void, timeout: number) => number) | undefined;
  cancelIdle(id: number): void;
}

/**
 * 隔 delay 毫秒后、再等到页面空闲（最多 CAPTURE_IDLE_TIMEOUT_MS）才跑 run。回取消函数：
 * 卸载（切走会话）、再次滚动时调用，计时中和已排进空闲队列的都撤掉，切走那一下不会再有留图插进来。
 */
export function idleAfter(scheduler: IdleScheduler, delay: number, run: () => void): () => void {
  let idle: number | undefined;
  let cancelled = false;
  const timer = scheduler.setTimeout(() => {
    if (cancelled) return;
    if (scheduler.requestIdle === undefined) run();
    else idle = scheduler.requestIdle(() => {
      if (!cancelled) run();
    }, CAPTURE_IDLE_TIMEOUT_MS);
  }, delay);
  return () => {
    cancelled = true;
    scheduler.clearTimeout(timer);
    if (idle !== undefined) scheduler.cancelIdle(idle);
  };
}

/** 留图前后各量一次的几何：外框在视口里的位置与大小、看得见的那一片、滚动位置 */
export interface BoardShotGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  view: BoardShotView;
  scrollTop: number;
}

/** 两次量到的是不是同一处（亚像素抖动不算）。量矩形与截像素不在同一刻，贴回来就只剩某个局部，所以对不上就丢 */
export function boardShotGeometrySame(a: BoardShotGeometry, b: BoardShotGeometry): boolean {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1 &&
    Math.abs(a.scrollTop - b.scrollTop) < 1 &&
    Math.abs(a.view.top - b.view.top) < 1 &&
    Math.abs(a.view.height - b.view.height) < 1
  );
}
