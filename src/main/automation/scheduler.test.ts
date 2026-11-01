import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  AUTOMATION_MAX_RUNS_PER_DAY,
  type Automation,
  type AutomationRun,
  type AutomationRunTrigger,
} from "../../shared/automation.ts";
import { makeAutomation } from "./fixtures.ts";
import {
  AutomationScheduler,
  LATE_MS,
  MAX_CONCURRENT_RUNS,
  RUN_TIMEOUT_MS,
  TICK_MS,
  applyRunResult,
  endReasonOf,
  planFire,
  planPending,
} from "./scheduler.ts";
import { AutomationStore } from "./store.ts";

const T0 = new Date(2026, 9, 31, 10, 0, 0, 0).getTime();
const MIN = 60_000;

const run = (patch: Partial<AutomationRun> & { id: string }): AutomationRun => ({
  runAt: T0,
  trigger: "schedule",
  status: "success",
  sessionId: null,
  durationMs: 1,
  tokens: null,
  ...patch,
});

/* ---------- 纯决策 ---------- */

describe("planFire：到点触发", () => {
  const due = makeAutomation({ id: "a", nextRunAt: T0 });
  const base = { now: T0, trigger: "schedule" as const, busy: false, runId: "run1", sessionId: "s1" };

  test("没到点 / 不是 active：什么都不做", () => {
    assert.equal(planFire({ ...due, nextRunAt: T0 + 1 }, base).kind, "none");
    assert.equal(planFire({ ...due, status: "paused", nextRunAt: null }, base).kind, "none");
    assert.equal(planFire({ ...due, status: "failed", nextRunAt: null }, base).kind, "none");
  });

  test("该跑：记一条 running、runCount + 1、从现在重排下一次", () => {
    const plan = planFire(due, base);
    assert.equal(plan.kind, "go");
    if (plan.kind !== "go") return;
    assert.equal(plan.number, 1);
    assert.equal(plan.next.runCount, 1);
    assert.equal(plan.next.nextRunAt, T0 + 15 * MIN);
    assert.deepEqual(plan.next.runs[0], {
      id: "run1",
      runAt: T0,
      trigger: "schedule",
      status: "running",
      sessionId: "s1",
      durationMs: null,
      tokens: null,
    });
  });

  test("new_session 上一次还在跑：记 skipped(overlap) 并照常重排，不排队；连续同因合并成一条", () => {
    const first = planFire(due, { ...base, busy: true });
    assert.equal(first.kind, "skipped");
    if (first.kind !== "skipped") return;
    assert.equal(first.next.runCount, 0, "skipped 不算跑过");
    assert.equal(first.next.runs.length, 1);
    assert.equal(first.next.runs[0]?.skipReason, "overlap");
    assert.equal(first.next.nextRunAt, T0 + 15 * MIN);
    const second = planFire({ ...first.next, nextRunAt: T0 + 15 * MIN }, { ...base, now: T0 + 15 * MIN, busy: true, runId: "run2" });
    assert.equal(second.kind, "skipped");
    if (second.kind !== "skipped") return;
    assert.equal(second.next.runs.length, 1, "合并而不是新增");
    assert.equal(second.next.runs[0]?.repeat, 2);
    assert.equal(second.next.runs[0]?.runAt, T0 + 15 * MIN);
  });

  test("24 小时内已跑满 24 次：记 skipped(dailyCap)；skipped 本身与 24 小时前的不计", () => {
    const runs = Array.from({ length: AUTOMATION_MAX_RUNS_PER_DAY }, (_, i) => run({ id: `r${i}`, runAt: T0 - (i + 1) * MIN }));
    const capped = planFire({ ...due, runs }, base);
    assert.equal(capped.kind, "skipped");
    if (capped.kind === "skipped") assert.equal(capped.next.runs[0]?.skipReason, "dailyCap");
    const oneOld = runs.map((r, i) => (i === 0 ? { ...r, runAt: T0 - 25 * 60 * MIN } : r));
    assert.equal(planFire({ ...due, runs: oneOld }, base).kind, "go");
    const oneSkipped = runs.map((r, i) => (i === 0 ? { ...r, status: "skipped" as const } : r));
    assert.equal(planFire({ ...due, runs: oneSkipped }, base).kind, "go");
  });

  test("终点：maxRuns 用完 → completed(finished)；until 过了 → completed(expired)；都没有运行记录", () => {
    const finished = planFire({ ...due, maxRuns: 3, runCount: 3 }, base);
    assert.equal(finished.kind, "ended");
    if (finished.kind === "ended") {
      assert.equal(finished.next.status, "completed");
      assert.equal(finished.next.endReason, "finished");
      assert.equal(finished.next.nextRunAt, null);
    }
    const expired = planFire({ ...due, until: T0 - 1 }, base);
    assert.equal(expired.kind === "ended" && expired.next.endReason, "expired");
  });

  test("下一次排到 until 之外：这次照跑，nextRunAt 置 null，收尾时再 completed", () => {
    const plan = planFire({ ...due, until: T0 + 5 * MIN }, base);
    assert.equal(plan.kind, "go");
    if (plan.kind === "go") {
      assert.equal(plan.next.nextRunAt, null);
      assert.equal(plan.next.status, "active");
    }
  });

  test("once：触发后 nextRunAt 置 null", () => {
    const plan = planFire({ ...due, schedule: { kind: "once", at: T0 } }, base);
    assert.equal(plan.kind === "go" && plan.next.nextRunAt, null);
  });
});

