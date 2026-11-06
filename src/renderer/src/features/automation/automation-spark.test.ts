import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Automation, AutomationRun } from "../../../../shared/automation.ts";
import {
  SPARK_FULL_PX,
  SPARK_MIN_PX,
  SPARK_ZERO_PX,
  showsSpark,
  sparkBarHeight,
  sparkDayStarts,
  sparkDays,
  sparkScale,
} from "./automation-spark.ts";

/** 本地时间 2026-11-06 15:00（周五）。测试按「本地自然日」断言，TZ 随机器也成立 */
const NOW = new Date(2026, 10, 6, 15, 0).getTime();
const at = (back: number, hour = 12, minute = 0): number => new Date(2026, 10, 6 - back, hour, minute).getTime();

function run(runAt: number, status: AutomationRun["status"] = "success"): AutomationRun {
  return { id: `r${runAt}`, runAt, trigger: "schedule", status, sessionId: null, durationMs: null, tokens: null };
}
function auto(id: string, runs: AutomationRun[], kind: "interval" | "once" = "interval"): Automation {
  return {
    id,
    title: id,
    prompt: "p",
    schedule: kind === "once" ? { kind: "once", at: NOW } : { kind: "interval", unit: "hour", every: 6 },
    target: { kind: "new_session", workspaceId: null },
    mode: "plan",
    status: "active",
    createdBy: { kind: "user" },
    nextRunAt: null,
    runs,
    runCount: runs.length,
    consecutiveFailures: 0,
    createdAt: 0,
    updatedAt: 0,
  } as Automation;
}

describe("sparkDayStarts", () => {
  test("7 个本地 00:00，旧 → 新，最后一个是今天", () => {
    const starts = sparkDayStarts(NOW);
    assert.equal(starts.length, 7);
    assert.equal(starts[6] ?? 0, new Date(2026, 10, 6).getTime());
    assert.equal(starts[0] ?? 0, new Date(2026, 10, 0).getTime()); // 10/31
  });
});

describe("sparkDays", () => {
  test("按日归次数，今天是最后一根", () => {
    const days = sparkDays(auto("a", [run(at(0, 9)), run(at(0, 10)), run(at(2))]), NOW);
    assert.deepEqual(days.map((d) => d.count), [0, 0, 0, 0, 1, 0, 2]);
    assert.equal(days[6]?.today, true);
    assert.equal(days.filter((d) => d.today).length, 1);
  });

  test("跨午夜：23:59 与 00:00 分在两天", () => {
    const days = sparkDays(auto("a", [run(at(1, 23, 59)), run(at(0, 0, 0))]), NOW);
    assert.equal(days[5]?.count, 1);
    assert.equal(days[6]?.count, 1);
  });

  test("7 天边界：第 7 天（6 天前）算，第 8 天（7 天前）不算", () => {
    const days = sparkDays(auto("a", [run(at(6, 0, 0)), run(at(7, 23, 59)), run(at(8)), run(at(9))]), NOW);
    assert.equal(days[0]?.count, 1);
    assert.equal(days.reduce((n, d) => n + d.count, 0), 1);
  });

  test("skipped 不计，error 当天标失败，running 计入", () => {
    const days = sparkDays(
      auto("a", [run(at(1), "skipped"), run(at(2), "success"), run(at(2, 13), "error"), run(at(0, 14), "running")]),
      NOW,
    );
    assert.equal(days[5]?.count, 0);
    assert.equal(days[4]?.count, 2);
    assert.equal(days[4]?.failed, true);
    assert.equal(days[5]?.failed, false);
    assert.equal(days[6]?.count, 1);
  });

  test("晚于 now 的运行（时钟回拨 / 脏数据）不画", () => {
    const days = sparkDays(auto("a", [run(NOW + 60_000)]), NOW);
    assert.equal(days[6]?.count, 0);
  });

  test("时区：归日看本地午夜，不看 UTC 午夜", () => {
    // 本地 00:30 与本地 23:30 必在同一天里的两端，无论机器在哪个时区
    const days = sparkDays(auto("a", [run(at(3, 0, 30)), run(at(3, 23, 30))]), NOW);
    assert.equal(days[3]?.count, 2);
  });
});

describe("sparkScale / sparkBarHeight", () => {
  test("尺子 = 所有行 × 近 7 天的单日最大次数；滑出 7 天的那天不再算", () => {
    const eight = Array.from({ length: 8 }, (_, i) => run(at(0, 1) + i * 60_000));
    const a = auto("a", [run(at(1))]);
    const b = auto("b", eight);
    assert.equal(sparkScale([a, b], NOW), 8);
    // 一天以后（now+1d）那 8 次还在第 7 天内；再过 6 天以上就滑出
    assert.equal(sparkScale([a, b], NOW + 6 * 86_400_000), 8);
    assert.equal(sparkScale([a, b], NOW + 7 * 86_400_000), 0);
  });

  test("一次性任务不进尺子", () => {
    const once = auto("o", Array.from({ length: 5 }, (_, i) => run(at(0, 1) + i * 1000)), "once");
    assert.equal(showsSpark(once), false);
    assert.equal(sparkScale([once, auto("a", [run(at(0))])], NOW), 1);
  });

  test("max 为 0（谁都没跑）：全是细线，不除零", () => {
    assert.equal(sparkScale([auto("a", [])], NOW), 0);
    assert.equal(sparkBarHeight(0, 0), SPARK_ZERO_PX);
    assert.equal(sparkBarHeight(3, 0), SPARK_ZERO_PX);
  });

  test("柱高：最大那根顶满，按比例变矮，跑过的至少 3px，没跑是细线", () => {
    assert.equal(sparkBarHeight(8, 8), SPARK_FULL_PX);
    assert.equal(sparkBarHeight(4, 8), 9);
    assert.equal(sparkBarHeight(1, 8), 2 < SPARK_MIN_PX ? SPARK_MIN_PX : 2);
    assert.equal(sparkBarHeight(1, 100), SPARK_MIN_PX);
    assert.equal(sparkBarHeight(0, 8), SPARK_ZERO_PX);
    assert.equal(sparkBarHeight(1, 1), SPARK_FULL_PX);
  });
});
