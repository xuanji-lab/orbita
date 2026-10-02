/**
 * 俄罗斯方块材料区的纯逻辑：方块尺寸（类型 / 内容量 → 列跨度、行跨度）与
 * dense 排布的行数模拟（决定折叠态要不要「展开」一行）。
 *
 * 消费者是 MaterialTetris.tsx（设置 › 游戏化 › 材料区俄罗斯方块开启时的材料区），
 * 这里不碰 DOM：宽度按字符估（全宽 13px、半宽 7.2px，caption 12px 字号的实测近似），
 * 格子是常量——估宽只为「长内容占宽块」，差一两像素由省略号吸收，不值得量 DOM。
 *
 * 形状语言（对照 mock「二 · 俄罗斯方块」）：截图 2×2 正方形，引用是长条，
 * 长粘贴 2 行高（块内带两行预览），文件宽度跟名字长度走。
 */

/** 一格的边长与格间距（px）。1 行的块高 = 格边长，与现有 chip 的 28px 高近邻 */
export const TETRIS_CELL_PX = 30;
export const TETRIS_GAP_PX = 4;
/** 一格占用的步进（格边长 + 间距）：估宽换列数、容器宽换列数都用它 */
export const TETRIS_STEP_PX = TETRIS_CELL_PX + TETRIS_GAP_PX;
/** 折叠态最多显示的行数；超出折成「还有 N 个材料」展开行 */
export const TETRIS_MAX_ROWS = 4;
/** 粘贴文本超过这个行数占 2 行高（带两行预览）；以内占 1 行 */
export const TETRIS_PASTED_TALL_LINES = 100;
/** 「还有 N 个材料」展开行自己占的列数 */
export const TETRIS_MORE_COLS = 3;

/** 全宽字符（CJK、全角标点）与半宽字符的估宽（px） */
const CHAR_WIDE_PX = 13;
const CHAR_NARROW_PX = 7.2;

/** 文本估宽（px）。码位 > 0x2e80 起按全宽算（CJK 与注音、假名都在其上） */
export function textWidthPx(text: string): number {
  let px = 0;
  for (const ch of text) px += ch.codePointAt(0)! > 0x2e80 ? CHAR_WIDE_PX : CHAR_NARROW_PX;
  return px;
}

/** 估宽 → 列数：向上取整，夹在 [min, max] */
function columnsFor(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.ceil(px / TETRIS_STEP_PX)));
}

/** 截图：2×2 正方形——图是唯一认得出内容的材料，给它一个稳的锚点形状 */
export function imageSpan(): { col: number; row: number } {
  return { col: 2, row: 2 };
}

/** 文件 / 目录：宽度跟名字走。图标 + 名字 + 移除键的固定chrome 约 60px */
export function fileSpan(name: string): { col: number; row: number } {
  return { col: columnsFor(textWidthPx(name) + 60, 3, 10), row: 1 };
}

/** 粘贴文本：长粘贴占 2 行高（第二行是预览），短的占 1 行；宽度固定 */
export function pastedSpan(lines: number): { col: number; row: number } {
  return lines > TETRIS_PASTED_TALL_LINES ? { col: 6, row: 2 } : { col: 5, row: 1 };
}

/** 引用：长条。长度按正文估，短引也有 7 格的最小长度——「引用是长条」是它的形状语言 */
export function quoteSpan(text: string): { col: number; row: number } {
  // chrome：图标 + 编号角标 + meta（「第几轮 · 谁 · 字数」）+ 移除键，约 150px
  return { col: columnsFor(textWidthPx(text) + 150, 7, 14), row: 1 };
}

/** 容器宽 → 能容下的列数（grid 用 auto-fill，同一算式在 JS 里重算给排布模拟用） */
export function columnsForWidth(containerPx: number): number {
  return Math.max(1, Math.floor((containerPx + TETRIS_GAP_PX) / TETRIS_STEP_PX));
}

/**
 * 模拟 `grid-auto-flow: row dense` 的排布，返回每个块的落位（行、列，0 起）。
 *
 * dense 的语义：按 DOM 顺序逐个放，每个找**最早能放下的洞**（行优先扫描），
 * 早先行数不一留下的洞会被后面的小块补上。用位图直白模拟：放一个 w×h 的块，
 * 就是从第一行起扫第一个「连续 w 列、连续 h 行都空闲」的矩形区。
 *
 * 落位是「展开 / 收起」的判定源：折叠态只渲染落位完全在前 4 行内的块
 * （而不是 CSS 裁切——不出现半截块）；行数 > TETRIS_MAX_ROWS 才显示展开行。
 */
export function packPlacements(
  spans: readonly { col: number; row: number }[],
  columns: number,
): { row: number; col: number }[] {
  // occupied[r][c] = 第 r 行第 c 列是否已占。行按需长（ensureRow）
  const occupied: boolean[][] = [];
  const ensureRow = (row: number): boolean[] => {
    while (occupied.length <= row) occupied.push(new Array<boolean>(columns).fill(false));
    return occupied[row] ?? [];
  };
  const fits = (row: number, col: number, colSpan: number, rowSpan: number): boolean => {
    if (col + colSpan > columns) return false;
    for (let r = row; r < row + rowSpan; r++) {
      const cells = ensureRow(r);
      for (let c = col; c < col + colSpan; c++) {
        if (cells[c] === true) return false;
      }
    }
    return true;
  };
  const placements: { row: number; col: number }[] = [];
  for (const span of spans) {
    const colSpan = Math.min(span.col, columns);
    const rowSpan = span.row;
    let placed = false;
    for (let row = 0; !placed; row++) {
      for (let col = 0; col <= columns - colSpan; col++) {
        if (fits(row, col, colSpan, rowSpan)) {
          for (let r = row; r < row + rowSpan; r++) {
            const cells = ensureRow(r);
            for (let c = col; c < col + colSpan; c++) cells[c] = true;
          }
          placements.push({ row, col });
          placed = true;
          break;
        }
      }
    }
  }
  return placements;
}

/** dense 排布占满后的总行数（packPlacements 的行数摘要） */
export function packedRows(
  spans: readonly { col: number; row: number }[],
  columns: number,
): number {
  const placements = packPlacements(spans, columns);
  let rows = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const at = placements[i];
    if (span === undefined || at === undefined) continue;
    rows = Math.max(rows, at.row + span.row);
  }
  return rows;
}
