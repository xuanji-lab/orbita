import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  AUTOMATION_AGENT_DEFAULT_MAX_RUNS,
  AUTOMATION_MAX_ACTIVE_PER_SESSION,
  AUTOMATION_MAX_TOTAL,
  type Automation,
  type AutomationToolRequest,
} from "../../shared/automation.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { makeAutomation } from "./fixtures.ts";
import {
  applyAutomationAct,
  applyAutomationCreate,
  applyAutomationPromote,
  applyAutomationRequest,
  applyAutomationUpdate,
  listAutomations,
  type AutomationRequestDeps,
} from "./requests.ts";
import type { RunNowOutcome } from "./scheduler.ts";
import { AutomationStore } from "./store.ts";

const NOW = new Date(2026, 9, 31, 10, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const workspaces: Workspace[] = [
  { id: "ws1", name: "orbita", path: "/repo/orbita", createdAt: 1, attachedDirs: [] },
  { id: "ws2", name: "ddpm", path: "/repo/ddpm", createdAt: 1, attachedDirs: [] },
];

function provider(id: string, modelIds: string[]): ProviderDto {
  return {
    id,
    displayName: id,
    endpoint: { baseUrl: "https://x.example", api: "openai-completions" },
    auth: { scheme: "api_key", hasSecret: true, masked: "abc…xyz" },
    models: { declared: modelIds.map((modelId) => ({ id: modelId })) },
  };
}

const meta = (patch: Partial<SessionMeta> & { id: string }): SessionMeta => ({
  title: "会话",
  titleSource: "user",
  cwd: "/repo/orbita",
  workspaceId: "ws1",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "skip",
  thinkingLevel: "medium",
  piSessionFile: "/pi/x.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-automation-requests-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 同一个测试里要两套互不相干的存储时，给不同的 name */
function setup(options: { enabled?: boolean; metas?: SessionMeta[]; runNow?: RunNowOutcome; name?: string } = {}) {
  const store = new AutomationStore(join(dir, options.name ?? "main"));
  const metas = new Map((options.metas ?? []).map((m) => [m.id, m]));
  const state = { enabled: options.enabled ?? true, notifies: 0, promoted: [] as string[], runNowCalls: [] as string[], ids: 0 };
  const deps: AutomationRequestDeps = {
    store,
    scheduler: {
      runNow: async (id) => {
        state.runNowCalls.push(id);
        return options.runNow ?? { ok: true };
      },
    },
    sessions: {
      readMeta: async (id) => metas.get(id) ?? null,
      setPromoted: async (id) => {
        state.promoted.push(id);
        return true;
      },
    },
    providers: { list: async () => [provider("zai", ["glm-5.3", "glm-5.3-flash"]), provider("kimi", ["k3"])] },
    workspaces: { list: async () => workspaces },
    enabled: async () => state.enabled,
    now: () => NOW,
    newId: () => `id${(state.ids += 1)}`,
    notify: () => {
      state.notifies += 1;
    },
  };
  return { deps, store, state, metas };
}

const validCreate = {
  workspaceId: "ws1",
  title: "开源 CLI 速览",
  prompt: "看 release",
  schedule: { kind: "daily", time: "18:00", weekdays: [5] },
  mode: "skip",
};

describe("开关关着", () => {
  test("list 回空，所有写操作与工具请求都回「已关闭」，什么都不落盘", async () => {
    const { deps, store, state } = setup({ enabled: false, metas: [meta({ id: "s1" })] });
    await store.insert(makeAutomation({ id: "a" }));
    assert.deepEqual(await listAutomations(deps), []);
    for (const result of [
      await applyAutomationCreate(deps, validCreate),
      await applyAutomationUpdate(deps, "a", { title: "x" }),
      await applyAutomationAct(deps, "a", { type: "pause" }),
      await applyAutomationPromote(deps, "s1"),
      await applyAutomationRequest(deps, toolEvent("s1", { op: "list" })),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /turned off/);
    }
    assert.equal((await store.list()).length, 1);
    assert.equal(state.notifies, 0);
  });
});

describe("applyAutomationCreate（面板手建）", () => {
  test("合法：直接 active、只能新开会话、nextRunAt 从现在排好、通知 renderer", async () => {
    const { deps, store, state } = setup();
    const result = await applyAutomationCreate(deps, { ...validCreate, maxRuns: 5, providerId: "kimi", modelId: "k3", thinkingLevel: "high" });
    assert.equal(result.ok, true);
    const automation = result.ok ? result.automation : null;
    assert.equal(automation?.status, "active");
    assert.deepEqual(automation?.target, { kind: "new_session", workspaceId: "ws1" });
    assert.deepEqual(automation?.createdBy, { kind: "user" });
    assert.equal(automation?.maxRuns, 5);
    assert.equal(automation?.modelId, "k3");
    assert.equal(automation?.nextRunAt, new Date(2026, 10, 6, 18, 0).getTime(), "下一个周五 18:00（2026-10-31 是周六）");
    assert.equal((await store.list()).length, 1);
    assert.equal(state.notifies, 1);
  });

  test("Home（workspaceId null）可以建；不存在的工作区拒", async () => {
    const { deps } = setup();
    assert.equal((await applyAutomationCreate(deps, { ...validCreate, workspaceId: null })).ok, true);
    const bad = await applyAutomationCreate(deps, { ...validCreate, workspaceId: "nope" });
    assert.equal(bad.ok, false);
    assert.equal((await applyAutomationCreate(deps, { ...validCreate, workspaceId: undefined })).ok, false);
  });

  test("逐字段校验：标题 / 指令 / 触发规则 / 权限档（manual 不给）/ 模型 / 次数 / 日期", async () => {
    const { deps, store } = setup();
    const bad: Record<string, unknown>[] = [
      { ...validCreate, title: "  " },
      { ...validCreate, title: "长".repeat(41) },
      { ...validCreate, prompt: "" },
      { ...validCreate, prompt: "x".repeat(8001) },
      { ...validCreate, schedule: { kind: "interval", unit: "minute", every: 4 } },
      { ...validCreate, schedule: { kind: "once", at: NOW - 1 } },
      { ...validCreate, schedule: "daily" },
      { ...validCreate, mode: "manual" },
      { ...validCreate, mode: undefined },
      { ...validCreate, providerId: "zai" },
      { ...validCreate, providerId: "zai", modelId: "不存在" },
      { ...validCreate, thinkingLevel: "ultra" },
      { ...validCreate, maxRuns: 0 },
      { ...validCreate, maxRuns: 1.5 },
      { ...validCreate, maxRuns: 10_001 },
      { ...validCreate, until: NOW - 1 },
      { ...validCreate, until: NOW + MIN },
    ];
    for (const input of bad) {
      const result = await applyAutomationCreate(deps, input);
      assert.equal(result.ok, false, JSON.stringify(input).slice(0, 80));
    }
    assert.equal((await applyAutomationCreate(deps, null)).ok, false);
    assert.equal((await applyAutomationCreate(deps, [])).ok, false);
    assert.equal((await store.list()).length, 0, "校验不过什么都不落盘");
  });

  test("标题里的连续空白折成一个空格；全局最多 20 条（所有状态都算）", async () => {
    const { deps, store } = setup();
    const created = await applyAutomationCreate(deps, { ...validCreate, title: "  a   b \n c " });
    assert.equal(created.ok && created.automation?.title, "a b c");
    for (let i = 0; i < AUTOMATION_MAX_TOTAL - 1; i += 1) {
      await store.insert(makeAutomation({ id: `x${i}`, status: i % 2 === 0 ? "completed" : "active" }));
    }
    const over = await applyAutomationCreate(deps, validCreate);
    assert.equal(over.ok, false);
    assert.match(over.ok ? "" : over.error, /At most 20/);
  });
});

describe("applyAutomationUpdate", () => {
  test("只改给了的字段；改排期的 active 任务从现在重排；暂停的不排；null 清掉次数 / 日期 / 模型", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "a", maxRuns: 3, until: NOW + 30 * DAY, providerId: "kimi", modelId: "k3", nextRunAt: NOW + MIN }));
    await store.insert(makeAutomation({ id: "p", status: "paused", nextRunAt: null }));
    const renamed = await applyAutomationUpdate(deps, "a", { title: "新名字" });
    assert.equal(renamed.ok && renamed.automation?.title, "新名字");
    assert.equal(renamed.ok && renamed.automation?.nextRunAt, NOW + MIN, "没动排期就不重排");
    const rescheduled = await applyAutomationUpdate(deps, "a", { schedule: { kind: "interval", unit: "hour", every: 2 } });
    assert.equal(rescheduled.ok && rescheduled.automation?.nextRunAt, NOW + 120 * MIN);
    const cleared = await applyAutomationUpdate(deps, "a", { maxRuns: null, until: null, providerId: null, modelId: null });
    const automation = cleared.ok ? cleared.automation : null;
    assert.equal(automation?.maxRuns, undefined);
    assert.equal(automation?.until, undefined);
    assert.equal(automation?.modelId, undefined);
    const paused = await applyAutomationUpdate(deps, "p", { schedule: { kind: "hourly", minute: 0 } });
    assert.equal(paused.ok && paused.automation?.nextRunAt, null);
    assert.equal(paused.ok && paused.automation?.status, "paused");
  });

  test("按最新状态合并：校验期间调度器写进来的运行记录不会被表单提交冲掉", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "a" }));
    // 校验那一刻 get 到的是旧快照；store.update 的闭包里按最新的合并
    const original = deps.store.get.bind(deps.store);
    deps.store.get = async (id) => {
      const snapshot = await original(id);
      await store.update(id, (current) => ({ ...current, runCount: 7, consecutiveFailures: 2 }));
      return snapshot;
    };
    const result = await applyAutomationUpdate(deps, "a", { title: "改名" });
    assert.equal(result.ok && result.automation?.runCount, 7);
    assert.equal(result.ok && result.automation?.title, "改名");
  });

  test("校验失败整条不改；终点早于下一次拒；未知 id / 坏载荷拒", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "a", nextRunAt: NOW + MIN }));
    assert.equal((await applyAutomationUpdate(deps, "a", { title: "好", prompt: "" })).ok, false);
    assert.equal((await store.get("a"))?.title, "任务 a");
    assert.equal((await applyAutomationUpdate(deps, "a", { schedule: { kind: "daily", time: "09:00" }, until: NOW + 60 * MIN })).ok, false);
    assert.equal((await applyAutomationUpdate(deps, "不存在", { title: "x" })).ok, false);
    assert.equal((await applyAutomationUpdate(deps, 7, { title: "x" })).ok, false);
    assert.equal((await applyAutomationUpdate(deps, "a", "x")).ok, false);
  });

  test("改去处：只有 agent 在对话里建的才能在新开会话与投回原会话之间切", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "s1" })] });
    await store.insert(makeAutomation({ id: "user", createdBy: { kind: "user" } }));
    await store.insert(makeAutomation({ id: "agent", createdBy: { kind: "agent", sessionId: "s1" } }));
    await store.insert(makeAutomation({ id: "gone", createdBy: { kind: "agent", sessionId: "已删" } }));
    assert.equal((await applyAutomationUpdate(deps, "user", { deliver: "this_session" })).ok, false);
    assert.equal((await applyAutomationUpdate(deps, "gone", { deliver: "this_session" })).ok, false);
    const bound = await applyAutomationUpdate(deps, "agent", { deliver: "this_session" });
    assert.deepEqual(bound.ok && bound.automation?.target, { kind: "this_session", sessionId: "s1", workspaceId: null });
    const back = await applyAutomationUpdate(deps, "agent", { deliver: "new_session" });
    assert.deepEqual(back.ok && back.automation?.target, { kind: "new_session", workspaceId: null });
    assert.equal((await applyAutomationUpdate(deps, "agent", { deliver: "elsewhere" })).ok, false);
  });
});

