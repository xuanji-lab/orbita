import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BOTTOM_THRESHOLD_PX, isAtBottom } from "./scroll.ts";

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
