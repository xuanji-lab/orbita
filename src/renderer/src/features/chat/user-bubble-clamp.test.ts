import { test } from "node:test";
import assert from "node:assert/strict";
import { BUBBLE_CLAMP_LINES, bubbleClampStyle, isBubbleOverflowing } from "./user-bubble-clamp.ts";

/**
 * 折叠样式的几何口径。锚定的是「最后一行被裁一半」修复的两个不变量：
 * 1. maxHeight 只由 行高 token × 行数 × 1em 构成——**不含任何像素常量**
 *    （旧实现 `calc(1.6em * 4 + 20px)` 把 padding/边框算进高度，而 overflow:hidden
 *    的裁剪边是 padding box，第 5 行上半截落进可见带，即本 bug）；
 * 2. 行高取设计系统 token `--line-height-reading`，不硬编码 1.6（token 改了 clamp 跟着走）。
 */
test("折叠态：maxHeight = 行高 token × 行数 × 1em，overflow hidden", () => {
  const style = bubbleClampStyle(false);
  assert.equal(style.overflow, "hidden");
  assert.equal(style.maxHeight, `calc(var(--line-height-reading) * ${BUBBLE_CLAMP_LINES} * 1em)`);
  // 不许再出现像素常量——padding / 边框进公式就是老 bug 回潮
  assert.equal(/\d+px/.test(String(style.maxHeight)), false);
  // 行高来自 token，不是写死的 1.6
  assert.equal(style.maxHeight.includes("var(--line-height-reading)"), true);
});

test("展开态：不 clamp、不 hidden", () => {
  const style = bubbleClampStyle(true);
  assert.equal("maxHeight" in style, false);
  assert.equal("overflow" in style, false);
});

/** 溢出判定：容差 1px（亚像素舍入不算溢出），超出 1px 以上才算——与实现 `> clientHeight + 1` 同口径。 */
test("溢出判定：恰等于 / 差 1px 不算，超出 1px 以上才算", () => {
  assert.equal(isBubbleOverflowing(96, 96), false);
  assert.equal(isBubbleOverflowing(97, 96), false);
  assert.equal(isBubbleOverflowing(97.5, 96), true);
  assert.equal(isBubbleOverflowing(98, 96), true);
  assert.equal(isBubbleOverflowing(162, 96), true);
});