describe("planFire：手动触发", () => {
  const active = makeAutomation({ id: "a", nextRunAt: T0 + 10 * MIN });
  const base = { now: T0, trigger: "manual" as const, busy: false, runId: "run1", sessionId: "s1" };

  test("active 与 paused 能手动跑，且不动排期", () => {
    for (const status of ["active", "paused"] as const) {
      const plan = planFire({ ...active, status, nextRunAt: status === "active" ? T0 + 10 * MIN : null }, base);
      assert.equal(plan.kind, "go", status);
      if (plan.kind === "go") assert.equal(plan.next.nextRunAt, status === "active" ? T0 + 10 * MIN : null);
    }
  });

  test("failed / completed 先重新启动；在跑时拒；终点到了拒；24 次上限拒——每条都回一句话", () => {
    for (const status of ["failed", "completed"] as const) {
      assert.equal(planFire({ ...active, status }, base).kind, "refused", status);
    }
    assert.equal(planFire(active, { ...base, busy: true }).kind, "refused");
    assert.equal(planFire({ ...active, maxRuns: 1, runCount: 1 }, base).kind, "refused");
    const runs = Array.from({ length: AUTOMATION_MAX_RUNS_PER_DAY }, (_, i) => run({ id: `r${i}`, runAt: T0 - (i + 1) * MIN }));
    const capped = planFire({ ...active, runs }, base);
    assert.equal(capped.kind, "refused");
    if (capped.kind === "refused") assert.match(capped.error, /24/);
  });
});

describe("planFire / planPending：this_session", () => {
  const bound = makeAutomation({
    id: "t",
    target: { kind: "this_session", sessionId: "S", workspaceId: null },
    nextRunAt: T0,
    maxRuns: 12,
  });
  const base = { now: T0, trigger: "schedule" as const, busy: false, runId: "run1", sessionId: "S" };

  test("会话空闲：直接送，运行记录指向目标会话", () => {
    const plan = planFire(bound, base);
    assert.equal(plan.kind, "go");
    if (plan.kind === "go") assert.equal(plan.next.runs[0]?.sessionId, "S");
  });

  test("会话在忙：进入等待（pendingDelivery），照常重排、不记运行、不叠加；等待期间再到点只 merged + 1", () => {
    const first = planFire(bound, { ...base, busy: true });
    assert.equal(first.kind, "waiting");
    if (first.kind !== "waiting") return;
    assert.deepEqual(first.next.pendingDelivery, { since: T0, trigger: "schedule", merged: 0 });
    assert.equal(first.next.runCount, 0);
    assert.equal(first.next.runs.length, 0);
    assert.equal(first.next.nextRunAt, T0 + 15 * MIN);
    const second = planFire(first.next, { ...base, now: T0 + 15 * MIN, trigger: "caughtUp", busy: true });
    assert.equal(second.kind, "waiting");
    if (second.kind === "waiting") {
      // 等待中的触发方式沿用最先到点的那次，不被后来的覆盖
      assert.deepEqual(second.next.pendingDelivery, { since: T0, trigger: "schedule", merged: 1 });
    }
  });

  test("planPending：会话还忙就继续等；空闲了送一次，merged 写进运行记录，pendingDelivery 清掉，不重排", () => {
    const waiting: Automation = { ...bound, nextRunAt: T0 + 15 * MIN, pendingDelivery: { since: T0, trigger: "caughtUp", merged: 2 } };
    assert.equal(planPending(waiting, { now: T0 + MIN, busy: true, runId: "r", sessionId: "S" }).kind, "none");
    const plan = planPending(waiting, { now: T0 + MIN, busy: false, runId: "r", sessionId: "S" });
    assert.equal(plan.kind, "go");
    if (plan.kind !== "go") return;
    assert.equal(plan.next.pendingDelivery, undefined);
    assert.equal(plan.next.nextRunAt, T0 + 15 * MIN, "进入等待时已经排过了，这里不再动");
    assert.equal(plan.next.runs[0]?.merged, 2);
    assert.equal(plan.next.runs[0]?.trigger, "caughtUp");
    assert.equal(plan.next.runCount, 1);
  });

  test("planPending：没有等待项 / 不是 active 什么都不做；maxRuns 已满则直接完成；24 次上限丢弃并记 skipped", () => {
    assert.equal(planPending(bound, { now: T0, busy: false, runId: "r", sessionId: "S" }).kind, "none");
    const waiting: Automation = { ...bound, pendingDelivery: { since: T0, trigger: "schedule", merged: 0 } };
    assert.equal(planPending({ ...waiting, status: "paused" }, { now: T0, busy: false, runId: "r", sessionId: "S" }).kind, "none");
    const full = planPending({ ...waiting, runCount: 12 }, { now: T0, busy: false, runId: "r", sessionId: "S" });
    assert.equal(full.kind === "ended" && full.next.pendingDelivery, undefined);
    assert.equal(full.kind, "ended");
    const runs = Array.from({ length: AUTOMATION_MAX_RUNS_PER_DAY }, (_, i) => run({ id: `r${i}`, runAt: T0 - (i + 1) * MIN }));
    const capped = planPending({ ...waiting, runs }, { now: T0, busy: false, runId: "r", sessionId: "S" });
    assert.equal(capped.kind, "skipped");
    if (capped.kind === "skipped") assert.equal(capped.next.pendingDelivery, undefined);
  });

  test("到点恰好会话刚空、还有一个悬空的等待：并进这一次，不留下等待", () => {
    const stale: Automation = { ...bound, pendingDelivery: { since: T0 - MIN, trigger: "schedule", merged: 0 } };
    const plan = planFire(stale, base);
    assert.equal(plan.kind, "go");
    if (plan.kind === "go") {
      assert.equal(plan.next.pendingDelivery, undefined);
      assert.equal(plan.next.runs[0]?.merged, 1);
    }
  });
});

