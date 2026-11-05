/**
 * 全局周看板的布局与取舍（纯函数，单独成文件只为可测——`node --test` 只加载 .ts）。
 *
 * 用户的口径（2026-11-05）：
 * - 每天一列，默认 1 格宽；当天有 2 格宽的卡（2x1 / 2x2）那列 2 格；
 * - **格宽 = 可视宽 / 所选天数**（按每列 1 格算，减间距）——所以有 2 格列时一屏装不下所选的天数，
 *   超出的横向滚动（Shift + 滚轮 / 触控板横滑）；
 * - 打开时把今天滚进视野；
 * - 过去的天给运行记录（卡），今天剩下的与未来的天给排好的自动化（灰字）。
 */
import { localDayStart, type BoardPlannedRun, type BoardWeekDay, type BoardWeekItem } from "../../../../shared/plugin-board.ts";
import type { BoardDays } from "../../../../shared/settings.ts";
import { columnCells } from "../plugins/board-layout.ts";

/** 天与天之间的间距（px） */
export const WEEK_DAY_GAP = 12;
/** 一列里格与格之间的间距（BoardGrid 列模式的默认间距，同 board-layout 的 BOARD_GAP_COLUMN） */
export const WEEK_CELL_GAP = 8;
/** 格宽的下限：窗口再窄也不压到这以下（再窄卡里什么也看不清，宁可横滚） */
export const WEEK_CELL_MIN = 96;

export type DayCells = 1 | 2;

/**
 * 格宽：可视宽 / 所选天数，按每列 1 格算，减去天与天之间的间距。取整（卡与 iframe 的 unit 按整数像素更稳）。
 * 可视宽还没量到（0 / NaN）回 WEEK_CELL_MIN，不抛。
 */
export function weekCellWidth(viewportWidth: number, days: BoardDays, dayGap: number = WEEK_DAY_GAP): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return WEEK_CELL_MIN;
  return Math.max(WEEK_CELL_MIN, Math.floor((viewportWidth - dayGap * (days - 1)) / days));
}

/** 一列的像素宽：1 格 = 格宽；2 格 = 两格加中间的格间距。 */
export function dayColumnWidth(cellWidth: number, cells: DayCells, cellGap: number = WEEK_CELL_GAP): number {
  return cells * cellWidth + (cells - 1) * cellGap;
}

export interface WeekColumn {
  /** 周一 = 0 */
  index: number;
  cells: DayCells;
  /** 在滚动内容里的左缘与宽（px） */
  left: number;
  width: number;
}

export interface WeekColumns {
  columns: WeekColumn[];
  /** 整周内容宽（含天间距，不含两侧内边距） */
  totalWidth: number;
}

/** 把每天的格数（1 / 2）铺成列：从左到右依次排，天间距固定。 */
export function layoutWeekColumns(cells: readonly DayCells[], cellWidth: number, dayGap: number = WEEK_DAY_GAP, cellGap: number = WEEK_CELL_GAP): WeekColumns {
  const columns: WeekColumn[] = [];
  let left = 0;
  cells.forEach((count, index) => {
    const width = dayColumnWidth(cellWidth, count, cellGap);
    columns.push({ index, cells: count, left, width });
    left += width + dayGap;
  });
  return { columns, totalWidth: Math.max(0, left - (cells.length > 0 ? dayGap : 0)) };
}

/** 可滚动的最大距离（内容比可视窗窄 = 0）。 */
export function maxScrollLeft(totalWidth: number, viewportWidth: number): number {
  return Math.max(0, totalWidth - Math.max(0, viewportWidth));
}

export function clampScroll(value: number, totalWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, value), maxScrollLeft(totalWidth, viewportWidth));
}

/**
 * 打开时把今天滚进视野：
 * - 今天本来就整列在 0 滚动位置的可视窗里 → 不滚（0）；
 * - 否则让今天**前一天**贴左缘（多看一天昨天的结果）；前一天贴左会把今天挤出右缘（2 格列连着 2 格列）
 *   或今天是周一，就让今天贴左缘；
 * - `edgeInset`：滚动区两侧有内边距，比天间距宽的那部分会让贴左缘的前一天再前一天露出一条边，多滚这么多把它挤出视口；
 * - 夹在 [0, 最大滚动]：今天在周尾时停在最右，今天那列整列可见。
 * 今天不在这一周（翻到别的周）→ 0。
 */
