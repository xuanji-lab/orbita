import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATION_RUNS_KEPT,
  automationCardOf,
  composeAutomationHeader,
  intervalMinutes,
  isRunning,
  nextRunAfter,
  normalizeWeekdays,
  parseAutomation,
  parseAutomationCard,
  parseAutomationHeader,
  parseAutomationRunLabel,
  parseClockTime,
  parseSchedule,
  runsInLastDay,
  type Automation,
  type AutomationRun,
  type AutomationSchedule,
} from "./automation.ts";

/** 本机时区的墙上时间（月份 1 起），测试与实现用同一个时区，所以断言不依赖 TZ 环境 */
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe("parseClockTime", () => {
  test("合法的 HH:MM", () => {
    assert.deepEqual(parseClockTime("09:30"), [9, 30]);
    assert.deepEqual(parseClockTime("00:00"), [0, 0]);
    assert.deepEqual(parseClockTime("23:59"), [23, 59]);
  });
  test("越界、缺零、多余字符都拒绝", () => {
    for (const bad of ["24:00", "9:30", "09:60", "0930", "09:30:00", "", " 09:30"]) {
      assert.equal(parseClockTime(bad), null, bad);
    }
  });
});

describe("normalizeWeekdays", () => {
  test("去重排序；空或七天全选等于每天（undefined）", () => {
    assert.deepEqual(normalizeWeekdays([5, 1, 1, 3]), [1, 3, 5]);
    assert.equal(normalizeWeekdays([]), undefined);
    assert.equal(normalizeWeekdays([0, 1, 2, 3, 4, 5, 6]), undefined);
    assert.equal(normalizeWeekdays(undefined), undefined);
  });
  test("越界与非整数的天丢掉", () => {
    assert.deepEqual(normalizeWeekdays([1, 7, -1, 2.5, "x", 3]), [1, 3]);
  });
});

