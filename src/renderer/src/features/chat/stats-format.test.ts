/**
 * 用量显示口径的边界（A-1）。这几条规则会被争论，所以钉住：
 * 「不知道」不能显示成 0、定价未知不能显示成免费、缓存全零不进菜单。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentStats } from "@shared/agent-ipc";
import { contextRing, usageBreakdown } from "./stats-format.ts";

const stats = (over: Partial<AgentStats> = {}): AgentStats => ({
  tokens: { input: 18200, output: 4100, cacheRead: 0, cacheWrite: 0, total: 22300 },
  cost: 0.062,
  contextUsage: { tokens: 18200, contextWindow: 200_000, percent: 9 },
  ...over,
});

describe("contextRing —— 不知道就别画", () => {
  test("正常占用给出弧长与人话", () => {
    const ring = contextRing(stats());
    assert.equal(ring.fill, 18200 / 200_000);
    assert.equal(ring.tone, "neutral");
    assert.match(ring.label, /18\.2k \/ 200k · 9%/);
  });

  test("stats 为 null：只画底环，label 说未知", () => {
    const ring = contextRing(null);
    assert.equal(ring.fill, null);
    assert.equal(ring.tone, "neutral");
    assert.match(ring.label, /unknown/);
  });

  test("压缩刚完（tokens 为 null）：只画底环，**不画 0**", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }));
    assert.equal(ring.fill, null);
    assert.match(ring.label, /unknown/);
  });

  test("contextUsage 整个缺席也是未知", () => {
    assert.equal(contextRing(stats({ contextUsage: null })).fill, null);
  });

  test("contextWindow 为 0 不做除法，退回未知", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: 100, contextWindow: 0, percent: null } }));
    assert.equal(ring.fill, null);
  });

  test("过七成 warning、过九成 danger——颜色是第二信号", () => {
    const at = (percent: number) =>
      contextRing(stats({ contextUsage: { tokens: percent * 2000, contextWindow: 200_000, percent } })).tone;
    assert.equal(at(70), "neutral");
    assert.equal(at(71), "warning");
    assert.equal(at(90), "warning");
    assert.equal(at(91), "danger");
  });

  test("占用超窗口也不超过一整圈", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: 400_000, contextWindow: 200_000, percent: 200 } }));
    assert.equal(ring.fill, 1);
    assert.equal(ring.tone, "danger");
  });
});

describe("usageBreakdown —— 菜单里那几行", () => {
  test("没有 stats 就没有行", () => {
    assert.deepEqual(usageBreakdown(null), []);
  });

  test("缓存读写单列，不折进 total——那是「为什么比看起来便宜」的答案", () => {
    assert.deepEqual(
      usageBreakdown(stats()).map((r) => r.label),
      ["Input", "Output", "Cache read", "Cache write", "Total tokens", "Context", "Cost"],
    );
  });

  test("包月制不显示花费——那个数字是估价，跟这个月的账单无关", () => {
    const labels = usageBreakdown(stats(), "plan").map((r) => r.label);
    assert.equal(labels.includes("Cost"), false);
  });

  test("按量计费且真的算得出来才显示花费", () => {
    assert.equal(usageBreakdown(stats(), "metered").at(-1)?.label, "Cost");
  });

  test("没价目表（cost 为 0）就不占那一行——不写 no price list，也不写 unknown", () => {
    const labels = usageBreakdown(stats({ cost: 0 })).map((r) => r.label);
    assert.equal(labels.includes("Cost"), false);
  });

  test("花费四位小数——展开看的人要的正是底栏舍入掉的那几位", () => {
    assert.equal(usageBreakdown(stats({ cost: 0.0625 })).at(-1)?.value, "$0.0625");
  });

  test("压缩刚完：Context 行如实说未知，不写 0", () => {
    const rows = usageBreakdown(
      stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }),
    );
    assert.equal(rows.find((r) => r.label === "Context")?.value, "unknown until next reply");
  });

  test("完全没有上下文数据时连 Context 行都不给", () => {
    const labels = usageBreakdown(stats({ contextUsage: null })).map((r) => r.label);
    assert.equal(labels.includes("Context"), false);
  });
});
