import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Automation, AutomationRun } from "../../../../shared/automation.ts";
import {
  SPARK_FULL_PX,
  SPARK_RAN_PX,
  SPARK_ZERO_PX,
  showsSpark,
  sparkBarHeight,
  sparkDayStarts,
  sparkDays,
  sparkScale,
  type SparkKind,
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
    createdAt: 0, // 0 = 很久以前，所有天都在创建日之后
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
    assert.equal(sparkBarHeight({ kind: "none", count: 0 }, 0), SPARK_ZERO_PX);
  });

  test("柱高：没跑 2px；跑过的至少 11px，按比例但顶满 18px；创建前 0", () => {
    const d = (kind: SparkKind, count: number) => ({ kind, count });
    assert.equal(sparkBarHeight(d("ran", 8), 8), SPARK_FULL_PX);
    assert.equal(sparkBarHeight(d("ran", 6), 8), 14);
    assert.equal(sparkBarHeight(d("ran", 4), 8), SPARK_RAN_PX);
    assert.equal(sparkBarHeight(d("ran", 1), 8), SPARK_RAN_PX);
    assert.equal(sparkBarHeight(d("ran", 1), 100), SPARK_RAN_PX);
    assert.equal(sparkBarHeight(d("ran", 1), 1), SPARK_FULL_PX);
    assert.equal(sparkBarHeight(d("none", 0), 8), SPARK_ZERO_PX);
    assert.equal(sparkBarHeight(d("na", 0), 8), 0);
    assert.equal(sparkBarHeight(d("running", 1), 8), SPARK_RAN_PX);
    assert.equal(sparkBarHeight(d("running", 8), 8), SPARK_RAN_PX);
    assert.equal(sparkBarHeight(d("ran", 3), 0), SPARK_RAN_PX);
  });
});