describe("applyAutomationAct（面板按钮 = 状态转移）", () => {
  test("pause：只有 active 能暂停，排期清空；resume：从现在重排，连续失败清零", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "a", consecutiveFailures: 2, nextRunAt: NOW + MIN }));
    const paused = await applyAutomationAct(deps, "a", { type: "pause" });
    assert.equal(paused.ok && paused.automation?.status, "paused");
    assert.equal(paused.ok && paused.automation?.nextRunAt, null);
    assert.equal((await applyAutomationAct(deps, "a", { type: "pause" })).ok, false, "已暂停的不能再暂停");
    const resumed = await applyAutomationAct(deps, "a", { type: "resume" });
    assert.equal(resumed.ok && resumed.automation?.status, "active");
    assert.equal(resumed.ok && resumed.automation?.nextRunAt, NOW + 15 * MIN);
    assert.equal(resumed.ok && resumed.automation?.consecutiveFailures, 0);
    assert.equal((await applyAutomationAct(deps, "a", { type: "resume" })).ok, false, "在排期的不用继续");
  });

  test("resume：次数用完的要 restart；once 已过的要先改时间", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "m", status: "paused", nextRunAt: null, maxRuns: 2, runCount: 2 }));
    assert.match(String((await applyAutomationAct(deps, "m", { type: "resume" })).ok), /false/);
    await store.insert(makeAutomation({ id: "o", status: "paused", nextRunAt: null, schedule: { kind: "once", at: NOW - 1000 } }));
    const stale = await applyAutomationAct(deps, "o", { type: "resume" });
    assert.equal(stale.ok, false);
    assert.match(stale.ok ? "" : stale.error, /already passed/);
  });

  test("restart：failed / completed 从头再来（次数清零、原因清掉、重新排期）；别的状态拒", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "f", status: "failed", nextRunAt: null, failureReason: "403", runCount: 5, consecutiveFailures: 3 }));
    await store.insert(makeAutomation({ id: "c", status: "completed", endReason: "finished", nextRunAt: null, maxRuns: 3, runCount: 3 }));
    const failed = await applyAutomationAct(deps, "f", { type: "restart" });
    assert.equal(failed.ok && failed.automation?.status, "active");
    assert.equal(failed.ok && failed.automation?.runCount, 0);
    assert.equal(failed.ok && failed.automation?.failureReason, undefined);
    assert.equal(failed.ok && failed.automation?.nextRunAt, NOW + 15 * MIN);
    const completed = await applyAutomationAct(deps, "c", { type: "restart" });
    assert.equal(completed.ok && completed.automation?.endReason, undefined);
    assert.equal(completed.ok && completed.automation?.status, "active");
    assert.equal((await applyAutomationAct(deps, "f", { type: "restart" })).ok, false, "在排期的不用重新启动");
  });

  test("restart 绑定的会话没了：拒并指路；一条会话上活跃的任务到 5 条后继续 / 重新启动被拒", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S" })] });
    const onSession = (id: string, patch: Partial<Automation> = {}): Automation =>
      makeAutomation({ id, target: { kind: "this_session", sessionId: "S", workspaceId: "ws1" }, ...patch });
    await store.insert(onSession("gone", { status: "completed", nextRunAt: null, target: { kind: "this_session", sessionId: "已删", workspaceId: null } }));
    const gone = await applyAutomationAct(deps, "gone", { type: "restart" });
    assert.equal(gone.ok, false);
    assert.match(gone.ok ? "" : gone.error, /no longer exists/);
    for (let i = 0; i < AUTOMATION_MAX_ACTIVE_PER_SESSION; i += 1) await store.insert(onSession(`t${i}`));
    await store.insert(onSession("extra", { status: "paused", nextRunAt: null }));
    const limited = await applyAutomationAct(deps, "extra", { type: "resume" });
    assert.equal(limited.ok, false);
    assert.match(limited.ok ? "" : limited.error, /At most 5/);
  });

  test("runNow 交给调度器：成功回最新状态，失败把调度器的话原样带回；delete 删掉并通知，不管状态", async () => {
    const ok = setup();
    await ok.store.insert(makeAutomation({ id: "a" }));
    const ran = await applyAutomationAct(ok.deps, "a", { type: "runNow" });
    assert.equal(ran.ok, true);
    assert.deepEqual(ok.state.runNowCalls, ["a"]);
    const refused = setup({ name: "refused", runNow: { ok: false, error: "The previous run is still going." } });
    await refused.store.insert(makeAutomation({ id: "a" }));
    const outcome = await applyAutomationAct(refused.deps, "a", { type: "runNow" });
    assert.deepEqual(outcome, { ok: false, error: "The previous run is still going." });
    const deleted = await applyAutomationAct(ok.deps, "a", { type: "delete" });
    assert.deepEqual(deleted, { ok: true, automation: null });
    assert.equal(await ok.store.get("a"), null);
  });

  test("未知动作 / 未知 id / 坏载荷都回一句话", async () => {
    const { deps, store } = setup();
    await store.insert(makeAutomation({ id: "a" }));
    assert.equal((await applyAutomationAct(deps, "a", { type: "enable", mode: "skip" })).ok, false);
    assert.equal((await applyAutomationAct(deps, "a", null)).ok, false);
    assert.equal((await applyAutomationAct(deps, "不存在", { type: "pause" })).ok, false);
    assert.equal((await applyAutomationAct(deps, undefined, { type: "pause" })).ok, false);
  });
});

