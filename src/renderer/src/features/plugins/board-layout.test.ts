import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOARD_CONTAINER_COLUMNS, BOARD_GAP, cardBox, columnCells, columnLayout, containerLayout, gridHeight, placedSpan, rowHeight, unitOf } from "./board-layout.ts";

describe("containerLayout", () => {
  test("一行固定 2 格、间距固定 8，不随容器宽变（没有宽窄门槛）", () => {
    for (const width of [200, 380, 559, 560, 561, 680, 1000, 2000]) {
      const layout = containerLayout(width);
      assert.deepEqual([layout.columns, layout.gap], [BOARD_CONTAINER_COLUMNS, BOARD_GAP], String(width));
    }
    assert.deepEqual([BOARD_CONTAINER_COLUMNS, BOARD_GAP], [2, 8]);
  });

  test("u = (容器宽 − 间距 × (N−1)) ÷ N；格高 = u × 0.9（10:9）", () => {
    const narrow = containerLayout(380);
    assert.equal(narrow.cellWidth, (380 - 8) / 2);
    assert.equal(narrow.cellHeight, narrow.cellWidth * 0.9);
    assert.equal(containerLayout(680).cellWidth, (680 - 8) / 2);
  });

  test("u 随容器宽线性、单调，没有跳变（逐像素扫 200–1600，原先 560 处一格宽会掉一半）", () => {
    let previous = containerLayout(200).cellWidth;
    for (let width = 201; width <= 1600; width += 1) {
      const next = containerLayout(width).cellWidth;
      // 容器宽多 1px，u 恰好多 1/N = 0.5px
      assert.ok(Math.abs(next - previous - 1 / BOARD_CONTAINER_COLUMNS) < 1e-9, `${width}px: ${previous} → ${next}`);
      previous = next;
    }
  });

  test("发给模板的 unit（取整）随容器宽单调不减，相邻两像素差不超过 1", () => {
    let previous = unitOf(containerLayout(200)).width;
    for (let width = 201; width <= 1600; width += 1) {
      const next = unitOf(containerLayout(width)).width;
      assert.ok(next >= previous && next - previous <= 1, `${width}px: ${previous} → ${next}`);
      previous = next;
    }
  });

  test("卡的框宽高由 u 推出：容器宽翻倍，2x2 的框宽 = 2u + 间距，随 u 线性", () => {
    const a = containerLayout(600);
    const b = containerLayout(1200);
    assert.ok(Math.abs(cardBox(b, "2x2").width - (1200 + 0)) < 1e-9); // 2 格卡正好占满容器
    assert.ok(Math.abs(cardBox(a, "2x2").width - 600) < 1e-9);
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
    const layout = containerLayout(680); // 2 列，格宽 336，间距 8
    assert.deepEqual(cardBox(layout, "1x1"), { width: layout.cellWidth, height: layout.cellHeight });
    assert.deepEqual(cardBox(layout, "2x1"), { width: 2 * layout.cellWidth + 8, height: layout.cellHeight });
    assert.deepEqual(cardBox(layout, "1x2"), { width: layout.cellWidth, height: 2 * layout.cellHeight + 8 });
    assert.deepEqual(cardBox(layout, "2x2"), { width: 2 * layout.cellWidth + 8, height: 2 * layout.cellHeight + 8 });
  });

  test("带标题行：1 行高的卡框高不变（标题在框外），多行卡跨过中间的标题行", () => {
    const layout = containerLayout(680, 20);
    assert.equal(cardBox(layout, "1x1").height, layout.cellHeight);
    assert.equal(cardBox(layout, "1x2").height, 2 * layout.cellHeight + 8 + 20);
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
  const layout = containerLayout(680); // 2 列、间距 8
  const narrow = containerLayout(380);

  test("没有卡 = 0；一张 1x1 = 一行；n 行 = n 行高 + (n−1) 个间距", () => {
    assert.equal(gridHeight(layout, []), 0);
    assert.equal(gridHeight(layout, ["1x1"]), layout.cellHeight);
    assert.equal(gridHeight(layout, ["2x2"]), 2 * layout.cellHeight + 8);
    assert.equal(gridHeight(layout, ["1x1", "1x1", "1x1", "1x1", "1x1"]), 3 * layout.cellHeight + 2 * 8);
  });

  test("dense：后面的小卡填进前面大卡旁边的空位，不另起一行", () => {
    // 2 列：2x2 占满两列两行，后面的 1x1 在它下面
    assert.equal(gridHeight(narrow, ["2x2", "1x1", "1x1"]), 3 * narrow.cellHeight + 2 * 8);
    // 1x2 + 1x1 + 1x1：左列两行，右列两行 = 2 行
    assert.equal(gridHeight(narrow, ["1x2", "1x1", "1x1"]), 2 * narrow.cellHeight + 8);
    // 1x1 + 2x1 + 1x1：2x1 放不进第一行剩下的一格，另起一行；最后的 1x1 填回第一行 = 2 行
    assert.equal(gridHeight(narrow, ["1x1", "2x1", "1x1"]), 2 * narrow.cellHeight + 8);
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
