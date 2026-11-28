/**
 * xlsxGridRows / xlsxColumnLabel 的账：合并区摊成跨行跨列、被盖住的格让位并记住锚点
 * 在哪一行（窗口化后要靠它判断要不要画占位格）、只摊请求的那一段、列标按 26 进制进位。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { xlsxColumnLabel, xlsxColumnWidths, xlsxGridRows } from "./xlsx-grid.ts";
import type { XlsxSheet } from "@shared/xlsx";

const sheet = (rows: XlsxSheet["rows"], merges: XlsxSheet["merges"] = []): XlsxSheet => ({
  name: "Sheet1",
  rowCount: rows.length,
  colCount: rows[0]?.length ?? 0,
  merges,
  frozen: { rows: 0, cols: 0 },
  rows,
});

describe("xlsxGridRows", () => {
  test("普通格：有值给 value（1×1），空单元格给 empty", () => {
    const grid = xlsxGridRows(sheet([[{ text: "标题" }, null, { text: "3", numeric: true }]]));
    assert.deepEqual(grid, [
      [
        { kind: "value", cell: { text: "标题" }, rowSpan: 1, colSpan: 1 },
        { kind: "empty" },
        { kind: "value", cell: { text: "3", numeric: true }, rowSpan: 1, colSpan: 1 },
      ],
    ]);
  });

  test("横向合并：锚点跨列，被盖住的格子是 covered（带上锚点行）", () => {
    const grid = xlsxGridRows(
      sheet([[{ text: "区域报表" }, null, null]], [{ top: 0, left: 0, bottom: 0, right: 2 }]),
    );
    assert.deepEqual(grid[0], [
      { kind: "value", cell: { text: "区域报表" }, rowSpan: 1, colSpan: 3 },
      { kind: "covered", anchorRow: 0 },
      { kind: "covered", anchorRow: 0 },
    ]);
  });

  test("纵向合并：锚点跨行，下方被盖住的格子让位", () => {
    const grid = xlsxGridRows(
      sheet(
        [
          [{ text: "华东" }, { text: "1" }],
          [null, { text: "2" }],
        ],
        [{ top: 0, left: 0, bottom: 1, right: 0 }],
      ),
    );
    assert.deepEqual(grid[0]?.[0], { kind: "value", cell: { text: "华东" }, rowSpan: 2, colSpan: 1 });
    assert.deepEqual(grid[1]?.[0], { kind: "covered", anchorRow: 0 });
    assert.deepEqual(grid[1]?.[1], { kind: "value", cell: { text: "2" }, rowSpan: 1, colSpan: 1 });
  });

  test("锚点格里没有值（合并区左上角是空的）也不丢格子：空文本占着跨度", () => {
    const grid = xlsxGridRows(sheet([[null, null]], [{ top: 0, left: 0, bottom: 0, right: 1 }]));
    assert.deepEqual(grid[0]?.[0], { kind: "value", cell: { text: "" }, rowSpan: 1, colSpan: 2 });
    assert.deepEqual(grid[0]?.[1], { kind: "covered", anchorRow: 0 });
  });

  test("只摊请求的那一段：行号与跨度按整表算，返回的只是 [start, end)", () => {
    const rows: XlsxSheet["rows"] = [];
    for (let r = 0; r < 100; r++) rows.push([{ text: `r${r}` }]);
    const grid = xlsxGridRows(sheet(rows), 40, 43);
    assert.equal(grid.length, 3);
    assert.deepEqual(grid[0]?.[0], { kind: "value", cell: { text: "r40" }, rowSpan: 1, colSpan: 1 });
  });

  test("跨过窗口下边界的合并区：rowSpan 裁到本段末尾（没有行可跨）", () => {
    const rows: XlsxSheet["rows"] = [[{ text: "标题" }], [null], [null], [null]];
    const grid = xlsxGridRows(sheet(rows, [{ top: 0, left: 0, bottom: 3, right: 0 }]), 0, 2);
    assert.deepEqual(grid[0]?.[0], { kind: "value", cell: { text: "标题" }, rowSpan: 2, colSpan: 1 });
    assert.deepEqual(grid[1]?.[0], { kind: "covered", anchorRow: 0 });
  });

  test("跨过窗口上边界的合并区：锚点不在本段里，被盖住的格仍报出锚点行", () => {
    const rows: XlsxSheet["rows"] = [[{ text: "标题" }], [null], [null]];
    const grid = xlsxGridRows(sheet(rows, [{ top: 0, left: 0, bottom: 2, right: 0 }]), 1, 3);
    // 锚点在上方（第 0 行）没画：渲染层据此画占位格，而不是让这一行左移
    assert.deepEqual(grid[0]?.[0], { kind: "covered", anchorRow: 0 });
  });
});

describe("xlsxColumnLabel", () => {
  test("前 26 列是 A..Z，第 27 列进位到 AA", () => {
    assert.equal(xlsxColumnLabel(0), "A");
    assert.equal(xlsxColumnLabel(1), "B");
    assert.equal(xlsxColumnLabel(25), "Z");
    assert.equal(xlsxColumnLabel(26), "AA");
    assert.equal(xlsxColumnLabel(27), "AB");
    assert.equal(xlsxColumnLabel(49), "AX");
    assert.equal(xlsxColumnLabel(51), "AZ");
    assert.equal(xlsxColumnLabel(52), "BA");
  });
});

describe("xlsxColumnWidths", () => {
  test("短数字列窄、长文本列宽，都卡在 64–320px 之间", () => {
    const widths = xlsxColumnWidths(
      sheet([
        [{ text: "1" }, { text: "说明" }],
        [{ text: "2024" }, { text: "很长的中文说明文字".repeat(6) }],
      ]),
    );
    assert.equal(widths.length, 2);
    // 4 个字宽 → 4 × 7.2 + 16 ≈ 45，低于下限 64
    assert.equal(widths[0], 64);
    // 长文本 ×2 字宽远不止 320，卡在上限
    assert.equal(widths[1], 320);
  });

  test("CJK 按两个字算宽（等宽字体里它真的占两格）", () => {
    const [ascii] = xlsxColumnWidths(sheet([[{ text: "abcd" }]]));
    const [cjk] = xlsxColumnWidths(sheet([[{ text: "中文说明" }]]));
    assert.ok(cjk !== undefined && ascii !== undefined && cjk > ascii);
  });

  test("空单元格不参与：整列为空时回下限", () => {
    assert.deepEqual(xlsxColumnWidths(sheet([[null, null]])), [64, 64]);
  });
});