describe("applyAutomationPromote（转成普通会话）", () => {
  test("自动化开的会话：标记 promoted 并通知；不是自动化开的 / 不存在：回一句话，不静默成功", async () => {
    const { deps, state } = setup({ metas: [meta({ id: "run", automationId: "a" }), meta({ id: "plain" })] });
    assert.deepEqual(await applyAutomationPromote(deps, "run"), { ok: true });
    assert.deepEqual(state.promoted, ["run"]);
    assert.equal(state.notifies, 1);
    const plain = await applyAutomationPromote(deps, "plain");
    assert.equal(plain.ok, false);
    assert.equal((await applyAutomationPromote(deps, "nope")).ok, false);
    assert.equal((await applyAutomationPromote(deps, 1)).ok, false);
    assert.deepEqual(state.promoted, ["run"]);
  });
});

/* ---------- agent 工具 ---------- */

function toolEvent(sessionId: string, request: AutomationToolRequest): Extract<AgentEvent, { type: "automationRequest" }> {
  return { type: "automationRequest", requestId: "req", sessionId, request };
}

const createRequest = (patch: Partial<Extract<AutomationToolRequest, { op: "create" }>> = {}): AutomationToolRequest => ({
  op: "create",
  title: "等 vLLM 起好再跑评测",
  prompt: "看 ~/vtest.log，起好了就跑 eval_intent.py",
  schedule: { kind: "interval", unit: "minute", every: 15 },
  ...patch,
});

