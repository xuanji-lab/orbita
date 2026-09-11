/** 速度口径的边界：真值除法、500ms 噪音门（含边界）、0 输出、字符估算。 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { estimateStreamingTokens, messageSpeed, SPEED_MIN_MS } from "./message-speed.ts";

describe("messageSpeed —— 真值除法与噪音门", () => {
  test("正常：output ÷ 生成秒", () => {
    assert.equal(messageSpeed(1_000, 3_000, 1_000), 500);
  });

  test(`不足 ${SPEED_MIN_MS}ms 不当真——除以极小时间会出荒谬瞬时值`, () => {
    assert.equal(messageSpeed(0, SPEED_MIN_MS - 1, 1_000), null);
  });

  test("恰好压线算过门（含边界）", () => {
    assert.equal(messageSpeed(0, SPEED_MIN_MS, 400), 800);
  });

  test("输出 0 不算——0 不是速度，是没产出", () => {
    assert.equal(messageSpeed(0, 5_000, 0), null);
  });
});

describe("estimateStreamingTokens —— 字符估粗账", () => {
  test("字符数 ÷ 4，四舍五入", () => {
    assert.equal(estimateStreamingTokens(1_000), 250);
    assert.equal(estimateStreamingTokens(1_002), 251);
  });

  test("负数与 0 都给 0——估算不出负的 token", () => {
    assert.equal(estimateStreamingTokens(-5), 0);
    assert.equal(estimateStreamingTokens(0), 0);
  });
});
