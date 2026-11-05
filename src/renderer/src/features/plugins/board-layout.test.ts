import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cardBox, columnCells, columnLayout, containerLayout, gridHeight, placedSpan, rowHeight, unitOf } from "./board-layout.ts";

describe("containerLayout", () => {
  test("< 560px 一行 2 格、间距 8；≥ 560px 一行 4 格、间距 10；560 本身算宽", () => {
    assert.deepEqual([containerLayout(380).columns, containerLayout(380).gap], [2, 8]);
    assert.deepEqual([containerLayout(559).columns, containerLayout(559).gap], [2, 8]);
    assert.deepEqual([containerLayout(560).columns, containerLayout(560).gap], [4, 10]);
    assert.deepEqual([containerLayout(1000).columns, containerLayout(1000).gap], [4, 10]);
  });

  test("格宽 = (容器宽 − 间距) / 列数；格高 = 格宽 × 0.9（10:9）", () => {
    const narrow = containerLayout(380);
    assert.equal(narrow.cellWidth, (380 - 8) / 2);
    assert.equal(narrow.cellHeight, narrow.cellWidth * 0.9);
    const wide = containerLayout(680);
    assert.equal(wide.cellWidth, (680 - 30) / 4);
  });

  test("等比缩放：容器宽翻倍（同一档内），格宽、格高、卡的框都等比（间距除外）", () => {
    const a = containerLayout(600);
    const b = containerLayout(1200);
    assert.ok(Math.abs(b.cellWidth / a.cellWidth - (1200 - 30) / (600 - 30)) < 1e-9);
    assert.ok(Math.abs(b.cellHeight / b.cellWidth - 0.9) < 1e-9);
  });

  test("没量到宽度（0 / 负 / NaN / Infinity）：格宽 0，不抛、不出 NaN", () => {
    for (const width of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const layout = containerLayout(width);
      assert.equal(layout.cellWidth >= 0 && Number.isFinite(layout.cellWidth), true, String(width));
      assert.equal(Number.isFinite(layout.cellHeight), true, String(width));
    }
    assert.equal(containerLayout(Number.POSITIVE_INFINITY).columns, 2);
  });
});

describe("cardBox", () => {
  test("1x1 就是一格；2x1 = 两格加一个间距；2x2 的宽高都是两格加一个间距", () => {
    const layout = containerLayout(680); // 格宽 162.5，格高 146.25，间距 10
    assert.deepEqual(cardBox(layout, "1x1"), { width: layout.cellWidth, height: layout.cellHeight });
    assert.deepEqual(cardBox(layout, "2x1"), { width: 2 * layout.cellWidth + 10, height: layout.cellHeight });
    assert.deepEqual(cardBox(layout, "1x2"), { width: layout.cellWidth, height: 2 * layout.cellHeight + 10 });
    assert.deepEqual(cardBox(layout, "2x2"), { width: 2 * layout.cellWidth + 10, height: 2 * layout.cellHeight + 10 });
  });

  test("带标题行：1 行高的卡框高不变（标题在框外），多行卡跨过中间的标题行", () => {
    const layout = containerLayout(680, 20);
    assert.equal(cardBox(layout, "1x1").height, layout.cellHeight);
    assert.equal(cardBox(layout, "1x2").height, 2 * layout.cellHeight + 10 + 20);
    assert.equal(rowHeight(layout), layout.cellHeight + 20);
  });

  test("列模式：1 格列里放宽卡压到列宽；2 格列正常", () => {
    const one = columnLayout({ cellWidth: 100, columns: 1 });
    assert.deepEqual(placedSpan(one, "2x2"), { cols: 1, rows: 2 });
    assert.equal(cardBox(one, "2x1").width, 100);
    const two = columnLayout({ cellWidth: 100, columns: 2, gap: 8 });
    assert.equal(cardBox(two, "2x1").width, 208);
    assert.equal(two.cellHeight, 90);
  });
});

describe("columnCells / columnLayout", () => {
  test("当天有 2 格宽的卡就是 2 格列，否则 1 格；没有卡按 1 格", () => {
    assert.equal(columnCells([]), 1);
    assert.equal(columnCells(["1x1", "1x2"]), 1);
    assert.equal(columnCells(["1x1", "2x1"]), 2);
    assert.equal(columnCells(["2x2"]), 2);
  });

  test("格宽、格高由外面给；没给格高按 10:9；非法格宽按 0", () => {
    assert.deepEqual(
      [columnLayout({ cellWidth: 120, cellHeight: 100, columns: 1 }).cellWidth, columnLayout({ cellWidth: 120, cellHeight: 100, columns: 1 }).cellHeight],
      [120, 100],
    );
    assert.equal(columnLayout({ cellWidth: 200, columns: 2 }).cellHeight, 180);
    assert.equal(columnLayout({ cellWidth: Number.NaN, columns: 1 }).cellWidth, 0);
  });
});

describe("unitOf", () => {
  test("发给模板的一格像素宽高取整", () => {
    assert.deepEqual(unitOf(containerLayout(380)), { width: 186, height: 167 });
  });
});

describe("gridHeight（离开视口的占位高度）", () => {
  const wide = containerLayout(680); // 4 列、间距 10
  const narrow = containerLayout(380); // 2 列、间距 8

  test("没有卡 = 0；一张 1x1 = 一行；n 行 = n 行高 + (n−1) 个间距", () => {
    assert.equal(gridHeight(wide, []), 0);
    assert.equal(gridHeight(wide, ["1x1"]), wide.cellHeight);
    assert.equal(gridHeight(wide, ["2x2"]), 2 * wide.cellHeight + 10);
    assert.equal(gridHeight(wide, ["1x1", "1x1", "1x1", "1x1", "1x1"]), 2 * wide.cellHeight + 10);
  });

  test("dense：后面的小卡填进前面大卡旁边的空位，不另起一行", () => {
    // 2x2 + 2x1 + 1x1 + 1x1 在 4 列里：2x2 占左上，2x1 放右上，两张 1x1 放右下 → 2 行
    assert.equal(gridHeight(wide, ["2x2", "2x1", "1x1", "1x1"]), 2 * wide.cellHeight + 10);
    // 窄屏 2 列：2x2 占满两列两行，后面的 1x1 在它下面
    assert.equal(gridHeight(narrow, ["2x2", "1x1", "1x1"]), 3 * narrow.cellHeight + 2 * 8);
    // 1x2 在 2 列里：1x2 + 1x1 + 1x1 → 左列两行，右列两行 = 2 行
    assert.equal(gridHeight(narrow, ["1x2", "1x1", "1x1"]), 2 * narrow.cellHeight + 8);
  });

  test("宽卡压到列宽（列模式 1 格列里放 2x2）；带标题行时每行加标题高", () => {
    const column = columnLayout({ cellWidth: 100, columns: 1, captionHeight: 22 });
    assert.equal(gridHeight(column, ["2x1", "1x1"]), 2 * (column.cellHeight + 22) + column.gap);
  });

  test("没量到宽度：格高 0，只剩间距，不出 NaN", () => {
    const layout = containerLayout(0);
    assert.equal(gridHeight(layout, ["2x2", "1x1"]), 2 * layout.gap);
  });
});