describe("applyAutomationRequest：create", () => {
  test("默认投回创建它的会话、直接生效、没给终点默认最多 12 次、回对话卡摘要", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S", workspaceId: "ws1" })] });
    const result = await applyAutomationRequest(deps, toolEvent("S", createRequest()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [automation] = await store.list();
    assert.deepEqual(automation?.target, { kind: "this_session", sessionId: "S", workspaceId: "ws1" });
    assert.deepEqual(automation?.createdBy, { kind: "agent", sessionId: "S" });
    assert.equal(automation?.status, "active");
    assert.equal(automation?.maxRuns, AUTOMATION_AGENT_DEFAULT_MAX_RUNS);
    assert.equal(automation?.nextRunAt, NOW + 15 * MIN);
    assert.equal(result.automation?.target, "this_session");
    assert.equal(result.automation?.maxRuns, 12);
    assert.match(result.text, /is active/);
    assert.match(result.text, /end your turn/);
  });

  test("给了 until 就不再补默认次数；给了 maxRuns 以它为准且不超过 100", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S" })] });
    await applyAutomationRequest(deps, toolEvent("S", createRequest({ until: NOW + 2 * DAY })));
    await applyAutomationRequest(deps, toolEvent("S", createRequest({ maxRuns: 3 })));
    const list = await store.list();
    assert.equal(list.find((a) => a.until !== undefined)?.maxRuns, undefined);
    assert.equal(list.find((a) => a.maxRuns === 3)?.maxRuns, 3);
    const tooMany = await applyAutomationRequest(deps, toolEvent("S", createRequest({ maxRuns: 101 })));
    assert.equal(tooMany.ok, false);
  });

  test("new_session：落最保守的 plan 档；指名模型要真存在；this_session 不接受 model", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S" })] });
    const created = await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "new_session", model: "k3" })));
    assert.equal(created.ok, true);
    const automation = (await store.list())[0];
    assert.deepEqual(automation?.target, { kind: "new_session", workspaceId: "ws1" });
    assert.equal(automation?.mode, "plan");
    assert.equal(automation?.modelId, "k3");
    assert.equal(automation?.providerId, "kimi");
    assert.equal((await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "new_session", model: "没有这个" })))).ok, false);
    assert.equal((await applyAutomationRequest(deps, toolEvent("S", createRequest({ model: "k3" })))).ok, false);
    assert.equal((await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "elsewhere" as "new_session" })))).ok, false);
  });

  test("防递归：自动化新开的会话与子会话的请求一律拒，什么都不落盘", async () => {
    const { deps, store } = setup({
      metas: [meta({ id: "run", automationId: "a" }), meta({ id: "child", parentId: "S" }), meta({ id: "S" })],
    });
    for (const id of ["run", "child"]) {
      for (const request of [createRequest(), { op: "list" } as const, { op: "cancel", automationId: "x" } as const]) {
        const result = await applyAutomationRequest(deps, toolEvent(id, request));
        assert.equal(result.ok, false, `${id}/${request.op}`);
      }
    }
    assert.equal((await store.list()).length, 0);
    assert.equal((await applyAutomationRequest(deps, toolEvent("不存在的会话", createRequest()))).ok, false);
  });

  test("护栏：一条会话上活跃的任务最多 5 条；全局最多 20 条；校验沿用同一套", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S" }), meta({ id: "S2" })] });
    for (let i = 0; i < AUTOMATION_MAX_ACTIVE_PER_SESSION; i += 1) {
      assert.equal((await applyAutomationRequest(deps, toolEvent("S", createRequest({ title: `t${i}` })))).ok, true);
    }
    const sixth = await applyAutomationRequest(deps, toolEvent("S", createRequest({ title: "t6" })));
    assert.equal(sixth.ok, false);
    assert.match(sixth.ok ? "" : sixth.error, /At most 5/);
    assert.equal((await applyAutomationRequest(deps, toolEvent("S2", createRequest({ title: "别的会话" })))).ok, true, "别的会话不受影响");
    // new_session 的任务不占「会话」名额
    assert.equal((await applyAutomationRequest(deps, toolEvent("S", createRequest({ title: "n", target: "new_session" })))).ok, true);
    for (let i = (await store.list()).length; i < AUTOMATION_MAX_TOTAL; i += 1) await store.insert(makeAutomation({ id: `f${i}`, status: "completed" }));
    assert.equal((await applyAutomationRequest(deps, toolEvent("S2", createRequest({ title: "满了" })))).ok, false);
    for (const bad of [
      createRequest({ title: "" }),
      createRequest({ prompt: " " }),
      createRequest({ schedule: { kind: "interval", unit: "minute", every: 1 } }),
      createRequest({ until: NOW - 1 }),
    ]) {
      assert.equal((await applyAutomationRequest(deps, toolEvent("S2", bad))).ok, false);
    }
  });
});

