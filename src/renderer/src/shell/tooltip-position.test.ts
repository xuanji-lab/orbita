/**
 * IconButton 自绘 tooltip 定位口径的边界。这些规则会被争论，所以钉住：
 * 优先上方、上方距视口顶不足翻转到下方、水平居中但夹回视口 8px 边距、
 * 锚点整个出视口就不显示（关门信号）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TOOLTIP_EDGE, TOOLTIP_GAP, placeTooltip } from "./tooltip-position.ts";

const anchor = (
  over: Partial<{ top: number; bottom: number; left: number; right: number }> = {},
) => ({ top: 600, bottom: 620, left: 300, right: 360, ...over });
const tooltip = { width: 120, height: 24 };
const viewport = { width: 1200, height: 800 };

describe("placeTooltip —— 优先上方与翻转", () => {
  test("上方放得下：贴着锚点上方展开", () => {
    const placed = placeTooltip(anchor(), tooltip, viewport);
    assert.equal(placed.top, 600 - TOOLTIP_GAP - 24); // top 600 - GAP - tooltip 高
    assert.equal(placed.visible, true);
  });

  test("上方距视口顶不足：翻转到下方", () => {
    // 锚点 top 只有 20：上方放 24 高 + GAP 6 会压过 8px 边距
    const placed = placeTooltip(anchor({ top: 20, bottom: 40 }), tooltip, viewport);
    assert.equal(placed.top, 40 + TOOLTIP_GAP);
  });

  test("上下都放不下：落下方（翻转后的位置）", () => {
    // 20 高的按钮几乎占满 40 高的视口：上方 0 放不下，下方只剩 20 也放不下
    const placed = placeTooltip(
      anchor({ top: 10, bottom: 30 }),
      tooltip,
      { width: 1200, height: 40 },
    );
    assert.equal(placed.top, 30 + TOOLTIP_GAP);
  });
});

describe("placeTooltip —— 水平居中与夹回", () => {
  test("水平居中对齐按钮", () => {
    const placed = placeTooltip(anchor(), tooltip, viewport);
    // 按钮 left 300 / right 360（宽 60），tooltip 宽 120：居中 = 300 + (60 - 120) / 2 = 270
    assert.equal(placed.left, 270);
  });

  test("居中后左溢出：夹回 8px 边距", () => {
    const placed = placeTooltip(anchor({ left: 4, right: 64 }), tooltip, viewport);
    assert.equal(placed.left, TOOLTIP_EDGE);
  });

  test("居中后右溢出：夹回视口右缘 8px", () => {
    const placed = placeTooltip(
      anchor({ left: 1160, right: 1220 }),
      tooltip,
      viewport,
    );
    assert.equal(placed.left, 1200 - 120 - TOOLTIP_EDGE);
  });

  test("tooltip 比视口还宽：夹到 8px，不出现负值", () => {
    const wide = { width: 2000, height: 24 };
    const placed = placeTooltip(anchor(), wide, viewport);
    assert.equal(placed.left, TOOLTIP_EDGE);
  });
});

describe("placeTooltip —— 锚点出视口就关门", () => {
  test("锚点整个滚出视口上方：不显示", () => {
    const placed = placeTooltip(anchor({ top: -80, bottom: -60 }), tooltip, viewport);
    assert.equal(placed.visible, false);
  });

  test("锚点整个滚出视口下方：不显示", () => {
    const placed = placeTooltip(
      anchor({ top: 810, bottom: 830 }),
      tooltip,
      viewport,
    );
    assert.equal(placed.visible, false);
  });
});
