import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { contextText, contextTone, costText, formatTokens, statsTitleText } from "./stats-text.ts";

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

describe("contextText —— 上下文余量段", () => {
  test("有 tokens：用量 / 窗口", () => {
    assert.equal(
      contextText({ tokens: 18200, contextWindow: 200000, percent: 9.1 }),
      "18.2k / 200k",
    );
  });

  test("tokens 为 null（刚压缩完）：诚实未知，不显示过期数字", () => {
    assert.equal(contextText({ tokens: null, contextWindow: 200000, percent: null }), "? / 200k");
  });
});

describe("costText —— 花费段", () => {
  test("3 位小数：短会话的亚分级花费有意义", () => {
    assert.equal(costText(0.062), "$0.062");
    assert.equal(costText(1.5), "$1.500");
  });

  test("0 与负数不显示——自建网关定价未知，$0.000 会误读为免费", () => {
    assert.equal(costText(0), null);
    assert.equal(costText(-1), null);
  });
});

describe("contextTone —— 配色阈值（颜色是第二信号）", () => {
  test("null 不叫唤：? 不染红", () => {
    assert.equal(contextTone(null), "default");
  });

  test("70 / 90 是边界：过线才变", () => {
    assert.equal(contextTone(70), "default");
    assert.equal(contextTone(70.1), "warning");
    assert.equal(contextTone(90), "warning");
    assert.equal(contextTone(90.1), "danger");
    assert.equal(contextTone(99.9), "danger");
  });
});

describe("statsTitleText —— hover 分项（原生 title）", () => {
  test("四行英文标签，token 走紧凑格式", () => {
    const stats: SessionStats = {
      sessionFile: undefined,
      sessionId: "A",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 18200, output: 4100, cacheRead: 120000, cacheWrite: 5100, total: 147400 },
      cost: 0.062,
    };
    assert.equal(
      statsTitleText(stats),
      "input 18.2k\noutput 4.1k\ncache read 120k\ncache write 5.1k",
    );
  });
});