export function scrollToTodayLeft(layout: WeekColumns, viewportWidth: number, todayIndex: number | null, edgeInset = 0): number {
  return clampScroll(todayScrollTarget(layout, viewportWidth, todayIndex, edgeInset), layout.totalWidth, viewportWidth);
}

/** `scrollToTodayLeft` 夹之前的目标位置（今天本来就看得见时为 0）。 */
export function todayScrollTarget(layout: WeekColumns, viewportWidth: number, todayIndex: number | null, edgeInset = 0): number {
  if (todayIndex === null) return 0;
  const today = layout.columns[todayIndex];
  if (today === undefined) return 0;
  if (today.left + today.width <= viewportWidth) return 0;
  const before = layout.columns[todayIndex - 1];
  // edgeInset：滚动区两侧有内边距（> 天间距），贴左缘时前一天会在内边距里露一条边；多滚这么多把它挤出视口
  const aligned = (before === undefined ? today.left : before.left) + edgeInset;
  const fits = today.left + today.width <= aligned + viewportWidth;
  return fits ? aligned : today.left + edgeInset;
}

/** 内容尾部多留的宽度的上限：再多就是一大片空白，不如让前一天老老实实露出来。 */
export const TRAILING_SLACK_MAX = 48;

/**
 * 内容只比可视窗多一点点时（今天在周中、右边的天都不宽），夹到最大滚动会让前一天的前一天露出一条窄边。
 * 在尾部多留一点空白（不超过 TRAILING_SLACK_MAX），让「前一天贴左缘」够得着；缺口大于上限就不留，
 * 那时露出来的是真正的前几天，不是一条边。
 */
export function trailingSlack(layout: WeekColumns, viewportWidth: number, target: number): number {
  const shortage = target - maxScrollLeft(layout.totalWidth, viewportWidth);
  return shortage > 0 && shortage <= TRAILING_SLACK_MAX ? shortage : 0;
}

/** 此刻在可视窗里（哪怕只露一部分）的列区间 [first, last]；没有列回 null。 */
export function visibleColumnRange(layout: WeekColumns, scrollLeft: number, viewportWidth: number): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (const column of layout.columns) {
    const right = column.left + column.width;
    if (right <= scrollLeft || column.left >= scrollLeft + viewportWidth) continue;
    if (first === -1) first = column.index;
    last = column.index;
  }
  return first === -1 ? null : { first, last };
}

/**
 * 哪些天要真的挂卡（每张卡一只沙箱 iframe，一周几十张全挂会很重）：可视窗里的列各向外多挂 `overscan` 天，
 * 让滑动时不是一片空白。没量到可视宽时（0）按最前面的几天挂。
 */
export function mountedDays(layout: WeekColumns, scrollLeft: number, viewportWidth: number, overscan = 1): ReadonlySet<number> {
  const range = visibleColumnRange(layout, scrollLeft, viewportWidth);
  const total = layout.columns.length;
  if (range === null) return new Set(Array.from({ length: Math.min(total, 3) }, (_, index) => index));
  const result = new Set<number>();
  for (let index = Math.max(0, range.first - overscan); index <= Math.min(total - 1, range.last + overscan); index += 1) result.add(index);
  return result;
}

/** 一屏能整列看全的天数（有 2 格列时少于所选天数；用于验证口径与调试）。 */
export function fullyVisibleDays(layout: WeekColumns, scrollLeft: number, viewportWidth: number): number {
  return layout.columns.filter((column) => column.left >= scrollLeft - 0.5 && column.left + column.width <= scrollLeft + viewportWidth + 0.5).length;
}

/**
 * 滚轮 → 横向滚动量。按住 Shift 时把滚轮变横滑：mac 与部分设备在系统层已把 deltaY 换成了 deltaX，
 * 所以取两者里绝对值大的一个。没按 Shift 返回 null（不拦：竖向滚轮照常上下滚，触控板的横滑本来就带 deltaX）。
 */
