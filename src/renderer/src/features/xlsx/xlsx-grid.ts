/**
 * `.xlsx` 预览的**纯视图函数**（把合并区间摊成每格的跨行跨列）。独立成模块而不是塞进
 * XlsxView.tsx，理由同 preview-view.ts：组件要连 IPC + React state，这里只留纯函数，
 * `node --test` 直接可测。
 *
 * **只摊要画的那一段**（`start`–`end`）：2000 × 50 的窗口一次画出来是 10 万个 <td>，
 * 实测首帧要好几秒（Chromium 在 10 万格的表上建 DOM + 排版就是这么慢），所以渲染层按
 * 滚动位置只取可见的几十行（见 XlsxView 的 XlsxGrid）。摊格子的逻辑本身与窗口无关，
 * 跨窗口边界的合并区按下面各条规则退化。
 */
import type { XlsxCell, XlsxSheet } from "@shared/xlsx";

/**
 * 一格怎么画：
 * - empty   空单元格（画一个空格子，占位）
 * - value   有值 / 合并区锚点（带跨行跨列）
 * - covered 被合并区盖住：锚点在本段里时整格不画（跨度已把它占了）；锚点在本段之上
 *           （合并区跨过了窗口上边界）时画一个空格子占位，否则这一行的格子会左移
 */
export type XlsxGridSlot =
  | { kind: "empty" }
  | { kind: "value"; cell: XlsxCell; rowSpan: number; colSpan: number }
  | { kind: "covered"; anchorRow: number };

/**
 * 取 `[start, end)` 这几行的画法。`merge.rows`（整表的行）是 0-based，与返回数组的
 * 下标无关：行号由调用方按 `start + index` 算。
 */
export function xlsxGridRows(
  sheet: XlsxSheet,
  start = 0,
  end = sheet.rows.length,
): XlsxGridSlot[][] {
  const width = sheet.rows[0]?.length ?? 0;
  const from = Math.max(0, Math.min(start, sheet.rows.length));
  const to = Math.max(from, Math.min(end, sheet.rows.length));

  // 合并区先摊成两张表：锚点 → 跨度；被盖住的格 → 锚点所在行
  const spans = new Map<number, { rowSpan: number; colSpan: number }>();
  const covered = new Map<number, number>();
  for (const merge of sheet.merges) {
    if (merge.top >= sheet.rows.length || merge.left >= width) continue;
    // 锚点的跨度裁到本段的末尾：rowSpan 越过 tbody 底部没有行可跨
    const rowSpan = Math.min(merge.bottom, to - 1) - merge.top + 1;
    if (rowSpan <= 0) continue;
    spans.set(merge.top * width + merge.left, { rowSpan, colSpan: merge.right - merge.left + 1 });
    for (let row = merge.top; row <= merge.bottom; row++) {
      for (let col = merge.left; col <= merge.right; col++) {
        if (row !== merge.top || col !== merge.left) covered.set(row * width + col, merge.top);
      }
    }
  }

  const rows: XlsxGridSlot[][] = [];
  for (let row = from; row < to; row++) {
    const cells = sheet.rows[row] ?? [];
    rows.push(
      cells.map((cell, col): XlsxGridSlot => {
        const key = row * width + col;
        const anchorRow = covered.get(key);
        if (anchorRow !== undefined) return { kind: "covered", anchorRow };
        const span = spans.get(key);
        if (span !== undefined) {
          return { kind: "value", cell: cell ?? { text: "" }, rowSpan: span.rowSpan, colSpan: span.colSpan };
        }
        if (cell === null) return { kind: "empty" };
        return { kind: "value", cell, rowSpan: 1, colSpan: 1 };
      }),
    );
  }
  return rows;
}

/**
 * 列标：0 → A、25 → Z、26 → AA（Excel 的列头写法）。只算前 50 列，但公式照写全
 * （26 进制，无 0 位——A=1）。
 */
export function xlsxColumnLabel(index: number): string {
  let label = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    rest = Math.floor((rest - 1) / 26);
  }
  return label;
}

/** 等宽字体下一个半角字符约 7.2px（12px 字号）；CJK 占两个 */
const CHAR_WIDTH = 7.2;
/** 单元格左右内边距之和（与 styles.css 的 `.xlsx-table td` 一致：--space-2 × 2） */
const CELL_PADDING = 16;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 320;

/** 显示宽度：全角 / CJK 字符算两个字（等宽字体下它们真的是两倍宽） */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return width;
}

/**
 * 每列多宽：按这列里最长的显示值估（等宽字体下字宽可算，不必让浏览器量）。
 * 宽了浪费横向空间（50 列的表只剩三列可见），窄了截断——所以卡在 64–320px，
 * 更长的文本靠省略号 + tooltip。列宽固定还让「换渲染窗口」不必重算整表宽度。
 *
 * 只拿返回的这段数据估（最多 2000 行）：被裁掉的行不参与，这是面板的尺度。
 */
export function xlsxColumnWidths(sheet: XlsxSheet): number[] {
  const columns = sheet.rows[0]?.length ?? 0;
  const widths = Array.from({ length: columns }, () => MIN_COLUMN_WIDTH);
  for (const row of sheet.rows) {
    for (let col = 0; col < columns; col++) {
      const current = widths[col] ?? MIN_COLUMN_WIDTH;
      if (current >= MAX_COLUMN_WIDTH) continue;
      const text = row[col]?.text;
      if (text === undefined || text === "") continue;
      const needed = Math.min(MAX_COLUMN_WIDTH, displayWidth(text) * CHAR_WIDTH + CELL_PADDING);
      if (needed > current) widths[col] = needed;
    }
  }
  return widths;
}
