import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { tabPaint } from "./tab-painting.ts";

describe("tabPaint：哪些 tab 绘制、哪些节流", () => {
  it("没显示的用户 tab：不绘制、允许节流（后台动画不再烧 CPU / GPU）", () => {
    deepStrictEqual(tabPaint({ owner: "user", shown: false, busy: false }), { visible: false, throttle: true });
  });

  it("显示中的用户 tab：绘制，但允许节流——浏览器窗口隐藏 / 最小化时由 Chromium 停掉动画", () => {
    deepStrictEqual(tabPaint({ owner: "user", shown: true, busy: false }), { visible: true, throttle: true });
  });

  it("agent 正在读的用户 tab：操作期间恢复绘制、不节流，否则截图是空的", () => {
    deepStrictEqual(tabPaint({ owner: "user", shown: false, busy: true }), { visible: true, throttle: false });
    deepStrictEqual(tabPaint({ owner: "user", shown: true, busy: true }), { visible: true, throttle: false });
  });

  it("agent 的 tab 不管显示与否都照旧：一直绘制、不节流", () => {
    deepStrictEqual(tabPaint({ owner: "agent", shown: false, busy: false }), { visible: true, throttle: false });
    deepStrictEqual(tabPaint({ owner: "agent", shown: true, busy: false }), { visible: true, throttle: false });
  });
});
