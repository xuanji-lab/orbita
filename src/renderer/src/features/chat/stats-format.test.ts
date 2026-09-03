/**
 * 用量显示口径的边界（A-1）。这几条规则会被争论，所以钉住：
 * 「不知道」不能显示成 0、定价未知不能显示成免费、缓存全零不进菜单。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentStats } from "@shared/agent-ipc";
import { contextRing, costText, usageBreakdown } from "./stats-format.ts";

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

describe("costText —— 0 不是免费，是不知道", () => {
  test("有花费给三位小数", () => {
    assert.equal(costText(0.062), "$0.062");
  });
  test("0 返回 null（不显示），不写 $0.000", () => {
    assert.equal(costText(0), null);
  });
  test("负数同样不显示", () => {
    assert.equal(costText(-1), null);
  });
  test("亚分级花费仍看得见——三位小数就是为了它", () => {
    assert.equal(costText(0.0007), "$0.001");
  });
});

describe("usageBreakdown —— 菜单里那几行", () => {
  test("没有 stats 就没有行", () => {
    assert.deepEqual(usageBreakdown(null), []);
  });

  test("缓存两项都是 0 就整个不显示——不挂两行零", () => {
    const rows = usageBreakdown(stats());
    assert.deepEqual(
      rows.map((r) => r.label),
      ["Cost", "Input", "Output"],
    );
  });

  test("用上了缓存才显示那两行", () => {
    const rows = usageBreakdown(
      stats({ tokens: { input: 1, output: 2, cacheRead: 120_000, cacheWrite: 0, total: 3 } }),
    );
    assert.deepEqual(
      rows.map((r) => r.label),
      ["Cost", "Input", "Output", "Cache read", "Cache write"],
    );
  });

  test("花费未知写 unknown，不写 $0.000", () => {
    const rows = usageBreakdown(stats({ cost: 0 }));
    assert.equal(rows[0]?.value, "unknown");
  });

  test("钱排在最前——那是唯一一个用户拿去做决定的数", () => {
    assert.equal(usageBreakdown(stats())[0]?.label, "Cost");
  });
});