describe("applyRunResult", () => {
  const running = (patch: Partial<Automation> = {}): Automation =>
    makeAutomation({
      id: "a",
      runCount: 1,
      nextRunAt: T0 + 15 * MIN,
      runs: [run({ id: "r1", status: "running", sessionId: "s1" })],
      ...patch,
    });

  test("成功：翻终态、摘录截 300 字、清连续失败、new_session 记下上次结果", () => {
    const long = "字".repeat(500);
    const next = applyRunResult(running({ consecutiveFailures: 2 }), "r1", { status: "success", durationMs: 90, tokens: 1234, answer: long }, T0);
    assert.equal(next.runs[0]?.status, "success");
    assert.equal(next.runs[0]?.tokens, 1234);
    assert.equal(next.runs[0]?.durationMs, 90);
    assert.equal([...(next.runs[0]?.resultExcerpt ?? "")].length, 301); // 300 字 + 省略号
    assert.equal(next.consecutiveFailures, 0);
    assert.equal(next.status, "active");
    assert.equal([...(next.lastResult ?? "")].length, 500);
  });

  test("this_session 成功不存上次结果", () => {
    const next = applyRunResult(
      running({ target: { kind: "this_session", sessionId: "S", workspaceId: null } }),
      "r1",
      { status: "success", durationMs: 1, tokens: null, answer: "好了" },
      T0,
    );
    assert.equal(next.lastResult, undefined);
    assert.equal(next.runs[0]?.resultExcerpt, "好了");
  });

  test("连续失败 3 次：进入 failed，带原因，排期清空；前两次仍是 active", () => {
    let current = running();
    for (let i = 1; i <= 3; i += 1) {
      current = applyRunResult(current, `r${i}`, { status: "error", durationMs: 1, tokens: null, error: `第 ${i} 次挂了` }, T0);
      if (i < 3) {
        assert.equal(current.status, "active");
        assert.equal(current.consecutiveFailures, i);
        current = { ...current, runs: [run({ id: `r${i + 1}`, status: "running" }), ...current.runs] };
      }
    }
    assert.equal(current.status, "failed");
    assert.equal(current.failureReason, "第 3 次挂了");
    assert.equal(current.nextRunAt, null);
  });

  test("notCounted 的失败（应用退出被打断）不计连续失败", () => {
    const next = applyRunResult(running({ consecutiveFailures: 2 }), "r1", { status: "error", durationMs: 1, tokens: null, error: "x", notCounted: true }, T0);
    assert.equal(next.consecutiveFailures, 2);
    assert.equal(next.status, "active");
  });

  test("跑满 maxRuns：completed(finished)；once / 越过 until 排不出下一次：completed(finished / expired)", () => {
    const maxed = applyRunResult(running({ maxRuns: 1 }), "r1", { status: "success", durationMs: 1, tokens: null, answer: "x" }, T0);
    assert.equal(maxed.status, "completed");
    assert.equal(maxed.endReason, "finished");
    assert.equal(maxed.nextRunAt, null);
    const once = applyRunResult(running({ schedule: { kind: "once", at: T0 }, nextRunAt: null }), "r1", { status: "success", durationMs: 1, tokens: null }, T0);
    assert.equal(once.endReason, "finished");
    const beyond = applyRunResult(running({ nextRunAt: null }), "r1", { status: "success", durationMs: 1, tokens: null }, T0);
    assert.equal(beyond.endReason, "expired");
  });

  test("paused 中途收尾的运行不改状态；找不到这次运行（被挤出历史）原样返回", () => {
    const paused = applyRunResult(running({ status: "paused", nextRunAt: null }), "r1", { status: "success", durationMs: 1, tokens: null }, T0);
    assert.equal(paused.status, "paused");
    const base = running();
    assert.equal(applyRunResult(base, "nope", { status: "success", durationMs: 1, tokens: null }, T0), base);
  });

  test("endReasonOf：次数与日期两种终点", () => {
    assert.equal(endReasonOf(makeAutomation({ id: "a", maxRuns: 2, runCount: 2 }), T0), "finished");
    assert.equal(endReasonOf(makeAutomation({ id: "a", until: T0 - 1 }), T0), "expired");
    assert.equal(endReasonOf(makeAutomation({ id: "a", maxRuns: 2, runCount: 1, until: T0 + 1 }), T0), null);
  });
});