describe("parseSchedule", () => {
  const now = local(2026, 10, 31, 12);
  test("interval：每 N 分钟 / 小时 / 天，总间隔至少 5 分钟，N 必须是正整数", () => {
    assert.deepEqual(parseSchedule({ kind: "interval", unit: "minute", every: 5 }, now), {
      ok: true,
      schedule: { kind: "interval", unit: "minute", every: 5 },
    });
    assert.equal(parseSchedule({ kind: "interval", unit: "hour", every: 1 }, now).ok, true);
    assert.equal(parseSchedule({ kind: "interval", unit: "day", every: 3 }, now).ok, true);
    for (const bad of [4, 0, -5, 7.5, "10", null]) {
      assert.equal(parseSchedule({ kind: "interval", unit: "minute", every: bad }, now).ok, false, String(bad));
    }
    assert.equal(parseSchedule({ kind: "interval", unit: "week", every: 1 }, now).ok, false);
  });
  test("interval 上限一年", () => {
    assert.equal(parseSchedule({ kind: "interval", unit: "day", every: 366 }, now).ok, false);
    assert.equal(parseSchedule({ kind: "interval", unit: "day", every: 365 }, now).ok, true);
  });
  test("once 必须在未来", () => {
    assert.equal(parseSchedule({ kind: "once", at: now - 1 }, now).ok, false);
    assert.equal(parseSchedule({ kind: "once", at: now }, now).ok, false);
    assert.equal(parseSchedule({ kind: "once", at: now + 60_000 }, now).ok, true);
    assert.equal(parseSchedule({ kind: "once", at: Number.NaN }, now).ok, false);
  });
  test("hourly 的分钟 0-59", () => {
    assert.equal(parseSchedule({ kind: "hourly", minute: 0 }, now).ok, true);
    assert.equal(parseSchedule({ kind: "hourly", minute: 59 }, now).ok, true);
    assert.equal(parseSchedule({ kind: "hourly", minute: 60 }, now).ok, false);
    assert.equal(parseSchedule({ kind: "hourly", minute: 1.5 }, now).ok, false);
  });
  test("daily 校验时刻，weekdays 规整", () => {
    assert.deepEqual(parseSchedule({ kind: "daily", time: "09:00", weekdays: [5, 1, 1] }, now), {
      ok: true,
      schedule: { kind: "daily", time: "09:00", weekdays: [1, 5] },
    });
    assert.deepEqual(parseSchedule({ kind: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, now), {
      ok: true,
      schedule: { kind: "daily", time: "09:00" },
    });
    assert.equal(parseSchedule({ kind: "daily", time: "9:00" }, now).ok, false);
    assert.equal(parseSchedule({ kind: "daily", time: "09:00", weekdays: [8] }, now).ok, false);
    assert.equal(parseSchedule({ kind: "daily", time: "09:00", weekdays: "1" }, now).ok, false);
  });
  test("monthly：1-31 日 + 时刻", () => {
    assert.equal(parseSchedule({ kind: "monthly", day: 31, time: "08:30" }, now).ok, true);
    assert.equal(parseSchedule({ kind: "monthly", day: 0, time: "08:30" }, now).ok, false);
    assert.equal(parseSchedule({ kind: "monthly", day: 32, time: "08:30" }, now).ok, false);
    assert.equal(parseSchedule({ kind: "monthly", day: 5, time: "25:00" }, now).ok, false);
  });
  test("不是对象或 kind 不认识", () => {
    assert.equal(parseSchedule(null, now).ok, false);
    assert.equal(parseSchedule("daily", now).ok, false);
    assert.equal(parseSchedule({ kind: "cron" }, now).ok, false);
  });
});

describe("nextRunAfter", () => {
  test("once：未来返回自己，已过返回 null", () => {
    const at = local(2026, 11, 1, 8);
    assert.equal(nextRunAfter({ kind: "once", at }, at - 1), at);
    assert.equal(nextRunAfter({ kind: "once", at }, at), null);
    assert.equal(nextRunAfter({ kind: "once", at }, at + 1), null);
  });
  test("interval：从 from 起算 N 分钟 / 小时 / 天", () => {
    const from = local(2026, 10, 31, 12);
    assert.equal(nextRunAfter({ kind: "interval", unit: "minute", every: 30 }, from), from + 30 * 60_000);
    assert.equal(nextRunAfter({ kind: "interval", unit: "hour", every: 2 }, from), from + 2 * 3_600_000);
    assert.equal(nextRunAfter({ kind: "interval", unit: "day", every: 1 }, from), from + 24 * 3_600_000);
    assert.equal(intervalMinutes({ unit: "hour", every: 3 }), 180);
  });
  test("hourly：本小时的第 MM 分还没到就是本小时，到了就是下个小时（跨日）", () => {
    const schedule = { kind: "hourly", minute: 15 } as const;
    assert.equal(nextRunAfter(schedule, local(2026, 10, 31, 12, 14)), local(2026, 10, 31, 12, 15));
    assert.equal(nextRunAfter(schedule, local(2026, 10, 31, 12, 15)), local(2026, 10, 31, 13, 15));
    assert.equal(nextRunAfter(schedule, local(2026, 10, 31, 23, 30)), local(2026, 11, 1, 0, 15));
  });
  test("monthly：本月的日子没到就是本月，过了是下月；31 日在短月落月末；跨年", () => {
    const fifth = { kind: "monthly", day: 5, time: "08:30" } as const;
    assert.equal(nextRunAfter(fifth, local(2026, 10, 4, 12)), local(2026, 10, 5, 8, 30));
    assert.equal(nextRunAfter(fifth, local(2026, 10, 5, 8, 30)), local(2026, 11, 5, 8, 30));
    assert.equal(nextRunAfter(fifth, local(2026, 12, 20)), local(2027, 1, 5, 8, 30));
    const last = { kind: "monthly", day: 31, time: "09:00" } as const;
    // 11 月只有 30 天：10-31 之后的下一次是 11-30
    assert.equal(nextRunAfter(last, local(2026, 10, 31, 9)), local(2026, 11, 30, 9));
    // 2027 是平年，2 月 28 日
    assert.equal(nextRunAfter(last, local(2027, 1, 31, 9)), local(2027, 2, 28, 9));
  });
  test("daily：今天的时刻还没到就是今天，过了就是明天（跨日）", () => {
    const schedule = { kind: "daily", time: "09:00" } as const;
    assert.equal(nextRunAfter(schedule, local(2026, 10, 31, 8, 59)), local(2026, 10, 31, 9));
    assert.equal(nextRunAfter(schedule, local(2026, 10, 31, 9)), local(2026, 11, 1, 9));
    assert.equal(nextRunAfter(schedule, local(2026, 10, 31, 23, 59)), local(2026, 11, 1, 9));
  });
  test("daily：跨月跨年", () => {
    const schedule = { kind: "daily", time: "00:30" } as const;
    assert.equal(nextRunAfter(schedule, local(2026, 12, 31, 12)), local(2027, 1, 1, 0, 30));
  });
  test("daily + weekdays：跳到下一个合格的星期（2026-10-31 是周六）", () => {
    const weekdaysOnly: AutomationSchedule = { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] };
    // 周六中午 → 周一 09:00
    assert.equal(nextRunAfter(weekdaysOnly, local(2026, 10, 31, 12)), local(2026, 11, 2, 9));
    // 周五 09:00 整 → 严格晚于 from，下一个是下周一
    assert.equal(nextRunAfter(weekdaysOnly, local(2026, 10, 30, 9)), local(2026, 11, 2, 9));
    // 只限周日
    assert.equal(nextRunAfter({ kind: "daily", time: "07:00", weekdays: [0] }, local(2026, 10, 31, 12)), local(2026, 11, 1, 7));
  });
  test("夏令时切换附近不崩、结果严格晚于 from 且单调", () => {
    // 美国 2026 春季 3-8 02:00 跳 03:00，秋季 11-1 02:00 回 01:00；不同 TZ 下这些日子未必有切换，只断言不变量
    const schedule = { kind: "daily", time: "02:30" } as const;
    for (const [mo, d] of [
      [3, 7],
      [3, 8],
      [3, 28],
      [3, 29],
      [10, 31],
      [11, 1],
    ] as const) {
      let from = local(2026, mo, d, 0);
      for (let i = 0; i < 4; i += 1) {
        const next = nextRunAfter(schedule, from);
        assert.notEqual(next, null);
        assert.ok((next as number) > from, `${mo}-${d} #${i}`);
        // 相邻两次相隔应在 20–28 小时之间（一天，允许 DST 的一小时偏差）
        if (i > 0) assert.ok((next as number) - from <= 28 * 3_600_000 && (next as number) - from >= 20 * 3_600_000);
        from = next as number;
      }
    }
  });
  test("坏输入返回 null 不抛", () => {
    assert.equal(nextRunAfter({ kind: "daily", time: "xx" }, 0), null);
    assert.equal(nextRunAfter({ kind: "interval", unit: "minute", every: 5 }, Number.NaN), null);
    assert.equal(nextRunAfter({ kind: "monthly", day: 3, time: "xx" }, 0), null);
  });
});

