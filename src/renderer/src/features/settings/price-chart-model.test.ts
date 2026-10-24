import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  costRange,
  costTicks,
  cycleCategory,
  formatCost,
  formatCostTick,
  formatScore,
  paretoFrontier,
  scoreTicks,
  shouldShowPriceChart,
} from "./price-chart-model.ts";

const providerWith = (...ids: string[]) => ({ models: { declared: ids.map((id) => ({ id })) } });

describe("显示门槛：所有服务商加起来 ≥ 2 个型号", () => {
  test("0 / 1 个不显示，2 个显示；跨服务商合计", () => {
    assert.equal(shouldShowPriceChart([]), false);
    assert.equal(shouldShowPriceChart([providerWith("k3")]), false);
    assert.equal(shouldShowPriceChart([providerWith(), providerWith("k3")]), false);
    assert.equal(shouldShowPriceChart([providerWith("k3"), providerWith("glm-5.3")]), true);
  });
});

describe("帕累托前沿", () => {
  test("只留比所有更便宜的点分数都高的", () => {
    const pts = [
      { id: "cheap-low", cost: 0.1, score: 1300 },
      { id: "cheap-high", cost: 0.2, score: 1400 },
      { id: "dominated", cost: 0.5, score: 1350 },
      { id: "pricey-best", cost: 2, score: 1500 },
    ];
    assert.deepEqual(paretoFrontier(pts).map((p) => p.id), ["cheap-low", "cheap-high", "pricey-best"]);
  });

  test("同价只留分最高的；空输入空输出", () => {
    const pts = [
      { id: "a", cost: 1, score: 10 },
      { id: "b", cost: 1, score: 20 },
    ];
    assert.deepEqual(paretoFrontier(pts).map((p) => p.id), ["b"]);
    assert.deepEqual(paretoFrontier([]), []);
  });

  test("分数相同、更贵的不进前沿", () => {
    const pts = [
      { id: "a", cost: 1, score: 10 },
      { id: "b", cost: 2, score: 10 },
    ];
    assert.deepEqual(paretoFrontier(pts).map((p) => p.id), ["a"]);
  });
});

describe("坐标轴", () => {
  test("对数轴至少跨一个数量级，刻度走 1-2-5", () => {
    const range = costRange([0.76]);
    assert.ok(Math.log10(range.max) - Math.log10(range.min) >= 1 - 1e-9);
    const ticks = costTicks({ min: 0.3, max: 40 });
    assert.deepEqual(ticks, [0.5, 1, 2, 5, 10, 20]);
  });

  test("刻度太密时去掉 2 档", () => {
    const ticks = costTicks({ min: 0.001, max: 100 });
    assert.ok(ticks.length <= 12);
    assert.ok(!ticks.includes(0.2));
    assert.ok(ticks.includes(0.5) && ticks.includes(1));
  });

  test("线性轴刻度大约 5 格、步长 1-2-5", () => {
    assert.deepEqual(scoreTicks({ min: 1470, max: 1510 }), [1470, 1480, 1490, 1500, 1510]);
  });
});

describe("分类循环与格式", () => {
  test("六类左右循环，默认第一类是 Agent 综合", () => {
    assert.equal(cycleCategory("agent", -1), "instruction_following");
    assert.equal(cycleCategory("instruction_following", 1), "agent");
    assert.equal(cycleCategory("agent", 1), "overall");
  });

  test("成本与分数", () => {
    assert.equal(formatCost(29.16), "$29");
    assert.equal(formatCost(2.233), "$2.23");
    assert.equal(formatCost(0.7585), "$0.76");
    assert.equal(formatCost(0.03123), "$0.031");
    assert.equal(formatScore(1480.74, "rating"), "1481");
    assert.deepEqual([0.05, 0.1, 1, 20].map(formatCostTick), ["$0.05", "$0.1", "$1", "$20"]);
    assert.equal(formatScore(0.0157, "net-improvement"), "+1.6%");
    assert.equal(formatScore(-0.0177, "net-improvement"), "−1.8%");
  });
});
