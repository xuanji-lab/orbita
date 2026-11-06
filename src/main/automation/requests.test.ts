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
import type { PermissionMode } from "../../shared/permission.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { makeAutomation } from "./fixtures.ts";
import {
  applyAutomationAct,
  applyAutomationCreate,
  applyAutomationModeFromRow,
  applyAutomationPromote,
  applyAutomationRequest,
  applyAutomationUpdate,
  listAutomations,
  parseAutomationModeRowRequest,
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

function toolEvent(
  sessionId: string,
  request: AutomationToolRequest,
  mode: PermissionMode = "skip",
): Extract<AgentEvent, { type: "automationRequest" }> {
  return { type: "automationRequest", requestId: "req", sessionId, mode, request };
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

describe("选插件", () => {
  const withPlugins = (enabledIn: Record<string, string[]>, metas: SessionMeta[] = []) => {
    const built = setup({ metas });
    built.deps.plugins = { enabledIn: async (workspaceId) => enabledIn[workspaceId ?? "home"] ?? [] };
    return built;
  };

  test("面板新建：插件要在这个工作区启用着；名字不合规 / 没装都拒；不给就没有", async () => {
    const { deps, store } = withPlugins({ ws1: ["lit"] });
    const ok = await applyAutomationCreate(deps, { ...validCreate, plugin: { name: "lit" } });
    assert.equal(ok.ok, true);
    assert.deepEqual((await store.list())[0]?.plugin, { name: "lit" });
    const missing = await applyAutomationCreate(deps, { ...validCreate, plugin: { name: "other" } });
    assert.match(missing.ok ? "" : missing.error, /not installed, not enabled in this workspace, or has no board/);
    const bad = await applyAutomationCreate(deps, { ...validCreate, plugin: { name: "../x" } });
    assert.match(bad.ok ? "" : bad.error, /valid plugin name/);
    const elsewhere = await applyAutomationCreate(deps, { ...validCreate, workspaceId: "ws2", plugin: { name: "lit" } });
    assert.equal(elsewhere.ok, false);
    const none = await applyAutomationCreate(deps, validCreate);
    assert.equal(none.ok && none.automation?.plugin, undefined);
  });

  test("编辑：换插件要校验；null 清掉", async () => {
    const { deps, store } = withPlugins({ ws1: ["lit", "weekly"] });
    await store.insert(makeAutomation({ id: "a", plugin: { name: "lit" }, target: { kind: "new_session", workspaceId: "ws1" } }));
    assert.equal((await applyAutomationUpdate(deps, "a", { plugin: { name: "weekly" } })).ok, true);
    assert.deepEqual((await store.get("a"))?.plugin, { name: "weekly" });
    assert.equal((await applyAutomationUpdate(deps, "a", { plugin: { name: "nope" } })).ok, false);
    assert.equal((await applyAutomationUpdate(deps, "a", { plugin: null })).ok, true);
    assert.equal((await store.get("a"))?.plugin, undefined);
  });

  test("agent 建：plugin 参数按会话工作区校验，回执提到插件，对话卡带插件名", async () => {
    const { deps, store } = withPlugins({ ws1: ["lit"] }, [meta({ id: "S", workspaceId: "ws1" })]);
    const result = await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "new_session", plugin: "lit" })));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /use the plugin "lit"/);
    // 新会话档先落 Plan：回执要求模型转告用户「定时跑默认只读」，并先口头问、同意后再 automation_update（不再让用户去面板里改）
    assert.match(result.text, /tell the user/);
    assert.match(result.text, /read-only by default/);
    assert.match(result.text, /call automation_update with mode "skip"/);
    assert.doesNotMatch(result.text, /Do not try to change it yourself|Automations panel/);
    assert.equal(result.automation?.plugin, "lit");
    assert.deepEqual((await store.list())[0]?.plugin, { name: "lit" });
    const refused = await applyAutomationRequest(deps, toolEvent("S", createRequest({ plugin: "other" })));
    assert.equal(refused.ok, false);
  });

  test("agent 建：没带插件、或回到本会话的自动化，回执里没有「转告用户改权限」那句", async () => {
    const { deps } = withPlugins({ ws1: ["lit"] }, [meta({ id: "S", workspaceId: "ws1" })]);
    const plain = await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "new_session" })));
    assert.equal(plain.ok && /tell the user/.test(plain.text), false);
    const sameSession = await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "this_session", plugin: "lit" })));
    assert.equal(sameSession.ok && /tell the user/.test(sameSession.text), false);
  });
});