const run = (patch: Partial<AutomationRun> & { id: string }): AutomationRun => ({
  runAt: 0,
  trigger: "schedule",
  status: "success",
  sessionId: null,
  durationMs: null,
  tokens: null,
  ...patch,
});

describe("runsInLastDay / isRunning", () => {
  const now = local(2026, 10, 31, 12);
  test("滚动 24 小时内、非 skipped 的才计数", () => {
    const runs = [
      run({ id: "a", runAt: now - 1000 }),
      run({ id: "b", runAt: now - 23 * 3_600_000 }),
      run({ id: "c", runAt: now - 25 * 3_600_000 }),
      run({ id: "d", runAt: now - 2000, status: "skipped" }),
      run({ id: "e", runAt: now - 3000, status: "error" }),
    ];
    assert.equal(runsInLastDay({ runs }, now), 3);
  });
  test("有 running 的运行才算在跑", () => {
    assert.equal(isRunning({ runs: [run({ id: "a" }), run({ id: "b", status: "running" })] }), true);
    assert.equal(isRunning({ runs: [run({ id: "a" })] }), false);
  });
});

describe("送进会话的抬头", () => {
  const at = local(2026, 10, 31, 1, 45);
  test("带上限写 3/12，没上限只写次数", () => {
    assert.equal(composeAutomationHeader({ title: "等 vLLM", number: 3, max: 12, at }), "[定时任务「等 vLLM」第 3/12 次 · 10-31 01:45]");
    assert.equal(composeAutomationHeader({ title: "等 vLLM", number: 3, at }), "[定时任务「等 vLLM」第 3 次 · 10-31 01:45]");
  });
  test("compose 的结果 parse 得回来，指令正文原样留在 body", () => {
    const text = `${composeAutomationHeader({ title: "日报", number: 7, max: 12, at })}\n\n看一下 git log\n第二行`;
    assert.deepEqual(parseAutomationHeader(text), {
      title: "日报",
      number: 7,
      max: 12,
      stamp: "10-31 01:45",
      body: "看一下 git log\n第二行",
    });
    assert.equal(parseAutomationHeader(composeAutomationHeader({ title: "日报", number: 7, at }))?.max, null);
  });
  test("不是抬头的文本、残缺抬头都返回 null", () => {
    assert.equal(parseAutomationHeader("帮我看一下"), null);
    assert.equal(parseAutomationHeader("[定时任务「x」第 a 次 · y]"), null);
    assert.equal(parseAutomationHeader("前面有字 [定时任务「x」第 1 次 · 10-31 01:45]"), null);
  });
});

