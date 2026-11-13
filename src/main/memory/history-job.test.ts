/**
 * 从历史生成的任务编排（history-job.ts）：计划（会话内时间正序、去掉已处理轮、子会话与别的
 * 作用域不进）、并发、暂停 / 继续 / 停止、断点续跑不重复、失败暂停、重启恢复成暂停。
 * 服务与段账本用假的：step 每处理一轮就把它记进「已处理」，与真服务落段文件同一效果。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { MemoryHistoryStatus, MemoryHistoryStepOutcome } from "../../shared/memory.ts";
import type { SessionRecord } from "../../shared/session.ts";
import {
  MemoryHistoryJob,
  parseHistoryStatus,
  restoredHistoryStatus,
  type HistorySessionMeta,
  type HistoryStepInput,
  type MemoryHistoryDeps,
} from "./history-job.ts";

function turnRecords(times: readonly number[]): SessionRecord[] {
  const out: SessionRecord[] = [];
  times.forEach((at, index) => {
    out.push({ id: `u${at}`, role: "user", content: [{ type: "text", text: `话 ${at}` }], timestamp: at } as TranscriptItem);
    out.push({
      id: `a${at}`,
      role: "assistant",
      content: [{ type: "text", text: `答 ${index}` }],
      model: { provider: "p", id: "m" },
      timestamp: at + 1,
      status: "complete",
      stopReason: "stop",
    } as TranscriptItem);
  });
  return out;
}

const OK: MemoryHistoryStepOutcome = { closed: 0, written: { fact: 0, preference: 0, insight: 0 }, calls: 1, failed: 0 };

interface Harness {
  job: MemoryHistoryJob;
  steps: HistoryStepInput[];
  processed: Map<string, Set<number>>;
  saved: MemoryHistoryStatus[];
  /** 每一步要等它 resolve 才回（测暂停 / 并发） */
  gate: { next: (() => Promise<void>) | null };
}

function harness(options: {
  sessions: (HistorySessionMeta & { times: number[] })[];
  processed?: Map<string, Set<number>>;
  outcome?: (input: HistoryStepInput, index: number) => MemoryHistoryStepOutcome | null;
  concurrency?: number;
  saved?: MemoryHistoryStatus | null;
}): Harness {
  const steps: HistoryStepInput[] = [];
  const processed = options.processed ?? new Map<string, Set<number>>();
  const saved: MemoryHistoryStatus[] = [];
  const gate: Harness["gate"] = { next: null };
  const deps: MemoryHistoryDeps = {
    listSessions: async () => options.sessions,
    workspaces: async () => [{ id: "ws-1", name: "意图系统" }],
    load: async (id) => {
      const session = options.sessions.find((item) => item.id === id);
      return session === undefined ? null : { transcript: turnRecords(session.times) };
    },
    processedTurns: async () => new Map([...processed].map(([key, value]) => [key, new Set(value)])),
    chore: async () => ({ providerId: "zhipu", modelId: "glm" }),
    prepare: async () => null,
    step: async (input) => {
      const index = steps.length;
      steps.push(input);
      if (gate.next !== null) await gate.next();
      if (input.kind === "turn") {
        const set = processed.get(input.sessionId) ?? new Set<number>();
        set.add(input.turn.turn);
        processed.set(input.sessionId, set);
      }
      return options.outcome === undefined ? OK : options.outcome(input, index);
    },
    readState: async () => options.saved ?? null,
    writeState: async (status) => {
      saved.push(status);
    },
    emit: () => undefined,
    gapMs: 600_000,
    concurrency: options.concurrency ?? 1,
    log: () => undefined,
  };
  return { job: new MemoryHistoryJob(deps), steps, processed, saved, gate };
}

const turnSteps = (steps: readonly HistoryStepInput[]): string[] =>
  steps.flatMap((step) => (step.kind === "turn" ? [`${step.sessionId}#${step.turn.turn}${step.closeAfter ? "!" : ""}`] : ["flush"]));

