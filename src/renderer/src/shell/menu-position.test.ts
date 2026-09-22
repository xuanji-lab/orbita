/**
 * 菜单定位口径的边界。这些规则会被争论，所以钉住：
 * 默认向下、下方装不下且上方装得下才翻上去、横向宁可不对齐也不出屏、
 * 锚点整个出视口就不该再跟着走（关门信号）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { placeMenu } from "./menu-position.ts";

const anchor = (over: Partial<{ top: number; bottom: number; left: number; right: number }> = {}) => ({
  top: 600,
  bottom: 620,
  left: 300,
  right: 360,
  width: 60,
  height: 20,
  ...over,
});
const menu = { width: 200, height: 120 };
const viewport = { width: 1200, height: 800 };

describe("placeMenu —— 默认向下与翻转", () => {
  test("下方装得下：贴着锚点下方展开", () => {
    const placed = placeMenu(anchor(), menu, "start", viewport);
    assert.equal(placed.top, 626); // bottom 620 + GAP 6
    assert.equal(placed.visible, true);
  });

  test("下方装不下、上方装得下：翻上去", () => {
    // 锚点在 780，下方只剩 20px，菜单 120 高装不下；上方很空
    const placed = placeMenu(anchor({ top: 780, bottom: 790 }), menu, "start", {
      width: 1200,
      height: 800,
    });
    assert.equal(placed.top, 780 - 6 - 120);
  });

  test("上下都装不下：宁向下不悬空——菜单至少锚在下方", () => {
    // 视口 100 高，锚点在 50：下方 44px、上方 44px 都装不下 120 的菜单
    const placed = placeMenu(anchor({ top: 50, bottom: 60 }), menu, "start", {
      width: 1200,
      height: 100,
    });
    assert.equal(placed.top, 66);
  });
});

describe("placeMenu —— 横向夹回", () => {
  test("end 对齐：菜单右缘贴锚点右缘", () => {
    const placed = placeMenu(anchor({ left: 300, right: 360 }), { width: 200, height: 120 }, "end", viewport);
    assert.equal(placed.left, 160); // right 360 - width 200
  });

  test("右缘出屏：夹回窗口边（宁可不对齐）", () => {
    const placed = placeMenu(anchor({ left: 1100, right: 1180 }), { width: 200, height: 120 }, "start", viewport);
    assert.equal(placed.left, 1200 - 200 - 8);
  });

  test("左缘出屏：夹在 EDGE 上", () => {
    const placed = placeMenu(anchor({ left: 3, right: 63 }), { width: 200, height: 120 }, "end", viewport);
    assert.equal(placed.left, 8);
  });
});

describe("placeMenu —— 开在右侧（side=right）", () => {
  test("右侧装得下：左缘贴锚点右缘 + GAP，顶边与行顶对齐", () => {
    const placed = placeMenu(anchor({ top: 200, bottom: 232, left: 12, right: 280 }), menu, "end", viewport, "right");
    assert.equal(placed.left, 286); // right 280 + GAP 6
    assert.equal(placed.top, 200); // 与行顶齐平，不是行底
    assert.equal(placed.visible, true);
  });

  test("右侧装不下：回落到下方那套（含 align 对齐与夹回）", () => {
    // 视口 400 宽、锚点右缘 280：286 + 200 + 8 = 494 > 400
    const narrow = { width: 400, height: 800 };
    const placed = placeMenu(anchor({ top: 200, bottom: 232, left: 12, right: 280 }), menu, "end", narrow, "right");
    assert.equal(placed.top, 238); // bottom 232 + GAP 6
    assert.equal(placed.left, 80); // end 对齐：right 280 - width 200
  });

  test("贴着视口底的行：纵向夹回，菜单尾巴不出屏", () => {
    const placed = placeMenu(anchor({ top: 760, bottom: 792, left: 12, right: 280 }), menu, "end", viewport, "right");
    assert.equal(placed.left, 286);
    assert.equal(placed.top, 800 - 120 - 8);
  });

  test("菜单比视口还高：保住顶边（宁可截尾，不截头）", () => {
    const placed = placeMenu(anchor({ top: 40, bottom: 72, left: 12, right: 280 }), { width: 200, height: 900 }, "end", viewport, "right");
    assert.equal(placed.top, 8);
  });

  test("缺省仍是下方——右侧是会话行点名要的，不是全局默认", () => {
    const placed = placeMenu(anchor({ top: 200, bottom: 232, left: 12, right: 280 }), menu, "end", viewport);
    assert.equal(placed.top, 238);
  });
});

describe("placeMenu —— 锚点出视口就是关门信号", () => {
  test("锚点整个滚出上方（bottom ≤ 0）：visible=false", () => {
    const placed = placeMenu(anchor({ top: -80, bottom: -60 }), menu, "start", viewport);
    assert.equal(placed.visible, false);
  });

  test("锚点整个滚出下方（top ≥ 视口高）：visible=false", () => {
    const placed = placeMenu(anchor({ top: 810, bottom: 830 }), menu, "start", viewport);
    assert.equal(placed.visible, false);
  });

  test("锚点还在屏内（哪怕被裁掉一半）：照常跟随", () => {
    const placed = placeMenu(anchor({ top: -10, bottom: 10 }), menu, "start", viewport);
    assert.equal(placed.visible, true);
    assert.equal(placed.top, 16);
  });
});
