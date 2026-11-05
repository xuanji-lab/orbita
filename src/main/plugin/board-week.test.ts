/**
 * 全局周看板的数据：周边界（本地时区、跨月跨年、夏令时）、planned 按各种 schedule 推算、
 * 从运行记录 + 会话里的快照装配 board:week、按行粗筛读会话。
 * 时区靠改 process.env.TZ（Node 赋值时会重置时区缓存）；每个 describe 自己设、结束复原。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Automation, AutomationRun, AutomationSchedule } from "../../shared/automation.ts";
import { localDayStart, localWeekStart, type BoardCardSnapshot, type PluginBoardResult } from "../../shared/plugin-board.ts";
import { assembleBoardWeek, mergeRunCards, plannedTimes, readBoardSnapshots } from "./board-week.ts";

const HOUR = 3_600_000;
const originalTz = process.env["TZ"];

function useTz(tz: string): void {
  before(() => {
    process.env["TZ"] = tz;
  });
  after(() => {
    if (originalTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = originalTz;
  });
}

/** 本地时间的毫秒（月份 1 起） */
const local = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

function automation(over: Partial<Automation> & { schedule: AutomationSchedule }): Automation {
  return {
    id: "a1",
    title: "文献追踪",
    prompt: "go",
    target: { kind: "new_session", workspaceId: "ws-1" },
    mode: "plan",
    status: "active",
    createdBy: { kind: "user" },
    nextRunAt: null,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function run(over: Partial<AutomationRun> & { runAt: number }): AutomationRun {
  return { id: `r${over.runAt}`, trigger: "schedule", status: "success", sessionId: "s-1", durationMs: 1, tokens: null, ...over };
}

function card(id: string, index = 0, data: unknown = null): BoardCardSnapshot {
  return { id, title: id, size: "1x1", index, template: "a".repeat(64), data, state: data === null ? "empty" : "ready", usingSample: false, updatedAt: null };
}

function board(cards: BoardCardSnapshot[], over: Partial<PluginBoardResult> = {}): PluginBoardResult {
  return { plugin: "lit", displayName: "文献追踪", title: "t", source: "installed", draftPath: null, at: 0, tuned: false, cards, skipped: [], ...over };
}

describe("周边界 · Asia/Singapore", () => {
  useTz("Asia/Singapore");

  test("任意时刻 → 当地周一 00:00；周日归上一周；跨月、跨年", () => {
    assert.equal(localWeekStart(local(2026, 11, 5, 22, 48)), local(2026, 11, 2));
    assert.equal(localWeekStart(local(2026, 11, 2)), local(2026, 11, 2));
    assert.equal(localWeekStart(local(2026, 11, 8, 23, 59)), local(2026, 11, 2));
    assert.equal(localWeekStart(local(2026, 12, 2, 8)), local(2026, 11, 30));
    assert.equal(localWeekStart(local(2027, 1, 1, 12)), local(2026, 12, 28));
    // 本地时区而非 UTC：新加坡周一 03:00 在 UTC 还是周日
    assert.equal(new Date(local(2026, 11, 2, 3)).getUTCDay(), 0);
    assert.equal(localWeekStart(local(2026, 11, 2, 3)), local(2026, 11, 2));
  });

  test("跨月的那一周：7 天依次是 11/30 … 12/06", () => {
    const start = local(2026, 11, 30);
    const days = Array.from({ length: 7 }, (_, i) => new Date(localDayStart(start, i)).getDate());
    assert.deepEqual(days, [30, 1, 2, 3, 4, 5, 6]);
  });
});

describe("周边界 · America/New_York（夏令时）", () => {
  useTz("America/New_York");

  test("秋季回拨那周：周日 25 小时；春季那周：周日 23 小时；天边界都在本地 00:00", async () => {
    const fall = await assembleBoardWeek({ automations: async () => [], recordPath: () => "", now: () => 0 }, local(2026, 10, 28, 12));
    assert.ok(fall !== null);
    assert.equal(fall.weekStart, local(2026, 10, 26));
    assert.equal(fall.days.length, 7);
    assert.equal((fall.days[6]?.end ?? 0) - (fall.days[6]?.start ?? 0), 25 * HOUR);
    for (const day of fall.days) assert.equal(new Date(day.start).getHours(), 0);
    const spring = await assembleBoardWeek({ automations: async () => [], recordPath: () => "", now: () => 0 }, local(2026, 3, 4));
    assert.equal((spring?.days[6]?.end ?? 0) - (spring?.days[6]?.start ?? 0), 23 * HOUR);
  });

  test("daily 09:00 跨过回拨日：每天都是本地 09:00，每天一次", () => {
    const weekStart = local(2026, 10, 26);
    const times = plannedTimes(automation({ schedule: { kind: "daily", time: "09:00" }, nextRunAt: local(2026, 10, 26, 9) }), weekStart, localDayStart(weekStart, 7), 0);
    assert.equal(times.length, 7);
    for (const at of times) assert.equal(new Date(at).getHours(), 9);
    assert.equal(new Date(times[6] ?? 0).getDate(), 1);
  });
});

describe("planned 推算 · Asia/Singapore", () => {
  useTz("Asia/Singapore");
  // 惰性取：describe 体在 before 钩子（设 TZ）之前就执行了
  let weekStart = 0;
  let weekEnd = 0;
  before(() => {
    weekStart = local(2026, 11, 2);
    weekEnd = local(2026, 11, 9);
  });

  test("daily + weekdays：只在周一到周五", () => {
    const a = automation({ schedule: { kind: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: local(2026, 11, 2, 8, 30) });
    const times = plannedTimes(a, weekStart, weekEnd, weekStart);
    assert.deepEqual(times.map((at) => new Date(at).getDay()), [1, 2, 3, 4, 5]);
  });

  test("今天只给剩下的：早于 now 的不算", () => {
    const a = automation({ schedule: { kind: "daily", time: "08:30" }, nextRunAt: local(2026, 11, 5, 8, 30) });
    const times = plannedTimes(a, weekStart, weekEnd, local(2026, 11, 5, 10));
    assert.deepEqual(times.map((at) => new Date(at).getDate()), [6, 7, 8]);
  });

  test("once：在这周就一次，不在就没有", () => {
    const a = automation({ schedule: { kind: "once", at: local(2026, 11, 4, 15) }, nextRunAt: local(2026, 11, 4, 15) });
    assert.deepEqual(plannedTimes(a, weekStart, weekEnd, weekStart), [local(2026, 11, 4, 15)]);
    assert.deepEqual(plannedTimes(a, local(2026, 11, 9), local(2026, 11, 16), weekStart), []);
  });

  test("interval：起点远早于这周时跳格；每天最多 24 次", () => {
    const a = automation({ schedule: { kind: "interval", unit: "minute", every: 30 }, nextRunAt: local(2026, 10, 1, 0, 10) });
    const times = plannedTimes(a, weekStart, weekEnd, 0);
    assert.equal(times.length, 7 * 24);
    assert.equal(times[0], local(2026, 11, 2, 0, 10));
    // 一天的前 24 次（每 30 分钟 → 到 11:40 为止）
    assert.equal(times[23], local(2026, 11, 2, 11, 40));
  });

  test("hourly：每天 24 次，都在第 15 分", () => {
    const a = automation({ schedule: { kind: "hourly", minute: 15 }, nextRunAt: local(2026, 11, 2, 0, 15) });
    const times = plannedTimes(a, weekStart, weekEnd, 0);
    assert.equal(times.length, 7 * 24);
    assert.ok(times.every((at) => new Date(at).getMinutes() === 15));
  });

  test("monthly 31 日：11 月落在 30 日（月末）", () => {
    const start = local(2026, 11, 30);
    const a = automation({ schedule: { kind: "monthly", day: 31, time: "09:00" }, nextRunAt: local(2026, 11, 30, 9) });
    assert.deepEqual(plannedTimes(a, start, localDayStart(start, 7), 0), [local(2026, 11, 30, 9)]);
    // 下一次是 12/31，不在这周
    const b = automation({ schedule: { kind: "monthly", day: 31, time: "09:00" }, nextRunAt: local(2026, 10, 31, 9) });
    assert.deepEqual(plannedTimes(b, start, localDayStart(start, 7), 0), [local(2026, 11, 30, 9)]);
  });

  test("暂停 / 完成 / 失败的不算；maxRuns 只排剩下的；until 之后不排", () => {
    const base = { schedule: { kind: "daily", time: "09:00" } as AutomationSchedule, nextRunAt: local(2026, 11, 2, 9) };
    for (const status of ["paused", "completed", "failed"] as const) {
      assert.deepEqual(plannedTimes(automation({ ...base, status }), weekStart, weekEnd, 0), [], status);
    }
    assert.equal(plannedTimes(automation({ ...base, maxRuns: 12, runCount: 10 }), weekStart, weekEnd, 0).length, 2);
    assert.equal(plannedTimes(automation({ ...base, until: local(2026, 11, 4, 12) }), weekStart, weekEnd, 0).length, 3);
    assert.deepEqual(plannedTimes(automation({ ...base, nextRunAt: null }), weekStart, weekEnd, 0), []);
  });
});

describe("assembleBoardWeek · Asia/Singapore", () => {
  useTz("Asia/Singapore");

  test("入参不可信：非有限数回 null；不是周一的规整到周一", async () => {
    const deps = { automations: async () => [], recordPath: () => "", now: () => 0 };
    assert.equal(await assembleBoardWeek(deps, Number.NaN), null);
    assert.equal(await assembleBoardWeek(deps, "x"), null);
    assert.equal((await assembleBoardWeek(deps, local(2026, 11, 5, 13)))?.weekStart, local(2026, 11, 2));
  });

  test("过去的运行进 items（带快照、按天、升序）；skipped 与这周之外的不进；未来进 planned", async () => {
    const now = local(2026, 11, 5, 12);
    const a = automation({
      plugin: { name: "lit" },
      schedule: { kind: "daily", time: "08:30" },
      nextRunAt: local(2026, 11, 6, 8, 30),
      runs: [
        run({ runAt: local(2026, 11, 5, 8, 30), sessionId: "s-thu", boardSnapshotIds: ["c1", "c2"] }),
        run({ runAt: local(2026, 11, 4, 8, 30), sessionId: "s-wed", status: "error", boardSnapshotIds: ["missing"] }),
        run({ runAt: local(2026, 11, 3, 8, 30), status: "skipped", sessionId: null }),
        run({ runAt: local(2026, 11, 1, 8, 30), sessionId: "s-last-week", boardSnapshotIds: ["c0"] }),
      ],
    });
    const other = automation({ id: "a2", title: "周报", schedule: { kind: "daily", time: "07:00" }, nextRunAt: local(2026, 11, 6, 7), target: { kind: "new_session", workspaceId: null } });
    const reads: [string, string[]][] = [];
    const week = await assembleBoardWeek(
      {
        automations: async () => [a, other],
        recordPath: (id) => `/sessions/${id}.jsonl`,
        now: () => now,
        readSnapshots: async (path, ids) => {
          reads.push([path, [...ids].sort()]);
          if (path !== "/sessions/s-thu.jsonl") return new Map();
          return new Map([
            ["c1", board([card("today", 0, { v: 1 }), card("papers", 0, { t: "a" })])],
            ["c2", board([card("today", 0, { v: 2 })], { displayName: "文献追踪 v2" })],
          ]);
        },
      },
      local(2026, 11, 2),
    );
    assert.ok(week !== null);
    assert.equal(week.now, now);
    // 只读这周的会话，每条一遍
    assert.deepEqual(reads, [
      ["/sessions/s-thu.jsonl", ["c1", "c2"]],
      ["/sessions/s-wed.jsonl", ["missing"]],
    ]);
    const [mon, tue, wed, thu, fri, sat, sun] = week.days;
    assert.deepEqual([mon?.items.length, tue?.items.length], [0, 0]);
    assert.equal(wed?.items[0]?.status, "error");
    assert.deepEqual(wed?.items[0]?.cards, []);
    const item = thu?.items[0];
    assert.equal(item?.automationTitle, "文献追踪");
    assert.equal(item?.plugin, "lit");
    assert.equal(item?.pluginTitle, "文献追踪 v2");
    assert.equal(item?.sessionId, "s-thu");
    assert.equal(item?.workspaceId, "ws-1");
    // 同一张卡后一次覆盖前一次
    assert.deepEqual(item?.cards.map((each) => [each.id, each.data]), [["today", { v: 2 }], ["papers", { t: "a" }]]);
    // 过去的天没有 planned；今天剩下的与未来的有
    assert.deepEqual([mon, tue, wed, thu].map((day) => day?.planned.length), [0, 0, 0, 0]);
    assert.deepEqual(fri?.planned.map((each) => [each.title, new Date(each.at).getHours()]), [["周报", 7], ["文献追踪", 8]]);
    assert.equal(fri?.planned[1]?.plugin, "lit");
    assert.equal(fri?.planned[0]?.plugin, null);
    assert.equal(sat?.planned.length, 2);
    assert.equal(sun?.planned.length, 2);
  });

  test("mergeRunCards：按 id + index 合并，后来的赢", () => {
    const merged = mergeRunCards([board([card("a", 0, 1), card("a", 1, 2)]), board([card("a", 1, 3)])]);
    assert.deepEqual(merged.map((each) => [each.id, each.index, each.data]), [["a", 0, 1], ["a", 1, 3]]);
  });
});

describe("readBoardSnapshots", () => {
  test("只解码点名的 show_plugin_board 结果；错误结果、别的工具、坏行都跳过；文件不在回空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-board-week-"));
    try {
      const file = join(dir, "s.jsonl");
      const good = board([card("today", 0, { ok: true })]);
      const lines = [
        JSON.stringify({ id: "1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ id: "2", role: "tool", toolCallId: "c-read", toolName: "read", input: {}, content: [{ type: "text", text: "x".repeat(100_000) }], status: "complete", isError: false }),
        JSON.stringify({ id: "3", role: "tool", toolCallId: "c1", toolName: "show_plugin_board", input: {}, content: [], details: { pluginBoard: good }, status: "complete", isError: false }),
        JSON.stringify({ id: "4", role: "tool", toolCallId: "c2", toolName: "show_plugin_board", input: {}, content: [], details: { pluginBoard: good }, status: "error", isError: true }),
        JSON.stringify({ id: "5", role: "tool", toolCallId: "c3", toolName: "show_plugin_board", input: {}, content: [], details: { pluginBoard: good }, status: "complete", isError: false }),
        "{ not json",
      ];
      await writeFile(file, `${lines.join("\n")}\n`);
      const found = await readBoardSnapshots(file, new Set(["c1", "c2", "c-read"]));
      assert.deepEqual([...found.keys()], ["c1"]);
      assert.deepEqual(found.get("c1"), good);
      assert.equal((await readBoardSnapshots(join(dir, "gone.jsonl"), new Set(["c1"]))).size, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