test("计划：会话内按时间正序、老会话先开始；每条会话最后一轮 closeAfter；跑完收尾一次", async () => {
  const h = harness({
    sessions: [
      { id: "b", workspaceId: "ws-1", cwd: "/x", times: [5000, 6000] },
      { id: "a", workspaceId: "ws-1", cwd: "/x", times: [1000, 2000, 9000] },
      { id: "child", parentId: "a", workspaceId: "ws-1", cwd: "/x", times: [1500] },
      { id: "other", workspaceId: "ws-2", cwd: "/x", times: [100] },
    ],
  });
  await h.job.start(["ws-1"]);
  await h.job.settled();
  assert.deepEqual(turnSteps(h.steps), ["a#1", "a#2", "a#3!", "b#1", "b#2!", "flush"]);
  const status = await h.job.current();
  assert.equal(status.state, "done");
  assert.equal(status.totalTurns, 5);
  assert.equal(status.doneTurns, 5);
});

test("去重：已进过事件段的轮（实时整理过 / 上次生成过）跳过；预估里分开显示已处理与待处理", async () => {
  const h = harness({
    sessions: [{ id: "a", workspaceId: "ws-1", cwd: "/x", times: [1000, 2000, 3000] }],
    processed: new Map([["a", new Set([2])]]),
  });
  const estimate = await h.job.estimate(["ws-1"]);
  assert.deepEqual(estimate.scopes.map((row) => [row.name, row.sessions, row.stats?.turns, row.stats?.processed]), [
    ["意图系统", 1, 2, 1],
  ]);
  await h.job.start(["ws-1"]);
  await h.job.settled();
  assert.deepEqual(turnSteps(h.steps), ["a#1", "a#3!", "flush"]);
});

test("停止后再开始：从断点续，已喂过的轮不再喂（重复点也不重复）", async () => {
  const h = harness({ sessions: [{ id: "a", workspaceId: "ws-1", cwd: "/x", times: [1000, 2000, 3000, 4000] }] });
  let stopAfter = 2;
  h.gate.next = async () => {
    stopAfter -= 1;
    if (stopAfter === 0) await h.job.control("stop");
  };
  await h.job.start(["ws-1"]);
  await h.job.settled();
  assert.equal((await h.job.current()).state, "stopped");
  assert.deepEqual(turnSteps(h.steps), ["a#1", "a#2", "flush"]);
  h.gate.next = null;
  await h.job.start(["ws-1"]);
  await h.job.settled();
  await h.job.start(["ws-1"]); // 跑完再点一次：没有可喂的
  await h.job.settled();
  assert.deepEqual(turnSteps(h.steps), ["a#1", "a#2", "flush", "a#3", "a#4!", "flush", "flush"]);
});

test("暂停：手上那一步做完就停；继续接着喂剩下的，不重喂", async () => {
  const h = harness({ sessions: [{ id: "a", workspaceId: "ws-1", cwd: "/x", times: [1000, 2000, 3000] }] });
  h.gate.next = async () => {
    h.gate.next = null;
    await h.job.control("pause");
  };
  await h.job.start(["ws-1"]);
  await h.job.settled();
  const paused = await h.job.current();
  assert.equal(paused.state, "paused");
  assert.equal(paused.doneTurns, 1);
  await h.job.control("resume");
  await h.job.settled();
  assert.deepEqual(turnSteps(h.steps), ["a#1", "a#2", "a#3!", "flush"]);
  const done = await h.job.current();
  assert.equal(done.state, "done");
  assert.equal(done.doneTurns, 3);
  assert.equal(done.totalTurns, 3);
});

test("并发：同时最多 concurrency 条会话在服务里", async () => {
  let inFlight = 0;
  let peak = 0;
  const h = harness({
    sessions: ["a", "b", "c", "d", "e"].map((id, index) => ({ id, workspaceId: "ws-1", cwd: "/x", times: [index * 10 + 1, index * 10 + 2] })),
    concurrency: 2,
  });
  h.gate.next = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
  };
  await h.job.start(["ws-1"]);
  await h.job.settled();
  assert.equal(peak, 2);
  assert.equal(h.steps.filter((step) => step.kind === "turn").length, 10);
});

