/**
 * 分段预览（`RangeTextPreview.tsx`）的**纯视图函数**：日志判定、滚动位置 ↔ 行号的映射、
 * 能浏览多少行、取窗起点的对齐与夹取、窗口缓存的进出。
 *
 * 独立成模块的理由同 preview-view.ts：组件要连 IPC + React state，这里只留纯函数，
 * `node --test` 直接可测（滚动映射错了只会表现成「滚到中间是别处的行」，肉眼很难发现，
 * 所以这一段必须能单独跑测试）。
 */

/**
 * 一次取多少行的窗口起点对齐步长：600 行的窗口按 300 行对齐，滚过半个窗口才换窗，
 * 相邻窗口重叠 300 行——既不会每滚一行就发一次请求，也不至于一次拖太远。
 */
export const RANGE_WINDOW_STEP = 300;

/** 窗口缓存条数：5 个窗口 × 600 行，往回滚一下通常是缓存命中，不必再问主进程 */
export const RANGE_WINDOW_CACHE = 5;

/**
 * 日志类文件（默认打开末尾）：看**扩展名**——`.log`，以及轮转出来的 `.log.1` / `.log.2026-10-30`
 * （大小写不敏感）。
 *
 * 原来是 `/log/i`（名字里有 log 四个字母就算），`CHANGELOG.md`、`dialog.txt`、`catalog.csv`、
 * `login.py` 全中——它们默认被扔到文件末尾，用户以为文件被截了。当时注释写的是「用户裁决」，
 * 没查到出处；日志的扩展名是 `.log`，别的靠名字猜都会误中。点「开头」一下就回得来，
 * 所以漏判一个不带 `.log` 的真日志（比如 `syslog`）的代价也很轻。
 */
export function isLogLikeName(name: string): boolean {
  return /\.log(?:\.\d[\w-]*)?$/i.test(name);
}

/**
 * 滚动位置 → 首条可见行（行高没量出来时给 0，首帧只渲染已知窗口）。
 *
 * `contentTop` 是行块顶端在滚动内容里的位置：行块上方还有内边距和提示带（实测 114 px，
 * 约 6 行）。原先的映射没扣它，于是「第 N 行」被当成「第 N + 6 行」，滚到「结尾」时最后
 * 5 行落在视口下方——看崩溃日志恰好看不到最新几行。
 */
export function lineAtScroll(scrollTop: number, rowHeight: number, contentTop: number = 0): number {
  if (!(rowHeight > 0)) return 0;
  return Math.max(0, Math.floor((Math.max(0, scrollTop) - Math.max(0, contentTop)) / rowHeight));
}

/** 第 `line` 行顶端对齐视口顶端时的 scrollTop（`lineAtScroll` 的逆运算） */
export function scrollTopForLine(line: number, rowHeight: number, contentTop: number = 0): number {
  return Math.max(0, contentTop) + Math.max(0, Math.floor(line)) * Math.max(0, rowHeight);
}

/** 视口高度 → 可见行数（至少 1 行） */
export function visibleLineCount(viewportHeight: number, rowHeight: number): number {
  if (!(rowHeight > 0)) return 1;
  return Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
}

/**
 * 取窗起点：先退 `overscan` 行（预读，滚轮一动不露白），再按 `step` 向下对齐，
 * 最后夹进 `[0, totalLines - count]`——最后那一窗因此是稳定的「末尾一屏」，
 * 滚到底不会每次都换一个偏移。
 *
 * 对齐可能把窗口往前推最多 `step` 行，所以末尾要验一次「这一窗真的盖住了可视区」；
 * 盖不住（可视区比窗口还高这种极端情况）就退回不对齐的起点。这一步不能省：
 * 盖不住时组件会再要一次，而下一次算出来还是同一个起点，就成死循环。
 */
