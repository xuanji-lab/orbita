/**
 * 分段预览（`RangeTextPreview.tsx`）的**纯视图函数**：日志判定、首屏落在第几行、
 * 滚动位置 ↔ 行号的映射、取窗起点的对齐与夹取、窗口缓存的进出。
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
 * 日志类文件（默认打开末尾）。判定按用户裁决：「`.log` / 文件名含 log，大小写不敏感」。
 * 直白地认名字里有没有 log——`build.log`、`app.LOG`、`npm-debug.log` 都中；
 * `catalog.txt` 这种也会中（它确实带 log 四个字母），误判的代价只是默认落在末尾、
 * 点一下「开头」就回来了，比漏判一个真日志轻。
 */
export function isLogLikeName(name: string): boolean {
  return /log/i.test(name);
}

/**
 * 分段预览的首屏滚动行：日志 → 末尾（`总数 - 可见行`，滚到最底），其它 → 开头。
 * 行数比一屏还少时夹到 0。
 */
export function initialScrollLine(totalLines: number, visibleRows: number, logLike: boolean): number {
  const total = Math.max(0, Math.floor(totalLines));
  const rows = Math.max(1, Math.floor(visibleRows));
  return logLike ? Math.max(0, total - rows) : 0;
}

/** 滚动位置 → 首条可见行（行高没量出来时给 0，首帧只渲染已知窗口） */
export function lineAtScroll(scrollTop: number, rowHeight: number): number {
  if (!(rowHeight > 0)) return 0;
  return Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight));
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

/** 跳转出口：开头 / 50% / 结尾各滚到第几行 */
export type RangeJump = "head" | "middle" | "tail";

/**
 * 跳转目标行（滚到那儿作为首行）：结尾 = 最后一屏，50% = 中间一屏居中，
 * 开头 = 0。数据窗口由 `windowStartFor` 从滚动位置反推，这里只管滚动层。
 */
export function scrollLineForJump(totalLines: number, visibleRows: number, jump: RangeJump): number {
  const total = Math.max(0, Math.floor(totalLines));
  const rows = Math.max(1, Math.floor(visibleRows));
  if (jump === "tail") return Math.max(0, total - rows);
  if (jump === "middle") return Math.max(0, Math.floor(total / 2) - Math.floor(rows / 2));
  return 0;
}

/**
 * Chromium 能撑住的滚动高度上限（px）：33,554,430 是 Blink 给 LayoutUnit 留的顶。
 * 超过它的滚动条映射不了全文位置（后面的行永远滚不到），所以行高被界面字号撑大后
 * 总数 × 行高也得验一次——主进程的 1.8 M 行上限是按默认行高 18.59 px 算的
 * （1,800,000 × 18.59375 = 33,468,750，正好贴边）。
 */
export const MAX_VIRTUAL_HEIGHT = 33_500_000;

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
