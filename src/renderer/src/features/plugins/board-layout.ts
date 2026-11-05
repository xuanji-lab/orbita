/**
 * 看板的布局计算（纯函数，BoardGrid 与全局周看板共用；单独成文件只为可测）。
 *
 * 一格的宽高比固定（10 : 9）；卡有四档（1x1 / 2x1 / 1x2 / 2x2，单位是格），占几格就是几格宽高加上中间的间距。
 * 两种模式：
 * - **容器**（详情页、右栏看板、会话结果）：容器宽 < 560px 一行 2 格，否则 4 格；格宽 = (容器宽 − 间距) / 列数，
 *   窗口放大缩小时等比缩放；
 * - **列**（全局周看板里的一天）：格宽（可选格高）由外面给，列宽 = 当天最宽的卡（1 或 2 格）。
 * 卡上方可以带宿主画的一行标题（`captionHeight`）：它属于格的一部分，多格卡的框跨过中间各行的标题行。
 */
import { BOARD_CELL_RATIO, boardCardSpan, type BoardCardSize } from "../../../../shared/plugin-board.ts";

/** 容器宽低于它一行放 2 格，否则 4 格。 */
export const BOARD_NARROW_BELOW = 560;
/** 容器模式的间距：窄 8、宽 10。 */
export const BOARD_GAP_NARROW = 8;
export const BOARD_GAP_WIDE = 10;
/** 列模式的默认间距。 */
export const BOARD_GAP_COLUMN = 8;

export interface BoardLayout {
  /** 一行几格 */
  columns: number;
  /** 格与格之间的像素 */
  gap: number;
  /** 一格的像素宽高（发给模板的 `unit`；等比取字号用它） */
  cellWidth: number;
  cellHeight: number;
  /** 每张卡上方宿主画的标题行高度；没有为 0 */
  captionHeight: number;
}

export interface BoardBox {
  width: number;
  height: number;
}

/** 容器模式：按容器宽算。容器还没量到（0 / 负 / NaN）按一格 0 处理，不抛。 */
export function containerLayout(width: number, captionHeight = 0): BoardLayout {
  const usable = Number.isFinite(width) && width > 0 ? width : 0;
  const columns = usable < BOARD_NARROW_BELOW ? 2 : 4;
  const gap = usable < BOARD_NARROW_BELOW ? BOARD_GAP_NARROW : BOARD_GAP_WIDE;
  const cellWidth = Math.max(0, (usable - gap * (columns - 1)) / columns);
  return { columns, gap, cellWidth, cellHeight: cellWidth * (BOARD_CELL_RATIO.height / BOARD_CELL_RATIO.width), captionHeight };
}

/** 列模式：格宽由外面给（格高不给就按 10:9），列宽 = `columns` 格（1 或 2，通常取 `columnCells(当天的卡)`）。 */
export function columnLayout(args: { cellWidth: number; cellHeight?: number; columns: 1 | 2; gap?: number; captionHeight?: number }): BoardLayout {
  const cellWidth = Number.isFinite(args.cellWidth) && args.cellWidth > 0 ? args.cellWidth : 0;
  return {
    columns: args.columns,
    gap: args.gap ?? BOARD_GAP_COLUMN,
    cellWidth,
    cellHeight: args.cellHeight ?? cellWidth * (BOARD_CELL_RATIO.height / BOARD_CELL_RATIO.width),
    captionHeight: args.captionHeight ?? 0,
  };
}

/** 一天的列宽：当天有 2 格宽的卡（2x1 / 2x2）就是 2 格，否则 1 格；没有卡按 1 格。 */
export function columnCells(sizes: readonly BoardCardSize[]): 1 | 2 {
  return sizes.some((size) => boardCardSpan(size).cols >= 2) ? 2 : 1;
}

/** 一张卡实际占几列几行：列比卡窄（列模式 1 格列里放了宽卡）时压到列宽。 */
export function placedSpan(layout: BoardLayout, size: BoardCardSize): { cols: number; rows: number } {
  const span = boardCardSpan(size);
  return { cols: Math.min(span.cols, layout.columns), rows: span.rows };
}

/** 一张卡的框（不含卡上方的标题行）的像素宽高。 */
export function cardBox(layout: BoardLayout, size: BoardCardSize): BoardBox {
  const { cols, rows } = placedSpan(layout, size);
  return {
    width: cols * layout.cellWidth + (cols - 1) * layout.gap,
    // 多行的卡跨过中间各行的标题行；最上面那行的标题在框外
    height: rows * layout.cellHeight + (rows - 1) * (layout.gap + layout.captionHeight),
  };
}

/** 网格一行的高度（含标题行）。 */
export function rowHeight(layout: BoardLayout): number {
  return layout.cellHeight + layout.captionHeight;
}

/** 发给模板的 `unit`：一格的像素宽高，取整（模板按它等比取字号，小数没有意义）。 */
export function unitOf(layout: BoardLayout): { width: number; height: number } {
  return { width: Math.round(layout.cellWidth), height: Math.round(layout.cellHeight) };
}

/**
 * 一组卡排好后整块网格的像素高（`grid-auto-flow: row dense` 的逐张放置：每张卡从第一行第一列起找第一个放得下的位置）。
 * 会话里的看板离开视口后卸掉 iframe，占位用它算高度——和真实排版差不到 1px，对话滚动因此不跳。
 */
export function gridHeight(layout: BoardLayout, sizes: readonly BoardCardSize[]): number {
  const occupied: boolean[][] = [];
  let rows = 0;
  for (const size of sizes) {
    const span = placedSpan(layout, size);
    let placed = false;
    for (let row = 0; !placed; row += 1) {
      for (let col = 0; col + span.cols <= layout.columns && !placed; col += 1) {
        let free = true;
        for (let r = row; r < row + span.rows && free; r += 1) {
          for (let c = col; c < col + span.cols; c += 1) {
            if (occupied[r]?.[c] === true) {
              free = false;
              break;
            }
          }
        }
        if (!free) continue;
        for (let r = row; r < row + span.rows; r += 1) {
          const line = (occupied[r] ??= []);
          for (let c = col; c < col + span.cols; c += 1) line[c] = true;
        }
        rows = Math.max(rows, row + span.rows);
        placed = true;
      }
    }
  }
  return rows === 0 ? 0 : rows * rowHeight(layout) + (rows - 1) * layout.gap;
}