describe("parseAutomation", () => {
  const good = {
    id: "a1",
    title: "查论文",
    prompt: "看看 DDPM 有没有新进展",
    schedule: { kind: "interval", unit: "minute", every: 30 },
    target: { kind: "this_session", sessionId: "s9", workspaceId: "ws1" },
    mode: "skip",
    status: "active",
    createdBy: { kind: "agent", sessionId: "s9" },
    maxRuns: 12,
    nextRunAt: 1000,
    runs: [],
    runCount: 2,
    consecutiveFailures: 1,
    createdAt: 5,
    updatedAt: 6,
  };
  test("完整的一条原样读回", () => {
    const parsed = parseAutomation(good) as Automation;
    assert.equal(parsed.title, "查论文");
    assert.deepEqual(parsed.target, { kind: "this_session", sessionId: "s9", workspaceId: "ws1" });
    assert.deepEqual(parsed.createdBy, { kind: "agent", sessionId: "s9" });
    assert.equal(parsed.maxRuns, 12);
    assert.equal(parsed.nextRunAt, 1000);
  });
  test("缺 id / 标题 / 指令 / 合法规则 / 去处 / 合法状态，整条丢", () => {
    assert.equal(parseAutomation({ ...good, id: "" }), null);
    assert.equal(parseAutomation({ ...good, title: undefined }), null);
    assert.equal(parseAutomation({ ...good, prompt: "  " }), null);
    assert.equal(parseAutomation({ ...good, schedule: { kind: "interval", unit: "minute", every: 1 } }), null);
    assert.equal(parseAutomation({ ...good, status: "running" }), null);
    assert.equal(parseAutomation({ ...good, status: "pending" }), null);
    assert.equal(parseAutomation({ ...good, target: { kind: "this_session" } }), null);
    assert.equal(parseAutomation({ ...good, target: undefined }), null);
    assert.equal(parseAutomation(null), null);
    assert.equal(parseAutomation("x"), null);
  });
  test("manual 档退回 plan；坏的 agent 来源退回 user；非 active 的 nextRunAt 清空", () => {
    const parsed = parseAutomation({ ...good, mode: "manual", createdBy: { kind: "agent" }, status: "paused" }) as Automation;
    assert.equal(parsed.mode, "plan");
    assert.deepEqual(parsed.createdBy, { kind: "user" });
    assert.equal(parsed.nextRunAt, null);
  });
  test("endReason 只在 completed 时保留，failureReason 只在 failed 时保留", () => {
    const completed = parseAutomation({ ...good, status: "completed", endReason: "sessionDeleted", failureReason: "x" }) as Automation;
    assert.equal(completed.endReason, "sessionDeleted");
    assert.equal(completed.failureReason, undefined);
    const failed = parseAutomation({ ...good, status: "failed", endReason: "finished", failureReason: "GitHub 403" }) as Automation;
    assert.equal(failed.endReason, undefined);
    assert.equal(failed.failureReason, "GitHub 403");
  });
  test("pendingDelivery 只在 active 的 this_session 任务上保留，坏的丢掉", () => {
    const pending = { since: 5, trigger: "schedule", merged: 2 };
    assert.deepEqual((parseAutomation({ ...good, pendingDelivery: pending }) as Automation).pendingDelivery, pending);
    assert.equal((parseAutomation({ ...good, status: "paused", pendingDelivery: pending }) as Automation).pendingDelivery, undefined);
    assert.equal(
      (parseAutomation({ ...good, target: { kind: "new_session", workspaceId: null }, pendingDelivery: pending }) as Automation)
        .pendingDelivery,
      undefined,
    );
    assert.equal((parseAutomation({ ...good, pendingDelivery: { since: 5, trigger: "x", merged: 1 } }) as Automation).pendingDelivery, undefined);
  });
  test("过了点的 once 是合法的磁盘状态", () => {
    const parsed = parseAutomation({ ...good, schedule: { kind: "once", at: 1 }, status: "completed" });
    assert.notEqual(parsed, null);
  });
  test("runs 逐条校验、坏的丢、最多留 AUTOMATION_RUNS_KEPT 条", () => {
    const many = Array.from({ length: AUTOMATION_RUNS_KEPT + 10 }, (_, i) => ({
      id: `r${i}`,
      runAt: i,
      trigger: "schedule",
      status: "success",
      sessionId: "s",
      durationMs: 1,
      tokens: 2,
    }));
    const parsed = parseAutomation({ ...good, runs: [{ id: "bad" }, ...many] }) as Automation;
    assert.equal(parsed.runs.length, AUTOMATION_RUNS_KEPT);
    assert.equal(parsed.runs[0]?.id, "r0");
  });
  test("merged / repeat 只留大于 0 / 1 的整数", () => {
    const parsed = parseAutomation({
      ...good,
      runs: [
        { id: "r1", runAt: 1, trigger: "schedule", status: "success", sessionId: "s", merged: 2.9, repeat: 1 },
        { id: "r2", runAt: 2, trigger: "schedule", status: "skipped", sessionId: null, skipReason: "overlap", repeat: 4 },
      ],
    }) as Automation;
    assert.equal(parsed.runs[0]?.merged, 2);
    assert.equal(parsed.runs[0]?.repeat, undefined);
    assert.equal(parsed.runs[1]?.repeat, 4);
  });
});