test("失败：连续几步提取失败就暂停成 failed（不把几百次调用都撞一遍）；服务中途没了也停", async () => {
  const failing = harness({
    sessions: [{ id: "a", workspaceId: "ws-1", cwd: "/x", times: [1, 2, 3, 4, 5, 6] }],
    outcome: () => ({ ...OK, closed: 1, failed: 1 }),
  });
  await failing.job.start(["ws-1"]);
  await failing.job.settled();
  const status = await failing.job.current();
  assert.equal(status.state, "failed");
  assert.match(status.error ?? "", /连续/);
  assert.equal(failing.steps.length, 3);
  // 单段失败不中断：失败之后有成功的段，计数清零继续
  const mixed = harness({
    sessions: [{ id: "a", workspaceId: "ws-1", cwd: "/x", times: [1, 2, 3, 4, 5] }],
    outcome: (_input, index) => (index % 2 === 0 ? { ...OK, closed: 1, failed: 1 } : { ...OK, closed: 1 }),
  });
  await mixed.job.start(["ws-1"]);
  await mixed.job.settled();
  assert.equal((await mixed.job.current()).state, "done");
  assert.equal((await mixed.job.current()).failed, 3);
  const gone = harness({ sessions: [{ id: "a", workspaceId: "ws-1", cwd: "/x", times: [1, 2] }], outcome: () => null });
  await gone.job.start(["ws-1"]);
  await gone.job.settled();
  assert.equal((await gone.job.current()).state, "failed");
  // failed 可以继续
  assert.equal((await gone.job.control("resume")).state, "running");
});

test("重启：跑着 / 停到一半的任务读回来是暂停（不自己开跑）；坏快照当没有任务", async () => {
  const running = { ...restoredHistoryStatus(null), state: "running" as const, scopeIds: ["ws-1"], doneTurns: 7 };
  assert.equal(restoredHistoryStatus(running).state, "paused");
  assert.equal(restoredHistoryStatus({ ...running, state: "stopping" }).state, "paused");
  assert.equal(restoredHistoryStatus({ ...running, state: "done" }).state, "done");
  assert.deepEqual(parseHistoryStatus(JSON.parse(JSON.stringify(running))), running);
  assert.equal(parseHistoryStatus({ state: "nope", scopeIds: [] }), null);
  const h = harness({ sessions: [], saved: running });
  assert.equal((await h.job.current()).state, "paused");
  assert.equal((await h.job.current()).doneTurns, 7);
});

test("预估的作用域：现存工作区在前（按名字）→ 按目录 → 已不在的工作区（按名字，名字是目录末段，不露 id）", async () => {
  const gone = "24d85ecd-0000-4000-8000-000000000000";
  const h = harness({
    sessions: [
      { id: "a", workspaceId: "ws-1", cwd: "/x", times: [1] },
      { id: "b", workspaceId: null, cwd: "/Users/u/Orbita/Home", times: [2] },
      { id: "c", workspaceId: gone, cwd: "/Users/u/code/clementi-agents", times: [3] },
      { id: "d", workspaceId: gone, cwd: "/Users/u/code/clementi-agents", times: [4] },
      { id: "e", workspaceId: gone, cwd: "/tmp/other", times: [5] },
    ],
  });
  const estimate = await h.job.estimate([]);
  assert.deepEqual(
    estimate.scopes.map((row) => [row.kind, row.name, row.sessions, row.path ?? null]),
    [
      ["workspace", "意图系统", 1, null],
      ["cwd", "/Users/u/Orbita/Home", 1, "/Users/u/Orbita/Home"],
      ["missing", "clementi-agents", 3, "/Users/u/code/clementi-agents"],
    ],
  );
  // 存储作用域不变：仍按 workspaceId
  assert.equal(estimate.scopes[2]!.scopeId, gone);
});
