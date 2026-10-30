import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AUTOMATION_RUNS_VISIBLE, type Automation, type AutomationRun, type AutomationSchedule } from "../../../../shared/automation.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
  countLabel,
  defaultScheduleForm,
  describeSchedule,
  endFormFrom,
  endFromForm,
  formFromSchedule,
  formatTokens,
  formatWhen,
  groupAutomations,
  modelOptionValue,
  noteOf,
  parseModelOption,
  previewTimes,
  rowStateOf,
  runLine,
  runWhen,
  runningCount,
  scheduleFromForm,
  sortAutomations,
  subtitleOf,
  visibleRuns,
} from "./automation-view.ts";

const T = en.automation;
const Z = zh.automation;
/** 2026-10-31 周六 10:00（本机时区） */
const NOW = new Date(2026, 9, 31, 10, 0).getTime();
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;

function auto(patch: Partial<Automation> & { id: string }): Automation {
  return {
    title: `任务 ${patch.id}`,
    prompt: "p",
    schedule: { kind: "interval", unit: "minute", every: 15 },
    target: { kind: "new_session", workspaceId: "ws1" },
    mode: "plan",
    status: "active",
    createdBy: { kind: "user" },
    nextRunAt: NOW + 15 * MIN,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const run = (patch: Partial<AutomationRun> & { id: string }): AutomationRun => ({
  runAt: NOW,
  trigger: "schedule",
  status: "success",
  sessionId: "s",
  durationMs: 1,
  tokens: null,
  ...patch,
});

describe("rowStateOf / sortAutomations / runningCount", () => {
  test("有运行在跑的 active / paused 是 running；其余照任务状态", () => {
    assert.equal(rowStateOf(auto({ id: "a", runs: [run({ id: "r", status: "running" })] })), "running");
    assert.equal(rowStateOf(auto({ id: "a", status: "paused", runs: [run({ id: "r", status: "running" })] })), "running");
    assert.equal(rowStateOf(auto({ id: "a", status: "failed", runs: [run({ id: "r", status: "running" })] })), "failed");
    assert.equal(rowStateOf(auto({ id: "a" })), "active");
    assert.equal(rowStateOf(auto({ id: "a", status: "completed" })), "completed");
  });

  test("排序：在跑 > 排期中 > 暂停 > 失败 > 完成；同档下一次早的在前；没有下一次的新建的在前", () => {
    const list = sortAutomations([
      auto({ id: "done", status: "completed", nextRunAt: null }),
      auto({ id: "late", nextRunAt: NOW + 60 * MIN }),
      auto({ id: "failed", status: "failed", nextRunAt: null }),
      auto({ id: "soon", nextRunAt: NOW + 5 * MIN }),
      auto({ id: "paused", status: "paused", nextRunAt: null }),
      auto({ id: "running", runs: [run({ id: "r", status: "running" })], nextRunAt: NOW + 999 * MIN }),
      auto({ id: "done2", status: "completed", nextRunAt: null, createdAt: 9 }),
    ]);
    assert.deepEqual(list.map((a) => a.id), ["running", "soon", "late", "paused", "failed", "done2", "done"]);
  });

  test("runningCount 数在跑的任务", () => {
    assert.equal(runningCount([auto({ id: "a", runs: [run({ id: "r", status: "running" })] }), auto({ id: "b" })]), 1);
  });
});

describe("groupAutomations", () => {
  const here = { workspaceId: "ws1", sessionId: "S" };
  const all: Automation[] = [
    auto({ id: "mine", target: { kind: "this_session", sessionId: "S", workspaceId: "ws1" } }),
    auto({ id: "other-session", target: { kind: "this_session", sessionId: "S9", workspaceId: "ws1" } }),
    auto({ id: "routine", target: { kind: "new_session", workspaceId: "ws1" } }),
    auto({ id: "elsewhere", target: { kind: "new_session", workspaceId: "ws2" } }),
    auto({ id: "home", target: { kind: "new_session", workspaceId: null } }),
  ];

  test("本工作区：「本会话」+「这个工作区」（含绑在别的会话上的），别的工作区不出现", () => {
    const groups = groupAutomations(all, "workspace", here);
    assert.deepEqual(groups.map((g) => [g.kind, g.items.map((a) => a.id)]), [
      ["thisSession", ["mine"]],
      ["workspace", ["routine", "other-session"].sort()],
    ].map(([k, ids]) => [k, ids]));
  });

  test("全部：先「本会话」，再按工作区各一组，当前工作区排第一", () => {
    const groups = groupAutomations(all, "all", here);
    assert.equal(groups[0]?.kind, "thisSession");
    const workspaceGroups = groups.slice(1);
    assert.equal(workspaceGroups[0]?.workspaceId, "ws1");
    assert.deepEqual(workspaceGroups.map((g) => g.workspaceId).sort(), ["ws1", "ws2", null].sort());
    assert.deepEqual(workspaceGroups.find((g) => g.workspaceId === null)?.items.map((a) => a.id), ["home"]);
  });

  test("没有当前会话（首页）：没有「本会话」组；空组不出现", () => {
    const groups = groupAutomations(all, "workspace", { workspaceId: "ws3", sessionId: null });
    assert.deepEqual(groups, []);
    assert.equal(groupAutomations(all, "workspace", { workspaceId: "ws1", sessionId: null }).some((g) => g.kind === "thisSession"), false);
  });
});

describe("时间与调度的人话", () => {
  test("formatWhen：今天 / 明天 / 同年写月日星期 / 跨年带年份", () => {
    assert.equal(formatWhen(local(2026, 10, 31, 18), NOW, T), "today 18:00");
    assert.equal(formatWhen(local(2026, 11, 1, 9, 5), NOW, T), "tomorrow 09:05");
    assert.equal(formatWhen(local(2026, 11, 6, 18), NOW, T), "11-06 Fri 18:00");
    assert.equal(formatWhen(local(2027, 1, 2, 18), NOW, T), "2027-01-02 Sat 18:00");
    assert.equal(formatWhen(local(2026, 11, 6, 18), NOW, Z), "11-06 周五 18:00");
  });

  test("describeSchedule：七种规则中英文都能读", () => {
    const cases: [AutomationSchedule, string, string][] = [
      [{ kind: "interval", unit: "minute", every: 15 }, "Every 15 minutes", "每 15 分钟"],
      [{ kind: "interval", unit: "hour", every: 1 }, "Every hour", "每 1 小时"],
      [{ kind: "interval", unit: "day", every: 2 }, "Every 2 days", "每 2 天"],
      [{ kind: "hourly", minute: 5 }, "Hourly at :05", "每小时第 5 分"],
      [{ kind: "daily", time: "09:00" }, "Every day at 09:00", "每天 09:00"],
      [{ kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, "Weekdays at 09:00", "每个工作日 09:00"],
      [{ kind: "daily", time: "18:00", weekdays: [5] }, "Every Fri at 18:00", "每周五 18:00"],
      [{ kind: "daily", time: "18:00", weekdays: [1, 3] }, "Every Mon, Wed at 18:00", "每周一、周三 18:00"],
      [{ kind: "monthly", day: 1, time: "08:30" }, "Monthly on day 1 at 08:30", "每月 1 日 08:30"],
      [{ kind: "once", at: local(2026, 11, 1, 9) }, "Once · tomorrow 09:00", "一次性 · 明天 09:00"],
    ];
    for (const [schedule, english, chinese] of cases) {
      assert.equal(describeSchedule(schedule, T, NOW), english);
      assert.equal(describeSchedule(schedule, Z, NOW), chinese);
    }
  });

  test("subtitleOf：在排期的写下次；暂停 / 失败 / 完成写状态与原因；等待送达写等待", () => {
    assert.equal(subtitleOf(auto({ id: "a" }), NOW, T), "Every 15 minutes · next today 10:15");
    assert.equal(subtitleOf(auto({ id: "a", status: "paused", nextRunAt: null }), NOW, T), "Every 15 minutes · Paused");
    assert.equal(subtitleOf(auto({ id: "a", status: "failed", nextRunAt: null }), NOW, T), "Every 15 minutes · Failed");
    assert.equal(
      subtitleOf(auto({ id: "a", status: "completed", endReason: "sessionDeleted", nextRunAt: null }), NOW, Z),
      "每 15 分钟 · 已结束，它绑定的会话被删了",
    );
    assert.match(
      subtitleOf(auto({ id: "a", pendingDelivery: { since: NOW, trigger: "schedule", merged: 0 } }), NOW, T),
      /waiting for the task to be idle/,
    );
  });

  test("countLabel：有上限 3/12，没上限已运行 N 次，没跑过为空", () => {
    assert.equal(countLabel(auto({ id: "a", maxRuns: 12, runCount: 3 }), T), "3/12 runs");
    assert.equal(countLabel(auto({ id: "a", runCount: 6 }), Z), "已运行 6 次");
    assert.equal(countLabel(auto({ id: "a" }), T), "");
  });

  test("noteOf：失败态给原因；最近一次失败给提示；绑 manual 档的会话提醒会卡在审批；正常无", () => {
    assert.deepEqual(noteOf(auto({ id: "a", status: "failed", failureReason: "403" }), T, null), {
      text: "Stopped after repeated failures: 403",
      tone: "danger",
    });
    const failedLast = auto({ id: "a", runs: [run({ id: "r", status: "error", error: "boom" })] });
    assert.equal(noteOf(failedLast, T, null)?.text, "Last run failed: boom");
    const bound = auto({ id: "a", target: { kind: "this_session", sessionId: "S", workspaceId: null } });
    assert.equal(noteOf(bound, T, { mode: "manual" })?.tone, "warn");
    assert.equal(noteOf(bound, T, { mode: "skip" }), null);
    assert.equal(noteOf(auto({ id: "a", target: { kind: "new_session", workspaceId: null } }), T, { mode: "manual" }), null);
    assert.equal(noteOf(auto({ id: "a" }), T, null), null);
  });
});

describe("运行记录", () => {
  test("visibleRuns：最近 30 次，其余折成「更早 N 次」；展开全显", () => {
    const runs = Array.from({ length: AUTOMATION_RUNS_VISIBLE + 7 }, (_, i) => run({ id: `r${i}` }));
    const folded = visibleRuns({ runs }, false);
    assert.equal(folded.shown.length, AUTOMATION_RUNS_VISIBLE);
    assert.equal(folded.hidden, 7);
    assert.deepEqual(visibleRuns({ runs }, true), { shown: runs, hidden: 0 });
    assert.equal(visibleRuns({ runs: runs.slice(0, 3) }, false).hidden, 0);
  });

  test("runLine：成功 / 补跑 / 失败 / 在跑 / 跳过（带合并次数）/ 等待期间合并", () => {
    assert.deepEqual(runLine(run({ id: "a", resultExcerpt: "有 3 条新进展" }), T), { icon: "circle-check", tone: "ok", text: "有 3 条新进展" });
    assert.equal(runLine(run({ id: "a" }), T).text, "Done");
    const caught = runLine(run({ id: "a", trigger: "caughtUp", resultExcerpt: "x" }), T);
    assert.equal(caught.icon, "history");
    assert.match(caught.text, /Catch-up/);
    assert.deepEqual(runLine(run({ id: "a", status: "error", error: "GitHub 403" }), T), { icon: "triangle-alert", tone: "bad", text: "Failed: GitHub 403" });
    assert.equal(runLine(run({ id: "a", status: "running" }), T).icon, "loader-circle");
    assert.equal(runLine(run({ id: "a", status: "skipped", sessionId: null, skipReason: "overlap", repeat: 3 }), Z).text, "已跳过，上一次还在跑 ×3");
    assert.match(runLine(run({ id: "a", merged: 2, resultExcerpt: "ok" }), T).text, /2 more due while busy, merged/);
  });

  test("runWhen 与 formatTokens", () => {
    assert.equal(runWhen(run({ id: "a", runAt: local(2026, 10, 23, 18) }), NOW, Z), "10-23 周五 18:00");
    assert.equal(runWhen(run({ id: "a", runAt: local(2026, 10, 31, 9, 30) }), NOW, T), "today 09:30");
    assert.deepEqual([null, 950, 212_000, 1_250_000].map(formatTokens), ["", "950", "212k", "1.3M"]);
  });
});

describe("调度表单", () => {
  test("每种规则：规则 → 表单 → 规则 往返不变", () => {
    const rules: AutomationSchedule[] = [
      { kind: "hourly", minute: 15 },
      { kind: "daily", time: "08:30" },
      { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      { kind: "daily", time: "18:00", weekdays: [1, 5] },
      { kind: "monthly", day: 31, time: "09:00" },
      { kind: "interval", unit: "hour", every: 3 },
      { kind: "once", at: local(2026, 11, 2, 9, 30) },
    ];
    for (const rule of rules) {
      const result = scheduleFromForm(formFromSchedule(rule, NOW), NOW);
      assert.deepEqual(result, { ok: true, schedule: rule }, JSON.stringify(rule));
    }
  });

  test("预设判定：没有星期 = 每天；周一到周五 = 每工作日；其余 = 每周", () => {
    assert.equal(formFromSchedule({ kind: "daily", time: "09:00" }, NOW).preset, "daily");
    assert.equal(formFromSchedule({ kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, NOW).preset, "weekdays");
    assert.equal(formFromSchedule({ kind: "daily", time: "09:00", weekdays: [6] }, NOW).preset, "weekly");
  });

  test("填得不对回具体的错：时间 / 日期 / 星期 / 间隔 / 分钟 / 日 / 已过去", () => {
    const base = defaultScheduleForm(NOW);
    assert.deepEqual(scheduleFromForm({ ...base, preset: "daily", time: "9:00" }, NOW), { ok: false, error: "time" });
    assert.deepEqual(scheduleFromForm({ ...base, preset: "weekly", weekdays: [] }, NOW), { ok: false, error: "days" });
    assert.deepEqual(scheduleFromForm({ ...base, preset: "custom", every: 3, unit: "minute" }, NOW), { ok: false, error: "interval" });
    assert.deepEqual(scheduleFromForm({ ...base, preset: "hourly", minute: 60 }, NOW), { ok: false, error: "minute" });
    assert.deepEqual(scheduleFromForm({ ...base, preset: "monthly", monthDay: 0 }, NOW), { ok: false, error: "monthDay" });
    assert.deepEqual(scheduleFromForm({ ...base, preset: "once", date: "后天" }, NOW), { ok: false, error: "date" });
    assert.deepEqual(scheduleFromForm({ ...base, preset: "once", date: "2026-10-31", time: "09:00" }, NOW), { ok: false, error: "past" });
    assert.equal(scheduleFromForm({ ...base, preset: "once", date: "2026-10-31", time: "11:00" }, NOW).ok, true);
  });

  test("默认表单：每天 09:00，once 默认明天，星期默认今天", () => {
    const form = defaultScheduleForm(NOW);
    assert.equal(form.preset, "daily");
    assert.equal(form.time, "09:00");
    assert.equal(form.date, "2026-11-01");
    assert.deepEqual(form.weekdays, [6]);
  });

  test("previewTimes：接下来 N 次；once 只有一次；until 之后的不算", () => {
    const daily: AutomationSchedule = { kind: "daily", time: "18:00", weekdays: [5] };
    assert.deepEqual(previewTimes(daily, NOW, 3), [local(2026, 11, 6, 18), local(2026, 11, 13, 18), local(2026, 11, 20, 18)]);
    assert.deepEqual(previewTimes(daily, NOW, 3, local(2026, 11, 14)), [local(2026, 11, 6, 18), local(2026, 11, 13, 18)]);
    assert.deepEqual(previewTimes({ kind: "once", at: local(2026, 11, 2, 9) }, NOW, 3), [local(2026, 11, 2, 9)]);
    assert.deepEqual(previewTimes({ kind: "once", at: NOW - 1 }, NOW, 3), []);
  });
});

describe("结束表单", () => {
  test("永不 / N 次 / 指定日期（取当天日末）；已有任务回填", () => {
    assert.deepEqual(endFromForm({ mode: "never", count: 12, date: "" }, NOW), { ok: true, maxRuns: null, until: null });
    assert.deepEqual(endFromForm({ mode: "count", count: 5, date: "" }, NOW), { ok: true, maxRuns: 5, until: null });
    const byDate = endFromForm({ mode: "date", count: 1, date: "2026-11-05" }, NOW);
    assert.deepEqual(byDate, { ok: true, maxRuns: null, until: new Date(2026, 10, 5, 23, 59, 59, 999).getTime() });
    assert.equal(endFormFrom({ maxRuns: 7 }, NOW).mode, "count");
    assert.equal(endFormFrom({ maxRuns: 7 }, NOW).count, 7);
    assert.equal(endFormFrom({ until: local(2026, 11, 5, 23, 59) }, NOW).date, "2026-11-05");
    assert.equal(endFormFrom(null, NOW).mode, "never");
  });

  test("次数不是正整数 / 日期不对 / 已过去：回具体的错", () => {
    assert.deepEqual(endFromForm({ mode: "count", count: 0, date: "" }, NOW), { ok: false, error: "count" });
    assert.deepEqual(endFromForm({ mode: "count", count: 1.5, date: "" }, NOW), { ok: false, error: "count" });
    assert.deepEqual(endFromForm({ mode: "date", count: 1, date: "明天" }, NOW), { ok: false, error: "date" });
    assert.deepEqual(endFromForm({ mode: "date", count: 1, date: "2026-10-30" }, NOW), { ok: false, error: "past" });
  });
});

test("模型选项值：provider 与型号往返；空串 = 默认", () => {
  assert.deepEqual(parseModelOption(modelOptionValue("zai", "glm-5.3")), { providerId: "zai", modelId: "glm-5.3" });
  assert.deepEqual(parseModelOption(modelOptionValue("p", "m/with::odd")), { providerId: "p", modelId: "m/with::odd" });
  assert.equal(parseModelOption(""), null);
});
