import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { overflowEdges, revealScrollLeft, wheelToScrollDelta } from "./h-scroll.ts";

const wheel = (deltaX: number, deltaY: number, shiftKey = false, deltaMode = 0) => ({
  deltaX,
  deltaY,
  deltaMode,
  shiftKey,
});

describe("滚轮换算成横向滚动", () => {
  it("普通竖滚轮：放得下横滚的条上换成横向", () => {
    deepStrictEqual(wheelToScrollDelta(wheel(0, 40), true), 40);
    deepStrictEqual(wheelToScrollDelta(wheel(0, -40), true), -40);
  });
  it("Shift+竖滚轮（系统没有换轴）：同样换成横向", () => {
    deepStrictEqual(wheelToScrollDelta(wheel(0, 40, true), true), 40);
  });
  it("Shift+滚轮被系统换成了横向（deltaX 占主导）：原样交还浏览器，不重复滚", () => {
    deepStrictEqual(wheelToScrollDelta(wheel(40, 0, true), true), null);
  });
  it("触控板横划：不接管", () => {
    deepStrictEqual(wheelToScrollDelta(wheel(30, 4), true), null);
  });
  it("这一条放得下（不能横滚）：不接管，竖滚轮继续传给外面的滚动区", () => {
    deepStrictEqual(wheelToScrollDelta(wheel(0, 40), false), null);
    deepStrictEqual(wheelToScrollDelta(wheel(0, 40, true), false), null);
  });
  it("行模式的滚轮按 16px 一行换算", () => {
    deepStrictEqual(wheelToScrollDelta(wheel(0, 3, false, 1), true), 48);
  });
});

describe("滚进视野", () => {
  const view = { scrollLeft: 100, clientWidth: 200 };
  it("已完整可见：不动", () => {
    deepStrictEqual(revealScrollLeft(view, { offsetLeft: 150, offsetWidth: 60 }), null);
  });
  it("在左边被裁：滚到它左缘再留一点呼吸，不滚过头到负数", () => {
    deepStrictEqual(revealScrollLeft(view, { offsetLeft: 60, offsetWidth: 60 }), 52);
    deepStrictEqual(revealScrollLeft(view, { offsetLeft: 4, offsetWidth: 60 }), 0);
  });
  it("在右边被裁：滚到它右缘进来", () => {
    deepStrictEqual(revealScrollLeft(view, { offsetLeft: 280, offsetWidth: 60 }), 148);
  });
});

describe("两端淡出", () => {
  it("贴左没有起端淡出，右边还有就有末端淡出", () => {
    deepStrictEqual(overflowEdges({ scrollLeft: 0, clientWidth: 100, scrollWidth: 300 }), { start: false, end: true });
  });
  it("滚到中间两端都有；滚到最右只剩起端；放得下都没有", () => {
    deepStrictEqual(overflowEdges({ scrollLeft: 80, clientWidth: 100, scrollWidth: 300 }), { start: true, end: true });
    deepStrictEqual(overflowEdges({ scrollLeft: 200, clientWidth: 100, scrollWidth: 300 }), { start: true, end: false });
    deepStrictEqual(overflowEdges({ scrollLeft: 0, clientWidth: 100, scrollWidth: 100 }), { start: false, end: false });
  });
});
