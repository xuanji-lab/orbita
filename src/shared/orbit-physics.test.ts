import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  capacityEstimate,
  checkSystem,
  levelForA,
  orbitalPeriod,
  orbitLimits,
  pairGapInRH,
  solveOuterA,
  type OrbitSpec,
} from "./orbit-physics.ts";

const M = 3e-6;
const p = (a: number, e = 0, mass = M, omegaDeg = 0): OrbitSpec => ({ mass, a, e, omegaDeg });
const near = (actual: number, expected: number, tolerance: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ≠ ${expected}`);
};

describe("相互希尔半径判据（调研 T1–T7）", () => {
  test("T1/T2/T3：绿、黄、红三档", () => {
    near(pairGapInRH(p(1), p(1.35), 1), 23.6, 0.1, "T1");
    assert.equal(checkSystem({ mass: 1 }, [p(1), p(1.35)]).ok, true);
    near(pairGapInRH(p(1), p(1.05), 1), 3.9, 0.1, "T2");
    assert.equal(checkSystem({ mass: 1 }, [p(1), p(1.05)]).warnings[0]?.level, "yellow");
    near(pairGapInRH(p(1), p(1.02), 1), 1.6, 0.1, "T3");
    assert.equal(checkSystem({ mass: 1 }, [p(1), p(1.02)]).ok, false);
  });

  test("T4：近日点反向也可以安全；朝向不进入保守的径向间距判据", () => {
    near(pairGapInRH(p(0.6, 0.2, M, 0), p(1.7, 0.45, M, 180), 1), 14.8, 0.1, "T4");
    assert.equal(checkSystem({ mass: 1 }, [p(0.6, 0.2, M, 0), p(1.7, 0.45, M, 180)]).ok, true);
  });

  test("T5：交叉轨道红；外圈最小 a 与舒适 a 有确定数值", () => {
    const inner = p(1, 0.3);
    const outer = p(1.2, 0.5, M, 130);
    near(pairGapInRH(inner, outer, 1), -50.5, 0.1, "T5 gap");
    near(solveOuterA(inner, outer, 1), 2.76, 0.01, "T5 hard a");
    near(solveOuterA(inner, outer, 1, 10), 3.12, 0.01, "T5 soft a");
    const checked = checkSystem({ mass: 1 }, [inner, outer]);
    assert.equal(checked.warnings[0]?.crossed, true);
    near(checked.warnings[0]?.minA ?? 0, 2.76, 0.01, "T5 warning minA");
  });

  test("T6：海王星 × 冥王星的共振保护不在 UI 开放，几何交叉仍报红", () => {
    const gap = pairGapInRH(p(30.07, 0.0113, 5.15e-5), p(39.48, 0.2488, 6.55e-9), 1);
    near(gap, -0.8, 0.1, "T6");
    assert.equal(checkSystem({ mass: 1 }, [p(30.07, 0.0113, 5.15e-5), p(39.48, 0.2488, 6.55e-9)]).ok, false);
  });

  test("T7：Kepler-11 式等比链是黄、黄、绿（第二对 9.9908，调研表的 10.0 是取整显示）", () => {
    const checked = checkSystem({ mass: 1 }, [0.091, 0.106, 0.128, 0.155].map((a) => p(a, 0, 1e-5)));
    assert.deepEqual(checked.warnings.map((warning) => [warning.gapInRH.toFixed(1), warning.level]), [["8.1", "yellow"], ["10.0", "yellow"]]);
    near(pairGapInRH(p(0.106, 0, 1e-5), p(0.128, 0, 1e-5), 1), 9.9908, 0.0001, "T7 第二对未取整值");
    near(pairGapInRH(p(0.128, 0, 1e-5), p(0.155, 0, 1e-5), 1), 10.1, 0.1, "T7 第三对");
  });
});

describe("允许区间、周期与容量（调研 T8–T12）", () => {
  test("T8：主星与行星质量都进周期；主星翻倍，周期除 √2", () => {
    near(orbitalPeriod({ mass: 1 }, p(1, 0, 0)), 1, 1e-12, "T8 基准");
    near(orbitalPeriod({ mass: 1.001 }, p(1, 0, 0)), 0.9995, 0.0001, "T8 +0.001");
    near(orbitalPeriod({ mass: 1.01 }, p(1, 0, 0)), 0.995, 0.0001, "T8 +0.01");
    near(orbitalPeriod({ mass: 2 }, p(1, 0, 0)) * Math.SQRT2, 1, 1e-12, "T8 主星翻倍");
  });

  test("T9：三行星夹挤，中圈硬允许区间 [1.164, 1.744]，红黄绿分档", () => {
    const planets = [p(1), p(1.4, 0.1), p(2)];
    const limits = orbitLimits({ mass: 1 }, planets, 1);
    near(limits.minA, 1.164, 0.001, "T9 min");
    near(limits.maxA, 1.744, 0.001, "T9 max");
    assert.equal(levelForA(limits, limits.minA - 0.01, false), "red");
    assert.equal(levelForA(limits, limits.minA, false), "yellow");
    assert.equal(levelForA(limits, 1.4, false), "green");
  });

  test("T10：单行星任意 a/e 都是绿", () => {
    const limits = orbitLimits({ mass: 1 }, [p(0.01, 0.59)], 0);
    assert.equal(levelForA(limits, 0.01, true), "green");
    assert.equal(limits.maxE, 0.6);
  });

  test("T11：木星质量行星在 0.05–100 AU 约排 8 颗", () => {
    assert.equal(capacityEstimate({ mass: 1 }, 9.5e-4, 0.05, 100), 8);
  });

  test("T12：行星质量固定时主星越重容量越大；质量同比缩放时容量不变", () => {
    assert.deepEqual([0.1, 1, 10].map((mass) => capacityEstimate({ mass }, 3e-6, 0.05, 100)), [27, 60, 129]);
    const fixedRatio = [0.1, 1, 10].map((mass) => capacityEstimate({ mass }, mass * 0.001, 0.05, 100));
    assert.equal(new Set(fixedRatio).size, 1);
  });
});