export function windowStartFor(
  firstVisible: number,
  totalLines: number,
  count: number,
  overscan: number,
  visibleRows: number,
  step: number = RANGE_WINDOW_STEP,
): number {
  const total = Math.max(0, Math.floor(totalLines));
  const lines = Math.max(1, Math.floor(count));
  if (total === 0) return 0;
  const stride = Math.max(1, Math.floor(step));
  const first = Math.max(0, Math.floor(firstVisible));
  const wanted = Math.max(0, first - Math.max(0, Math.floor(overscan)));
  const lastAllowed = Math.max(0, total - lines);
  const aligned = Math.min(Math.floor(wanted / stride) * stride, lastAllowed);
  if (first + Math.max(1, Math.floor(visibleRows)) <= aligned + lines) return Math.max(0, aligned);
  return Math.min(Math.max(0, wanted), lastAllowed);
}

/** 跳转出口：开头 / 50% / 结尾 */
export type RangeJump = "head" | "middle" | "tail";

/**
 * 「50%」要滚到的首行：中间一屏居中（全文中点那一行落在视口正中）。数据窗口由 `windowStartFor`
 * 从滚动位置反推，这里只管滚动层。开头固定是 scrollTop 0，结尾直接滚到 `scrollHeight`
 * （让浏览器自己夹到真正的底，不靠行号算——原先 `(总行数 − 可见行数) × 行高` 没算行块上方的 ~114 px）。
 */
export function middleLine(totalLines: number, visibleRows: number): number {
  const total = Math.max(0, Math.floor(totalLines));
  const rows = Math.max(1, Math.floor(visibleRows));
  return Math.max(0, Math.floor(total / 2) - Math.floor(rows / 2));
}

/**
 * 滚动容器除行块之外要留的高度（px）：行块上方的提示带 + 内边距（实测约 114 px）、
 * 下方的内边距，再留够一屏的余量。探针量出的滚动高度上限要扣掉它，才是行块自己最多能有多高。
 */
const SCROLL_HEIGHT_MARGIN = 2048;

/**
 * 在量出的滚动高度上限（px，`useScrollHeightLimit` 探针的结果）下，最多能浏览多少行。
 *
 * 上限是 Chromium 按**物理像素**算的：同一台 Mac 上页面缩放 0.5 / 1 / 2 实测是 33.5M / 16.7M /
 * 8.4M，Windows 125% / 150% 缩放也各不相同；行高被界面字号撑大同样会让总高度变高。所以这里
 * 不是常量，而是「现量的上限 ÷ 现量的行高」。超过它，滚动条映射不了全文位置，后面的行永远
 * 滚不到——组件改给空态 + 默认应用打开，**不静默滚不到底**。
 */
export function maxBrowsableLines(scrollLimit: number, rowHeight: number): number {
  if (!(rowHeight > 0) || !Number.isFinite(scrollLimit)) return 0;
  return Math.max(0, Math.floor((scrollLimit - SCROLL_HEIGHT_MARGIN) / rowHeight));
}

/** 缓存里的一窗：起点行号 + 行内容（`lines.length` 就是这一窗的覆盖行数） */
export interface CachedWindow {
  start: number;
  lines: readonly string[];
}

/** `[first, end)` 是否已经被这一窗完整覆盖 */
export function windowCovers(
  win: CachedWindow | null,
  first: number,
  end: number,
): boolean {
  if (win === null) return false;
  return win.start <= first && win.start + win.lines.length >= end;
}

/**
 * 放进缓存（最近使用的排到最后）：同起点覆盖旧的，超上限就丢最久没用过的那一窗。
 * `Map` 的迭代顺序就是插入顺序，所以「删了再插」= 提升为最近使用。
 */
export function rememberWindow(
  cache: Map<number, CachedWindow>,
  win: CachedWindow,
  max: number = RANGE_WINDOW_CACHE,
): void {
  cache.delete(win.start);
  cache.set(win.start, win);
  const limit = Math.max(1, Math.floor(max));
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** 在缓存里找一窗能完整覆盖 `[first, end)` 的（最近使用的先命中），命中时提升它 */
export function findCachedWindow(
  cache: Map<number, CachedWindow>,
  first: number,
  end: number,
): CachedWindow | null {
  for (const [key, win] of cache) {
    if (!windowCovers(win, first, end)) continue;
    cache.delete(key);
    cache.set(key, win);
    return win;
  }
  return null;
}