describe("applyAutomationRequest：list / cancel（只管当前工作区）", () => {
  test("list 只给同一工作区的（Home = null 也算一个工作区），不带指令全文", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S", workspaceId: "ws1" }), meta({ id: "H", workspaceId: null })] });
    await store.insert(makeAutomation({ id: "mine", target: { kind: "new_session", workspaceId: "ws1" } }));
    await store.insert(makeAutomation({ id: "theirs", target: { kind: "new_session", workspaceId: "ws2" } }));
    await store.insert(makeAutomation({ id: "home", target: { kind: "this_session", sessionId: "H", workspaceId: null } }));
    const mine = await applyAutomationRequest(deps, toolEvent("S", { op: "list" }));
    assert.deepEqual(mine.ok && mine.automations?.map((a) => a.id), ["mine"]);
    assert.equal(mine.ok && "prompt" in (mine.automations?.[0] ?? {}), false);
    const home = await applyAutomationRequest(deps, toolEvent("H", { op: "list" }));
    assert.deepEqual(home.ok && home.automations?.map((a) => a.id), ["home"]);
    const empty = await applyAutomationRequest(setup({ name: "empty", metas: [meta({ id: "S" })] }).deps, toolEvent("S", { op: "list" }));
    assert.equal(empty.ok && empty.text, "No automations in this workspace.");
  });

  test("cancel：翻成 completed(cancelled)、排期与等待都清掉；别的工作区的当作不存在；已完成的幂等", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S", workspaceId: "ws1" })] });
    await store.insert(
      makeAutomation({
        id: "mine",
        target: { kind: "this_session", sessionId: "S", workspaceId: "ws1" },
        pendingDelivery: { since: NOW, trigger: "schedule", merged: 0 },
      }),
    );
    await store.insert(makeAutomation({ id: "theirs", target: { kind: "new_session", workspaceId: "ws2" } }));
    const cancelled = await applyAutomationRequest(deps, toolEvent("S", { op: "cancel", automationId: "mine" }));
    assert.equal(cancelled.ok && cancelled.automation?.status, "completed");
    const saved = await store.get("mine");
    assert.equal(saved?.endReason, "cancelled");
    assert.equal(saved?.nextRunAt, null);
    assert.equal(saved?.pendingDelivery, undefined);
    const again = await applyAutomationRequest(deps, toolEvent("S", { op: "cancel", automationId: "mine" }));
    assert.equal(again.ok && again.text.includes("already finished"), true);
    const foreign = await applyAutomationRequest(deps, toolEvent("S", { op: "cancel", automationId: "theirs" }));
    assert.equal(foreign.ok, false);
    assert.equal((await store.get("theirs"))?.status, "active", "别的工作区的任务纹丝不动");
    assert.equal((await applyAutomationRequest(deps, toolEvent("S", { op: "cancel", automationId: "" }))).ok, false);
  });
});