/** 设计稿 cases.png 的 17 种情况：每天的 kind 与高度（最右是今天，尺子 = max） */
describe("近 7 天柱状图：17 种情况", () => {
  const N = "none" as const;
  const R = "ran" as const;
  const X = "na" as const;
  /** 某天 n 次成功 */
  const times = (back: number, n: number, status: AutomationRun["status"] = "success"): AutomationRun[] =>
    Array.from({ length: n }, (_, i) => run(at(back, 1) + i * 60_000, status));
  /** 返回 [kind, 高度] 列，高度用给定尺子 */
  function draw(a: Automation, max: number): Array<[SparkKind, number]> {
    return sparkDays(a, NOW).map((d) => [d.kind, sparkBarHeight(d, max)]);
  }
  const kinds = (a: Automation, max = 1): SparkKind[] => draw(a, max).map(([k]) => k);
  const withCreated = (a: Automation, back: number): Automation => ({ ...a, createdAt: at(back, 8) });

  test("1 只跑过 1 次，就在今天：只有最右一根实心", () => {
    const a = auto("a", times(0, 1));
    assert.deepEqual(kinds(a), [N, N, N, N, N, N, R]);
    assert.equal(sparkDays(a, NOW)[6]?.today, true);
    assert.equal(sparkBarHeight(sparkDays(a, NOW)[6]!, 1), 18); // 尺子只有它自己时顶满
  });

  test("2 只跑过 1 次，在 7 天内的某一天（3 天前）", () => {
    assert.deepEqual(kinds(auto("a", times(3, 1))), [N, N, N, R, N, N, N]);
  });

  test("3 只跑过 1 次，但在 7 天以前：7 根浅线，累计仍记 1", () => {
    const a = auto("a", times(9, 1));
    assert.deepEqual(kinds(a), [N, N, N, N, N, N, N]);
    assert.equal(a.runCount, 1);
  });

  test("4 刚建好、还没到点：创建前 6 天不画，只有今天一道浅线", () => {
    assert.deepEqual(kinds(withCreated(auto("a", []), 0)), [X, X, X, X, X, X, N]);
  });

  test("5 建了很久，一次没成功跑：7 根浅线", () => {
    assert.deepEqual(kinds(auto("a", [])), [N, N, N, N, N, N, N]);
  });

  test("6 每天一次从不落下：7 根同高（尺子 1 → 顶满；尺子 8 → 11px）", () => {
    const a = auto("a", [6, 5, 4, 3, 2, 1, 0].flatMap((b) => times(b, 1)));
    assert.deepEqual(kinds(a), [R, R, R, R, R, R, R]);
    assert.deepEqual(new Set(draw(a, 8).map(([, h]) => h)), new Set([SPARK_RAN_PX]));
  });

  test("7 每天一次、中间断一天：断的是浅线", () => {
    const a = auto("a", [6, 5, 4, 2, 1, 0].flatMap((b) => times(b, 1)));
    assert.deepEqual(kinds(a), [R, R, R, N, R, R, R]);
    assert.equal(draw(a, 8)[3]?.[1], SPARK_ZERO_PX);
  });

  test("8 每周一次：一周只有一根", () => {
    assert.deepEqual(kinds(auto("a", times(6, 1))), [R, N, N, N, N, N, N]);
  });

  test("9 建于 3 天前、每天一次：创建前不画，之后每天一根（含建的当天）", () => {
    const a = withCreated(auto("a", [3, 2, 1, 0].flatMap((b) => times(b, 1))), 3);
    assert.deepEqual(kinds(a), [X, X, X, R, R, R, R]);
    assert.equal(draw(a, 8)[0]?.[1], 0);
  });

  test("9b 创建日之前却有运行（脏数据）：真实运行不被隐藏", () => {
    assert.deepEqual(kinds(withCreated(auto("a", times(5, 1)), 1)), [X, R, X, X, X, N, N]);
  });

  test("10 今天连跑 8 次（尺子的顶）：今天 18px，其他跑过的天仍是 11px，1 次的天不被压矮", () => {
    const a = auto("a", [...[6, 5, 4, 2, 1].flatMap((b) => times(b, 1)), ...times(0, 8)]);
    assert.deepEqual(kinds(a, 8), [R, R, R, N, R, R, R]);
    assert.deepEqual(draw(a, 8).map(([, h]) => h), [11, 11, 11, 2, 11, 11, 18]);
    assert.equal(sparkScale([a], NOW), 8);
  });

  test("11 正在跑：今天只有一条 running → 空心，11px；其余天实心", () => {
    const a = auto("a", [...[6, 5, 4, 3, 2, 1].flatMap((b) => times(b, 1)), run(at(0, 14), "running")]);
    assert.deepEqual(kinds(a, 8), [R, R, R, R, R, R, "running"]);
    assert.equal(draw(a, 8)[6]?.[1], SPARK_RAN_PX);
    // 今天已有完成的，再加一条在跑的：同样是「今天正在跑」
    const b = auto("b", [run(at(0, 9)), run(at(0, 14), "running")]);
    assert.equal(sparkDays(b, NOW)[6]?.kind, "running");
    // 跑完变实心
    const done = auto("b", [run(at(0, 9)), run(at(0, 14), "success")]);
    assert.equal(sparkDays(done, NOW)[6]?.kind, "ran");
    // 过去遗留的 running 当作跑过，不画空心
    assert.equal(sparkDays(auto("c", [run(at(2), "running")]), NOW)[4]?.kind, "ran");
  });

  test("12 有一天失败：那天红；同一天先失败后成功也红；今天又在跑时红色优先", () => {
    const a = auto("a", [...times(5, 1), ...times(4, 1), run(at(3, 9), "error"), ...times(2, 1)]);
    assert.deepEqual(kinds(a), [N, R, R, "failed", R, N, N]);
    const mixed = auto("m", [run(at(2, 9), "error"), run(at(2, 13), "success")]);
    assert.equal(sparkDays(mixed, NOW)[4]?.kind, "failed");
    const todayBoth = auto("t", [run(at(0, 9), "error"), run(at(0, 14), "running")]);
    assert.equal(sparkDays(todayBoth, NOW)[6]?.kind, "failed");
    assert.equal(draw(a, 8)[3]?.[1], SPARK_RAN_PX);
  });

  test("13 被跳过的不算：不画、不进尺子", () => {
    const a = auto("a", [6, 5, 4, 3, 2, 1].flatMap((b) => times(b, 1)));
    a.runs.push(run(at(0, 9), "skipped"));
    assert.equal(sparkDays(a, NOW)[6]?.kind, "none");
    assert.equal(sparkDays(a, NOW)[6]?.count, 0);
  });

  test("14 已暂停：暂停之后的天是浅线（整排变淡是 CSS，按行状态）", () => {
    assert.deepEqual(kinds(auto("a", [6, 5, 4].flatMap((b) => times(b, 1)))), [R, R, R, N, N, N, N]);
  });

  test("15 已失败停下：红柱不变淡，其余是浅线", () => {
    const a = auto("a", [...times(6, 1), run(at(5, 9), "error"), run(at(4, 9), "error")]);
    assert.deepEqual(kinds(a), [R, "failed", "failed", N, N, N, N]);
  });

  test("16/17 一次性任务（已跑 / 没跑）：不画图，也不进尺子", () => {
    assert.equal(showsSpark(auto("o1", times(0, 1), "once")), false);
    assert.equal(showsSpark(auto("o2", [], "once")), false);
    assert.equal(sparkScale([auto("o1", times(0, 4), "once")], NOW), 0);
  });
});
