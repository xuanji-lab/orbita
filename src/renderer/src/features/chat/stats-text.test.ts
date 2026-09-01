import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { contextText, contextTone, costText, statsTitleText } from "./stats-text.ts";

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