export function wheelScrollDelta(event: { deltaX: number; deltaY: number; shiftKey: boolean }): number | null {
  if (!event.shiftKey) return null;
  const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  return delta === 0 ? null : delta;
}

// ---------- 一天里画什么 ----------

export type DayPhase = "past" | "today" | "future";

/** 这一天相对 `now` 是过去、今天还是未来（天边界用主进程给的本地 00:00，夏令时那天不是 24 小时）。 */
export function dayPhase(day: Pick<BoardWeekDay, "start" | "end">, now: number): DayPhase {
  if (day.end <= now) return "past";
  if (day.start > now) return "future";
  return "today";
}

/** 今天是这一周的第几天（周一 = 0）；不在这一周为 null。 */
export function todayColumnIndex(days: readonly Pick<BoardWeekDay, "start" | "end">[], now: number): number | null {
  const index = days.findIndex((day) => dayPhase(day, now) === "today");
  return index === -1 ? null : index;
}

/** 一张要画的卡与它所属的那次运行 */
export interface WeekCardRef {
  /** 整周内唯一：运行 id + 卡 id + 序号 */
  key: string;
  item: BoardWeekItem;
  cardIndex: number;
}

export interface DayContent {
  /** 当天各次运行里的卡（按运行时间、卡的原顺序） */
  cards: WeekCardRef[];
  /** 跑过但没有卡的运行（没选插件 / 没调 show_plugin_board / 还在跑）：一行灰字 */
  bare: BoardWeekItem[];
  /** 排好还没到的运行 */
  planned: BoardPlannedRun[];
  /** 这一天的列宽（格数） */
  cells: DayCells;
  /** 什么都没有时整天的一句灰字 */
  empty: "none-ran" | "none-planned" | null;
}

export function dayContent(day: BoardWeekDay, phase: DayPhase): DayContent {
  const cards: WeekCardRef[] = [];
  const bare: BoardWeekItem[] = [];
  for (const item of day.items) {
    if (item.cards.length === 0) {
      bare.push(item);
      continue;
    }
    item.cards.forEach((card, cardIndex) => cards.push({ key: `${item.runId}:${card.id}:${card.index}`, item, cardIndex }));
  }
  const cells = columnCells(cards.map((ref) => ref.item.cards[ref.cardIndex]?.size ?? "1x1"));
  const nothing = cards.length === 0 && bare.length === 0 && day.planned.length === 0;
  return {
    cards,
    bare,
    planned: day.planned,
    cells,
    empty: !nothing ? null : phase === "future" ? "none-planned" : "none-ran",
  };
}

/** 整周完全没有内容（没有运行也没有排期）。 */
export function weekIsBlank(days: readonly BoardWeekDay[]): boolean {
  return days.every((day) => day.items.length === 0 && day.planned.length === 0);
}

// ---------- 标题与时间 ----------

/** 本地 HH:MM（24 小时） */
export function clockLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 「MM/DD」 */
export function dayLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

/** 「11/02 – 11/08」：周一到周日（按日历加天，跨月跨年都对）。 */
export function weekRangeLabel(weekStart: number): string {
  return `${dayLabel(weekStart)} – ${dayLabel(localDayStart(weekStart, 6))}`;
}

/** 翻周：`delta` 周后的当地周一 00:00。 */
export function shiftWeek(weekStart: number, delta: number): number {
  return localDayStart(weekStart, delta * 7);
}

/** 卡上方那行的字：「时间 · 插件名」。插件名取快照的显示名，没有时退到自动化标题。 */
export function cardCaption(item: Pick<BoardWeekItem, "at" | "pluginTitle" | "plugin" | "automationTitle">): string {
  const name = item.pluginTitle ?? item.plugin ?? item.automationTitle;
  return `${clockLabel(item.at)} · ${name}`;
}

/** 灰字行：「08:30 文献追踪」。排好的运行用自动化标题（planned 里只有标题与插件名）。 */
export function plannedLabel(run: Pick<BoardPlannedRun, "at" | "title" | "plugin">): string {
  return `${clockLabel(run.at)} ${run.title}`;
}