describe("对话卡的摘要", () => {
  const base = parseAutomation({
    id: "a1",
    title: "等 vLLM",
    prompt: "看日志",
    schedule: { kind: "interval", unit: "minute", every: 15 },
    target: { kind: "this_session", sessionId: "s9", workspaceId: null },
    mode: "plan",
    status: "active",
    createdBy: { kind: "agent", sessionId: "s9" },
    maxRuns: 12,
    nextRunAt: 99,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
  }) as Automation;
  test("automationCardOf → parseAutomationCard 往返不丢字段，且不带指令全文", () => {
    const card = automationCardOf(base);
    assert.equal("prompt" in card, false);
    assert.deepEqual(parseAutomationCard(JSON.parse(JSON.stringify(card))), card);
  });
  test("坏卡片返回 null", () => {
    assert.equal(parseAutomationCard(null), null);
    assert.equal(parseAutomationCard({ ...automationCardOf(base), target: "elsewhere" }), null);
    assert.equal(parseAutomationCard({ ...automationCardOf(base), status: "pending" }), null);
    assert.equal(parseAutomationCard({ ...automationCardOf(base), schedule: { kind: "x" } }), null);
  });
});

describe("会话上的运行标注", () => {
  test("合法的读回，缺字段 / 坏触发方式 null", () => {
    assert.deepEqual(parseAutomationRunLabel({ title: "t", number: 3.7, at: 5, trigger: "manual" }), {
      title: "t",
      number: 3,
      at: 5,
      trigger: "manual",
    });
    assert.equal(parseAutomationRunLabel({ title: "t", number: 3, trigger: "manual" }), null);
    assert.equal(parseAutomationRunLabel({ title: "t", number: 3, at: 5, trigger: "cron" }), null);
    assert.equal(parseAutomationRunLabel(undefined), null);
  });
});
