import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isWindowInactive } from "./window-activity.ts";

describe("isWindowInactive", () => {
  it("有焦点且可见——不暂停", () => {
    strictEqual(isWindowInactive({ hasFocus: true, visibilityState: "visible" }), false);
  });
  it("失焦——即使 visibilityState 仍是 visible 也暂停（窗口切走但没被系统判 hidden）", () => {
    strictEqual(isWindowInactive({ hasFocus: false, visibilityState: "visible" }), true);
  });
  it("visibilityState 是 hidden——即使 hasFocus 仍报 true 也暂停", () => {
    strictEqual(isWindowInactive({ hasFocus: true, visibilityState: "hidden" }), true);
  });
  it("两者都不活跃——暂停", () => {
    strictEqual(isWindowInactive({ hasFocus: false, visibilityState: "hidden" }), true);
  });
});