/* ---------- 调度器（假时钟 + 假 launch / deliver，不起真模型） ---------- */

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-automation-scheduler-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Launched {
  sessionId: string;
  number: number;
  at: number;
  trigger: AutomationRunTrigger;
  automation: Automation;
}

function harness(options: { launchError?: Error; deliverError?: Error } = {}) {
  const clock = { now: T0 };
  const store = new AutomationStore(dir);
  const launches: Launched[] = [];
  const delivers: { number: number; at: number; automation: Automation }[] = [];
  const aborts: string[] = [];
  const activeChanges: number[] = [];
  const state = { enabled: true, notifies: 0 };
  const busy = new Set<string>();
  const existing = new Set<string>(["S", "S2"]);
  let counter = 0;
  const scheduler = new AutomationScheduler({
    store,
    now: () => clock.now,
    enabled: async () => state.enabled,
    launch: async (input) => {
      launches.push(input);
      if (options.launchError !== undefined) throw options.launchError;
    },
    deliver: async (input) => {
      delivers.push(input);
      if (options.deliverError !== undefined) throw options.deliverError;
    },
    sessionExists: async (id) => existing.has(id),
    isSessionBusy: (id) => busy.has(id),
    abort: async (id) => {
      aborts.push(id);
    },
    notify: () => {
      state.notifies += 1;
    },
    onActiveChange: (count) => activeChanges.push(count),
    newId: () => `id${(counter += 1)}`,
  });
  /**
   * 等串行队列里排着的事都跑完（事件收尾是异步入队的，store 写盘是真文件 I/O，光让出事件循环不够）。
   * 给了 until 就轮询到条件成立（最多 2 秒），没给就等一小段固定时间。
   */
  const settled = async (until?: () => boolean): Promise<void> => {
    if (until === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return;
    }
    for (let i = 0; i < 200 && !until(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { clock, store, scheduler, launches, delivers, aborts, activeChanges, state, busy, existing, settled };
}

const answerEvent = (sessionId: string, text: string): AgentEvent => ({
  type: "progress",
  sessionId,
  progress: {
    type: "item_finished",
    item: {
      id: `a-${sessionId}-${text.length}`,
      role: "assistant",
      content: [{ type: "text", text }],
      model: { provider: "p", id: "m" },
      timestamp: T0,
      status: "complete",
      stopReason: "stop",
    },
  },
});
const statsEvent = (sessionId: string, total: number): AgentEvent => ({
  type: "stats",
  sessionId,
  stats: { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total }, cost: 0, contextUsage: null },
});
const idleEvent = (sessionId: string): AgentEvent => ({ type: "phase", sessionId, phase: "idle" });

describe("AutomationScheduler：new_session", () => {
  test("到点开一次会话；收到最终回答 + 用量 + idle 后收尾成 success，记摘录 / tokens / 上次结果", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 }));
    await h.scheduler.tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]?.number, 1);
    assert.equal(h.launches[0]?.trigger, "schedule");
    assert.equal(h.scheduler.activeCount(), 1);
    const sessionId = h.launches[0]?.sessionId ?? "";
    const mid = await h.store.get("a");
    assert.equal(mid?.runs[0]?.status, "running");
    assert.equal(mid?.runs[0]?.sessionId, sessionId);
    assert.equal(mid?.nextRunAt, T0 + 15 * MIN);

    h.clock.now = T0 + 90_000;
    h.scheduler.onAgentEvent(answerEvent(sessionId, "这周有 3 条新进展"));
    h.scheduler.onAgentEvent(statsEvent(sessionId, 4321));
    h.scheduler.onAgentEvent(idleEvent(sessionId));
    await h.settled();

    const done = await h.store.get("a");
    assert.equal(done?.runs[0]?.status, "success");
    assert.equal(done?.runs[0]?.durationMs, 90_000);
    assert.equal(done?.runs[0]?.tokens, 4321);
    assert.equal(done?.runs[0]?.resultExcerpt, "这周有 3 条新进展");
    assert.equal(done?.lastResult, "这周有 3 条新进展");
    assert.equal(done?.runCount, 1);
    assert.equal(h.scheduler.activeCount(), 0);
    assert.deepEqual(h.activeChanges, [1, 0]);
    assert.ok(h.state.notifies >= 2);
  });

  test("下一次发出去的 automation 快照带着上一次的「上次结果」", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0, lastResult: "上次说了 X" }));
    await h.scheduler.tick();
    assert.equal(h.launches[0]?.automation.lastResult, "上次说了 X");
  });

  test("开关关着：tick 什么都不做", async () => {
    const h = harness();
    h.state.enabled = false;
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 }));
    await h.scheduler.tick();
    assert.equal(h.launches.length, 0);
    assert.equal((await h.store.get("a"))?.runs.length, 0);
    const refused = await h.scheduler.runNow("a");
    assert.equal(refused.ok, false);
  });

  test("没到点不触发；到点早一点点（在 LATE_MS 内）是 schedule 不是 caughtUp", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 + MIN }));
    await h.scheduler.tick();
    assert.equal(h.launches.length, 0);
    h.clock.now = T0 + MIN + LATE_MS - 1;
    await h.scheduler.tick();
    assert.equal(h.launches[0]?.trigger, "schedule");
  });

  test("错过（睡眠 / 没开应用 8 小时）：只补一次 caughtUp，然后从现在重排；再 tick 不会补第二次", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", schedule: { kind: "interval", unit: "minute", every: 30 }, nextRunAt: T0 }));
    h.clock.now = T0 + 8 * 60 * MIN;
    await h.scheduler.tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]?.trigger, "caughtUp");
    assert.equal((await h.store.get("a"))?.nextRunAt, h.clock.now + 30 * MIN);
    await h.scheduler.tick();
    assert.equal(h.launches.length, 1);
  });

  test("上一次还在跑 → 本次 skipped（不排队、不开会话），连续跳过合并计数", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 }));
    await h.scheduler.tick();
    h.clock.now = T0 + 15 * MIN;
    await h.scheduler.tick();
    h.clock.now = T0 + 30 * MIN;
    await h.scheduler.tick();
    assert.equal(h.launches.length, 1);
    const automation = await h.store.get("a");
    assert.equal(automation?.runs.length, 2, "一条 running + 一条合并后的 skipped");
    assert.equal(automation?.runs[0]?.status, "skipped");
    assert.equal(automation?.runs[0]?.skipReason, "overlap");
    assert.equal(automation?.runs[0]?.repeat, 2);
    assert.equal(automation?.runCount, 1);
  });

  test("launch 失败：这次记 error（没有会话），连续 3 次进入 failed，第 4 次不再触发", async () => {
    const h = harness({ launchError: new Error("没有可用模型") });
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 }));
    for (let i = 0; i < 3; i += 1) {
      h.clock.now = T0 + i * 15 * MIN;
      await h.scheduler.tick();
    }
    const automation = await h.store.get("a");
    assert.equal(h.launches.length, 3);
    assert.equal(automation?.status, "failed");
    assert.equal(automation?.failureReason, "没有可用模型");
    assert.equal(automation?.runs[0]?.status, "error");
    assert.equal(automation?.runs[0]?.sessionId, null);
    assert.equal(h.scheduler.activeCount(), 0);
    h.clock.now = T0 + 5 * 15 * MIN;
    await h.scheduler.tick();
    assert.equal(h.launches.length, 3);
  });

  test("回合级失败 / 最后一条回答是 error / 被中止：记 error；只有「其它失败」且有回答仍是 success", async () => {
    const cases: { name: string; events: (sid: string) => AgentEvent[]; status: "success" | "error"; error?: RegExp }[] = [
      {
        name: "turn failure",
        events: (sid) => [{ type: "failed", sessionId: sid, message: "401 invalid key", turn: true }],
        status: "error",
        error: /401/,
      },
      {
        name: "assistant error",
        events: (sid) => [
          {
            type: "progress",
            sessionId: sid,
            progress: {
              type: "item_finished",
              item: {
                id: "e1",
                role: "assistant",
                content: [],
                model: { provider: "p", id: "m" },
                timestamp: T0,
                status: "error",
                stopReason: "error",
                errorMessage: "overloaded",
              },
            },
          },
        ],
        status: "error",
        error: /overloaded/,
      },
      {
        name: "soft failure without answer",
        events: (sid) => [{ type: "failed", sessionId: sid, message: "压缩失败" }],
        status: "error",
        error: /压缩失败/,
      },
      {
        name: "soft failure with answer",
        events: (sid) => [{ type: "failed", sessionId: sid, message: "压缩失败" }, answerEvent(sid, "还是答完了")],
        status: "success",
      },
    ];
    for (const item of cases) {
      const h = harness();
      await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 }));
      await h.scheduler.tick();
      const sid = h.launches[0]?.sessionId ?? "";
      for (const event of item.events(sid)) h.scheduler.onAgentEvent(event);
      h.scheduler.onAgentEvent(idleEvent(sid));
      await h.settled();
      const automation = await h.store.get("a");
      assert.equal(automation?.runs[0]?.status, item.status, item.name);
      if (item.error !== undefined) assert.match(automation?.runs[0]?.error ?? "", item.error, item.name);
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "orbita-automation-scheduler-"));
    }
  });

  test("无关会话的事件一律忽略；收尾后迟到的 idle 不会二次收尾", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 }));
    await h.scheduler.tick();
    const sid = h.launches[0]?.sessionId ?? "";
    h.scheduler.onAgentEvent(answerEvent("别人的会话", "不是我的"));
    h.scheduler.onAgentEvent(idleEvent("别人的会话"));
    await h.settled();
    assert.equal(h.scheduler.activeCount(), 1);
    h.scheduler.onAgentEvent(idleEvent(sid));
    h.scheduler.onAgentEvent(idleEvent(sid));
    await h.settled();
    assert.deepEqual(h.activeChanges, [1, 0]);
    assert.equal((await h.store.get("a"))?.runCount, 1);
  });

  test("超过 60 分钟还没结束：中止这条会话并记失败，之后迟到的 idle 被忽略", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", schedule: { kind: "interval", unit: "day", every: 1 }, nextRunAt: T0 }));
    await h.scheduler.tick();
    const sid = h.launches[0]?.sessionId ?? "";
    h.clock.now = T0 + RUN_TIMEOUT_MS + 1;
    await h.scheduler.tick();
    assert.deepEqual(h.aborts, [sid]);
    const automation = await h.store.get("a");
    assert.equal(automation?.runs[0]?.status, "error");
    assert.match(automation?.runs[0]?.error ?? "", /60 minutes/);
    h.scheduler.onAgentEvent(idleEvent(sid));
    await h.settled();
    assert.equal((await h.store.get("a"))?.consecutiveFailures, 1);
  });

  test("同时到点的一批：最多 MAX_CONCURRENT_RUNS 个同时开，其余下一次 tick 再开", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await h.store.insert(makeAutomation({ id: `a${i}`, nextRunAt: T0 }));
    }
    await h.scheduler.tick();
    assert.equal(h.launches.length, MAX_CONCURRENT_RUNS);
    // 在跑的收尾后，下一次 tick 把剩下的开掉
    for (const launched of [...h.launches]) h.scheduler.onAgentEvent(idleEvent(launched.sessionId));
    await h.settled();
    h.clock.now = T0 + TICK_MS;
    await h.scheduler.tick();
    assert.equal(h.launches.length, 5);
  });

  test("跑满 maxRuns 收尾即 completed(finished)；once 跑完 completed(finished)", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "m", nextRunAt: T0, maxRuns: 1 }));
    await h.store.insert(makeAutomation({ id: "o", schedule: { kind: "once", at: T0 }, nextRunAt: T0 }));
    await h.scheduler.tick();
    for (const launched of [...h.launches]) {
      h.scheduler.onAgentEvent(answerEvent(launched.sessionId, "好"));
      h.scheduler.onAgentEvent(idleEvent(launched.sessionId));
    }
    await h.settled();
    for (const id of ["m", "o"]) {
      const automation = await h.store.get(id);
      assert.equal(automation?.status, "completed", id);
      assert.equal(automation?.endReason, "finished", id);
      assert.equal(automation?.nextRunAt, null, id);
    }
  });

  test("立即运行：不动排期；在跑时拒；failed 要先重新启动；paused 可以跑", async () => {
    const h = harness();
    await h.store.insert(makeAutomation({ id: "a", nextRunAt: T0 + 10 * MIN }));
    assert.deepEqual(await h.scheduler.runNow("a"), { ok: true });
    assert.equal(h.launches[0]?.trigger, "manual");
    assert.equal((await h.store.get("a"))?.nextRunAt, T0 + 10 * MIN);
    const again = await h.scheduler.runNow("a");
    assert.equal(again.ok, false);
    assert.equal(h.launches.length, 1);
    await h.store.insert(makeAutomation({ id: "f", status: "failed", nextRunAt: null }));
    assert.equal((await h.scheduler.runNow("f")).ok, false);
    await h.store.insert(makeAutomation({ id: "p", status: "paused", nextRunAt: null }));
    assert.equal((await h.scheduler.runNow("p")).ok, true);
    assert.equal((await h.scheduler.runNow("不存在")).ok, false);
  });

  test("启动自愈：上次退出时还标着 running 的运行记为中断且不计连续失败；丢了排期的补上", async () => {
    const h = harness();
    await h.store.insert(
      makeAutomation({
        id: "a",
        nextRunAt: T0 + 60 * MIN,
        consecutiveFailures: 1,
        runs: [run({ id: "old", status: "running", runAt: T0 - 5 * MIN, sessionId: "dead" })],
      }),
    );
    await h.store.insert(makeAutomation({ id: "lost", nextRunAt: null }));
    await h.scheduler.tick();
    const a = await h.store.get("a");
    assert.equal(a?.runs[0]?.status, "error");
    assert.match(a?.runs[0]?.error ?? "", /Interrupted/);
    assert.equal(a?.consecutiveFailures, 1);
    assert.equal((await h.store.get("lost"))?.nextRunAt, T0 + 15 * MIN);
    assert.equal(h.launches.length, 0);
  });
});

