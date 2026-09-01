import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatCostRate, formatTokens } from "./format-tokens.ts";

describe("formatTokens —— pi footer 阶梯的桌面版（一位小数放宽到 100k）", () => {
  test("999 以内原样：小数字不值得缩写", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
  });

  test("1k–100k 一位小数：18.2k / 200k 是批次文档定的演示格式", () => {
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(9499), "9.5k");
    assert.equal(formatTokens(18200), "18.2k");
    assert.equal(formatTokens(99999), "100.0k");
  });

  test("100k–1M 取整 k：余量细度到此为止", () => {
    assert.equal(formatTokens(100000), "100k");
    assert.equal(formatTokens(142000), "142k");
    assert.equal(formatTokens(200000), "200k");
  });

  test("1M 以上一位小数 M，10M 以上取整 M", () => {
    assert.equal(formatTokens(2_500_000), "2.5M");
    assert.equal(formatTokens(25_000_000), "25M");
  });
});

describe("formatCostRate —— 设置面的模型费率段", () => {
  test("单位 $ 每百万 token：<10 两位小数，≥10 一位", () => {
    assert.equal(formatCostRate(0.6), "$0.60/M");
    assert.equal(formatCostRate(2.2), "$2.20/M");
    assert.equal(formatCostRate(0.055), "$0.06/M");
    assert.equal(formatCostRate(15), "$15.0/M");
  });

  test("0 不显示——定价未知 / 不计费不能显示成免费", () => {
    assert.equal(formatCostRate(0), null);
  });
});
