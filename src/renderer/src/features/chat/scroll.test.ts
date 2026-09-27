import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BOTTOM_THRESHOLD_PX, SCROLL_DOWN_THRESHOLD_PX, isAtBottom, isBeyondScrollDown, shouldJumpToEnd } from "./scroll.ts";

describe("isAtBottom", () => {
  test("恰好在底部", () => {
    // 视口 600，内容 2000，滚到底：scrollTop = 1400
    assert.equal(isAtBottom(1400, 600, 2000), true);
  });

  test("容差之内仍算在底部", () => {
    // 距底 20px < 40px 容差
    assert.equal(isAtBottom(1380, 600, 2000), true);
    assert.equal(isAtBottom(1400 - BOTTOM_THRESHOLD_PX, 600, 2000), true);
  });

  test("超出容差即脱离", () => {
    assert.equal(isAtBottom(1400 - BOTTOM_THRESHOLD_PX - 1, 600, 2000), false);
    // 明显在上面
    assert.equal(isAtBottom(0, 600, 2000), false);
  });

  test("内容不足一屏时恒为在底部", () => {
    // 无处可滚，scrollTop 恒为 0
    assert.equal(isAtBottom(0, 600, 300), true);
  });
});

describe("isBeyondScrollDown", () => {
  test("阈值以内不浮现（含恰好 300 的边界）", () => {
    assert.equal(isBeyondScrollDown(0), false);
    assert.equal(isBeyondScrollDown(299), false);
    assert.equal(isBeyondScrollDown(SCROLL_DOWN_THRESHOLD_PX), false);
  });

  test("超过阈值即浮现", () => {
    assert.equal(isBeyondScrollDown(SCROLL_DOWN_THRESHOLD_PX + 1), true);
    assert.equal(isBeyondScrollDown(1200), true);
  });
});

describe("shouldJumpToEnd", () => {
  const mods = { ctrl: false, meta: false, alt: false, shift: false };

  test("End + 无修饰键 + 焦点不在文本框 → 接管", () => {
    assert.equal(shouldJumpToEnd("End", mods, { tagName: "DIV", isContentEditable: false }), true);
    assert.equal(shouldJumpToEnd("End", mods, { tagName: "BODY", isContentEditable: false }), true);
  });

  test("焦点在文本框里不接管——composer 里 End 是行尾光标", () => {
    assert.equal(shouldJumpToEnd("End", mods, { tagName: "TEXTAREA", isContentEditable: false }), false);
    assert.equal(shouldJumpToEnd("End", mods, { tagName: "INPUT", isContentEditable: false }), false);
    assert.equal(shouldJumpToEnd("End", mods, { tagName: "DIV", isContentEditable: true }), false);
  });

  test("tagName 大小写不敏感", () => {
    assert.equal(shouldJumpToEnd("End", mods, { tagName: "textarea", isContentEditable: false }), false);
  });

  test("带修饰键不接管——组合键各有各的语义", () => {
    assert.equal(shouldJumpToEnd("End", { ...mods, ctrl: true }, { tagName: "DIV", isContentEditable: false }), false);
    assert.equal(shouldJumpToEnd("End", { ...mods, meta: true }, { tagName: "DIV", isContentEditable: false }), false);
    assert.equal(shouldJumpToEnd("End", { ...mods, alt: true }, { tagName: "DIV", isContentEditable: false }), false);
    assert.equal(shouldJumpToEnd("End", { ...mods, shift: true }, { tagName: "DIV", isContentEditable: false }), false);
  });

  test("非 End 键不接管", () => {
    assert.equal(shouldJumpToEnd("Home", mods, { tagName: "DIV", isContentEditable: false }), false);
    assert.equal(shouldJumpToEnd("a", mods, { tagName: "DIV", isContentEditable: false }), false);
  });
});