describe("AutomationScheduler：this_session", () => {
  const bound = (patch: Partial<Automation> & { id: string }): Automation =>
    makeAutomation({
      target: { kind: "this_session", sessionId: "S", workspaceId: null },
      maxRuns: 12,
      nextRunAt: T0,
      ...patch,
    });

  test("会话空闲：到点直接送，号数是第几次；会话 idle 后收尾，不存上次结果、不量 token", async () => {
    const h = harness();
    await h.store.insert(bound({ id: "t" }));
    await h.scheduler.tick();
    assert.equal(h.delivers.length, 1);
    assert.equal(h.delivers[0]?.number, 1);
    assert.equal(h.launches.length, 0);
    assert.equal(h.scheduler.activeCount(), 1);
    h.scheduler.onAgentEvent(answerEvent("S", "日志里还没起好"));
    h.scheduler.onAgentEvent(statsEvent("S", 99_999));
    h.scheduler.onAgentEvent(idleEvent("S"));
    await h.settled();
    const automation = await h.store.get("t");
    assert.equal(automation?.runs[0]?.status, "success");
    assert.equal(automation?.runs[0]?.sessionId, "S");
    assert.equal(automation?.runs[0]?.tokens, null);
    assert.equal(automation?.runs[0]?.resultExcerpt, "日志里还没起好");
    assert.equal(automation?.lastResult, undefined);
  });

  test("会话在忙：不送，记等待；等待期间又到点只合并；会话 idle 后只送一次，merged 记进运行", async () => {
    const h = harness();
    h.busy.add("S");
    await h.store.insert(bound({ id: "t" }));
    await h.scheduler.tick();
    h.clock.now = T0 + 15 * MIN;
    await h.scheduler.tick();
    h.clock.now = T0 + 30 * MIN;
    await h.scheduler.tick();
    assert.equal(h.delivers.length, 0);
    const waiting = await h.store.get("t");
    assert.equal(waiting?.runs.length, 0);
    assert.equal(waiting?.runCount, 0);
    assert.deepEqual(waiting?.pendingDelivery, { since: T0, trigger: "schedule", merged: 2 });

    // 会话空下来：phase idle 事件触发送达
    h.busy.delete("S");
    h.scheduler.onAgentEvent(idleEvent("S"));
    await h.settled();
    assert.equal(h.delivers.length, 1, "只送一次，不是三次");
    assert.equal(h.delivers[0]?.number, 1);
    const delivered = await h.store.get("t");
    assert.equal(delivered?.pendingDelivery, undefined);
    assert.equal(delivered?.runs[0]?.merged, 2);
    assert.equal(delivered?.runs[0]?.status, "running");
    assert.equal(delivered?.runCount, 1);
    // 送出去的这一轮自己结束
    h.scheduler.onAgentEvent(idleEvent("S"));
    await h.settled();
    assert.equal((await h.store.get("t"))?.runs[0]?.status, "success");
  });

  test("等待中的送达：错过 idle 事件也没关系，下一次 tick 发现会话空了会补送；重启后（新调度器实例）同样", async () => {
    const h = harness();
    await h.store.insert(bound({ id: "t", nextRunAt: T0 + 15 * MIN, pendingDelivery: { since: T0, trigger: "schedule", merged: 0 } }));
    h.busy.add("S");
    await h.scheduler.tick();
    assert.equal(h.delivers.length, 0);
    h.busy.delete("S");
    h.clock.now = T0 + TICK_MS;
    // 全新的调度器实例 = 应用重启后的第一次 tick
    const restarted = new AutomationScheduler({
      store: h.store,
      now: () => h.clock.now,
      enabled: async () => true,
      launch: async () => undefined,
      deliver: async (input) => {
        h.delivers.push(input);
      },
      sessionExists: async () => true,
      isSessionBusy: (id) => h.busy.has(id),
      abort: async () => undefined,
      notify: () => undefined,
    });
    await restarted.tick();
    assert.equal(h.delivers.length, 1);
    assert.equal((await h.store.get("t"))?.pendingDelivery, undefined);
  });

  test("同一条会话绑了两个任务同时到点：先送一个，另一个等这一轮结束再送", async () => {
    const h = harness();
    await h.store.insert(bound({ id: "t1" }));
    await h.store.insert(bound({ id: "t2" }));
    await h.scheduler.tick();
    assert.equal(h.delivers.length, 1, "第二个看到会话已被第一个占着");
    const waiting = (await h.store.list()).find((automation) => automation.pendingDelivery !== undefined);
    assert.ok(waiting);
    h.scheduler.onAgentEvent(idleEvent("S"));
    await h.settled(() => h.delivers.length === 2);
    assert.equal(h.delivers.length, 2);
  });

  test("绑定的会话被删：tick 把任务翻成 completed(sessionDeleted)，不送；立即运行同样", async () => {
    const h = harness();
    await h.store.insert(bound({ id: "t" }));
    await h.store.insert(bound({ id: "u", target: { kind: "this_session", sessionId: "S2", workspaceId: null } }));
    h.existing.delete("S");
    await h.scheduler.tick();
    const t = await h.store.get("t");
    assert.equal(t?.status, "completed");
    assert.equal(t?.endReason, "sessionDeleted");
    assert.equal(t?.nextRunAt, null);
    assert.equal(h.delivers.length, 1, "另一条会话的任务不受影响");
    h.existing.delete("S2");
    const manual = await h.scheduler.runNow("u");
    assert.equal(manual.ok, false);
    assert.equal((await h.store.get("u"))?.endReason, "sessionDeleted");
  });

  test("送不进去（会话续不了 / provider 没了）：这次记 error 但仍指向那条会话；3 次进入 failed", async () => {
    const h = harness({ deliverError: new Error("cannot continue") });
    await h.store.insert(bound({ id: "t" }));
    for (let i = 0; i < 3; i += 1) {
      h.clock.now = T0 + i * 15 * MIN;
      await h.scheduler.tick();
    }
    const automation = await h.store.get("t");
    assert.equal(automation?.status, "failed");
    assert.equal(automation?.runs[0]?.sessionId, "S");
    assert.equal(automation?.failureReason, "cannot continue");
  });

  test("maxRuns 到顶：第 12 次送完收尾即 completed；号数 n/max 里的 n 随送达递增", async () => {
    const h = harness();
    await h.store.insert(bound({ id: "t", maxRuns: 2, schedule: { kind: "interval", unit: "minute", every: 5 } }));
    for (let i = 0; i < 2; i += 1) {
      h.clock.now = T0 + i * 5 * MIN;
      await h.scheduler.tick();
      h.scheduler.onAgentEvent(idleEvent("S"));
      await h.settled();
    }
    assert.deepEqual(h.delivers.map((d) => d.number), [1, 2]);
    const automation = await h.store.get("t");
    assert.equal(automation?.status, "completed");
    assert.equal(automation?.endReason, "finished");
  });
});