describe("agent 改自动化权限档：automation_update / create.mode（不高于会话此刻的档）", () => {
  const updateSkip = (id: string): AutomationToolRequest => ({ op: "update", automationId: id, mode: "skip" });
  const seed = async (store: AutomationStore, patch: Partial<Automation> = {}) =>
    store.insert(makeAutomation({ id: "a", target: { kind: "new_session", workspaceId: "ws1" }, ...patch }));

  test("会话是放行档：直接改成 skip，回「已改成放行」行数据，并通知界面", async () => {
    const { deps, store, state } = setup({ metas: [meta({ id: "S", mode: "skip" })] });
    await seed(store);
    const result = await applyAutomationRequest(deps, toolEvent("S", updateSkip("a"), "skip"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((await store.get("a"))?.mode, "skip");
    assert.equal(result.modeRow?.state, "applied");
    assert.equal(result.modeRow?.automationId, "a");
    assert.equal(result.modeRow?.sessionMode, "skip");
    assert.match(result.text, /now runs with full permissions/);
    assert.equal(state.notifies, 1);
  });

  test("会话是手动 / 计划档：不改，留「待你确认」行，回执让模型结束这一轮、别重调", async () => {
    for (const mode of ["manual", "plan"] as const) {
      const { deps, store } = setup({ name: mode, metas: [meta({ id: "S", mode })] });
      await seed(store);
      const result = await applyAutomationRequest(deps, toolEvent("S", updateSkip("a"), mode));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal((await store.get("a"))?.mode, "plan", `${mode} 档下 mode 纹丝不动`);
      assert.equal(result.modeRow?.state, "pending");
      assert.equal(result.modeRow?.sessionMode, mode);
      assert.match(result.text, /NOT changed/);
      assert.match(result.text, /End your turn/);
      assert.match(result.text, /do not call automation_update again/);
    }
  });

  test("agent 账本说放行、落盘 meta 不是放行（或反过来）：按更严的算，不直接改", async () => {
    const lagging = setup({ metas: [meta({ id: "S", mode: "manual" })] });
    await seed(lagging.store);
    const a = await applyAutomationRequest(lagging.deps, toolEvent("S", updateSkip("a"), "skip"));
    assert.equal(a.ok && a.modeRow?.state, "pending");
    assert.equal(a.ok && a.modeRow?.sessionMode, "manual");
    assert.equal((await lagging.store.get("a"))?.mode, "plan");
    const lowered = setup({ name: "b", metas: [meta({ id: "S", mode: "skip" })] });
    await seed(lowered.store);
    const b = await applyAutomationRequest(lowered.deps, toolEvent("S", updateSkip("a"), "manual"));
    assert.equal(b.ok && b.modeRow?.state, "pending");
  });

  test("请求 plan 永远直接改（任何档），没有行；本来就是 skip 再请求 skip 不重复留行", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S", mode: "manual" })] });
    await seed(store, { mode: "skip" });
    const same = await applyAutomationRequest(deps, toolEvent("S", updateSkip("a"), "manual"));
    assert.equal(same.ok && same.modeRow, undefined);
    assert.equal((await store.get("a"))?.mode, "skip", "manual 档请求 skip 而它已是 skip：不动");
    const down = await applyAutomationRequest(deps, toolEvent("S", { op: "update", automationId: "a", mode: "plan" }, "manual"));
    assert.equal(down.ok && down.modeRow, undefined);
    assert.equal((await store.get("a"))?.mode, "plan");
  });

  test("越权与不合法：别的工作区的当作不存在；this_session / 已结束 / 坏 mode / 空 id 都拒，什么都不改", async () => {
    const { deps, store, state } = setup({ metas: [meta({ id: "S", mode: "skip" })] });
    await seed(store, { id: "theirs", target: { kind: "new_session", workspaceId: "ws2" } });
    await seed(store, { id: "bound", target: { kind: "this_session", sessionId: "S", workspaceId: "ws1" } });
    await seed(store, { id: "done", status: "completed", endReason: "cancelled", nextRunAt: null });
    for (const id of ["theirs", "bound", "done", "不存在", ""]) {
      const result = await applyAutomationRequest(deps, toolEvent("S", updateSkip(id), "skip"));
      assert.equal(result.ok, false, id);
    }
    const bad = await applyAutomationRequest(deps, toolEvent("S", { op: "update", automationId: "bound", mode: "manual" as "skip" }, "skip"));
    assert.equal(bad.ok, false);
    for (const id of ["theirs", "bound", "done"]) assert.equal((await store.get(id))?.mode, "plan");
    assert.equal(state.notifies, 0);
  });

  test("自动化新开的会话 / 子会话 / 开关关着：update 一样被拒（与其它工具同一道门）", async () => {
    const { deps, store } = setup({
      metas: [meta({ id: "RUN", automationId: "x" }), meta({ id: "CHILD", parentId: "S" }), meta({ id: "S" })],
    });
    await seed(store);
    for (const id of ["RUN", "CHILD", "不存在"]) {
      assert.equal((await applyAutomationRequest(deps, toolEvent(id, updateSkip("a"), "skip"))).ok, false, id);
    }
    assert.equal((await store.get("a"))?.mode, "plan");
  });

  test("create 带 mode:skip：放行档直接建成 skip 并带行；手动档建成 plan 并带待确认行；this_session 忽略 mode", async () => {
    const direct = setup({ metas: [meta({ id: "S", mode: "skip" })] });
    const a = await applyAutomationRequest(direct.deps, toolEvent("S", createRequest({ target: "new_session", mode: "skip" }), "skip"));
    assert.equal(a.ok && a.modeRow?.state, "applied");
    assert.equal((await direct.store.list())[0]?.mode, "skip");
    assert.equal(a.ok && a.modeRow?.automationId, (await direct.store.list())[0]?.id);

    const ask = setup({ name: "m", metas: [meta({ id: "S", mode: "manual" })] });
    const b = await applyAutomationRequest(ask.deps, toolEvent("S", createRequest({ target: "new_session", mode: "skip" }), "manual"));
    assert.equal(b.ok && b.modeRow?.state, "pending");
    assert.equal((await ask.store.list())[0]?.mode, "plan");
    assert.match(b.ok ? b.text : "", /do not call automation_update again/);

    const bound = setup({ name: "t", metas: [meta({ id: "S", mode: "skip" })] });
    const c = await applyAutomationRequest(bound.deps, toolEvent("S", createRequest({ mode: "skip" }), "skip"));
    assert.equal(c.ok && c.modeRow, undefined);
    assert.match(c.ok ? c.text : "", /ignored/);

    const wrong = await applyAutomationRequest(direct.deps, toolEvent("S", createRequest({ mode: "manual" as "skip" }), "skip"));
    assert.equal(wrong.ok, false);
  });

  test("create 不带 mode：回执里不再说「别自己改」，而是让模型先口头问、同意后再 automation_update", async () => {
    const { deps } = setup({ metas: [meta({ id: "S" })] });
    const plain = await applyAutomationRequest(deps, toolEvent("S", createRequest({ target: "new_session" })));
    assert.match(plain.ok ? plain.text : "", /ask the user in one sentence/);
    assert.match(plain.ok ? plain.text : "", /automation_update/);
    assert.doesNotMatch(plain.ok ? plain.text : "", /Do not try to change it yourself|Automations panel/);
  });
});

describe("applyAutomationModeFromRow（用户点那一行的按钮：主进程重验后才改）", () => {
  const click = (patch: Record<string, unknown> = {}) => ({ sessionId: "S", automationId: "a", requestId: "r1", action: "allow", ...patch });
  const seed = async (store: AutomationStore, patch: Partial<Automation> = {}) =>
    store.insert(
      makeAutomation({ id: "a", target: { kind: "new_session", workspaceId: "ws1" }, createdBy: { kind: "agent", sessionId: "S" }, ...patch }),
    );

  test("允许：改成 skip 并通知；改回只读：改成 plan 并记下 requestId；保持只读：只记下，不动档", async () => {
    const { deps, store, state } = setup({ metas: [meta({ id: "S", mode: "manual" })] });
    await seed(store);
    assert.deepEqual(await applyAutomationModeFromRow(deps, click()), { ok: true });
    assert.equal((await store.get("a"))?.mode, "skip");
    assert.equal((await store.get("a"))?.modeDeclined, undefined);
    assert.deepEqual(await applyAutomationModeFromRow(deps, click({ action: "readonly" })), { ok: true });
    assert.equal((await store.get("a"))?.mode, "plan");
    assert.deepEqual((await store.get("a"))?.modeDeclined, ["r1"]);
    assert.deepEqual(await applyAutomationModeFromRow(deps, click({ requestId: "r2", action: "keep" })), { ok: true });
    assert.equal((await store.get("a"))?.mode, "plan");
    assert.deepEqual((await store.get("a"))?.modeDeclined, ["r1", "r2"]);
    assert.equal(state.notifies, 3);
  });

  test("重验失败：会话没了 / 自动化没了 / 别的工作区且不是这条会话建的 / this_session / 已结束时「允许」→ 稳定代码，不改", async () => {
    const { deps, store, state } = setup({ metas: [meta({ id: "S" }), meta({ id: "RUN", automationId: "x" })] });
    await seed(store);
    await seed(store, { id: "foreign", target: { kind: "new_session", workspaceId: "ws2" }, createdBy: { kind: "user" } });
    await seed(store, { id: "bound", target: { kind: "this_session", sessionId: "S", workspaceId: "ws1" } });
    await seed(store, { id: "done", status: "completed", endReason: "cancelled", nextRunAt: null });
    const reason = async (patch: Record<string, unknown>) => {
      const result = await applyAutomationModeFromRow(deps, click(patch));
      return result.ok ? "ok" : result.reason;
    };
    assert.equal(await reason({ sessionId: "不存在的会话" }), "noSession");
    assert.equal(await reason({ sessionId: "RUN" }), "noSession", "自动化新开的会话不能管自动化");
    assert.equal(await reason({ automationId: "不存在" }), "notFound");
    assert.equal(await reason({ automationId: "foreign" }), "notFound");
    assert.equal(await reason({ automationId: "bound" }), "notApplicable");
    assert.equal(await reason({ automationId: "done" }), "finished");
    assert.equal(await reason({ automationId: "done", action: "keep" }), "ok", "已结束的「保持只读」只是记一笔，不算失败");
    for (const id of ["a", "foreign", "bound"]) assert.equal((await store.get(id))?.mode, "plan");
    assert.equal(state.notifies, 1);
  });

  test("不是这条会话建的、但在同一工作区（用户手建的）也能改；开关关着回 disabled", async () => {
    const { deps, store, state } = setup({ metas: [meta({ id: "S" })] });
    await seed(store, { id: "panel", createdBy: { kind: "user" } });
    assert.deepEqual(await applyAutomationModeFromRow(deps, click({ automationId: "panel" })), { ok: true });
    assert.equal((await store.get("panel"))?.mode, "skip");
    state.enabled = false;
    const off = await applyAutomationModeFromRow(deps, click({ automationId: "panel", action: "readonly" }));
    assert.equal(!off.ok && off.reason, "disabled");
    assert.equal((await store.get("panel"))?.mode, "skip");
  });

  test("modeDeclined 只留最近 10 个；同一个 requestId 不重复", async () => {
    const { deps, store } = setup({ metas: [meta({ id: "S" })] });
    await seed(store);
    for (let i = 0; i < 12; i += 1) await applyAutomationModeFromRow(deps, click({ requestId: `r${i}`, action: "keep" }));
    await applyAutomationModeFromRow(deps, click({ requestId: "r11", action: "keep" }));
    const declined = (await store.get("a"))?.modeDeclined ?? [];
    assert.equal(declined.length, 10);
    assert.deepEqual(declined.slice(-2), ["r10", "r11"]);
  });
});

describe("parseAutomationModeRowRequest（IPC 入参校验）", () => {
  const good = { sessionId: "S", automationId: "a", requestId: "r", action: "allow" };
  test("合法的原样通过", () => {
    assert.deepEqual(parseAutomationModeRowRequest(good), { ok: true, value: good });
    for (const action of ["allow", "readonly", "keep"]) assert.equal(parseAutomationModeRowRequest({ ...good, action }).ok, true);
  });
  test("非对象 / 缺字段 / 空串 / 非字符串 / 超长 / 未知 action 一律拒", () => {
    for (const bad of [null, "x", 1, [], {}, { ...good, sessionId: "" }, { ...good, automationId: 3 }, { ...good, requestId: undefined }, { ...good, sessionId: "x".repeat(201) }, { ...good, action: "skip" }, { ...good, action: undefined }]) {
      assert.equal(parseAutomationModeRowRequest(bad).ok, false, JSON.stringify(bad));
    }
  });
});
