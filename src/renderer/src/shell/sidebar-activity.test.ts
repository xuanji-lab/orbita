import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../features/notify/completion-notice.ts";
import { scopeSummary } from "../features/chat/galaxy-data.ts";
import { orderedSubAgents, realSubAgentFaces, rowActivityOf, subAgentFixtureEnabled, subAgentFixturesOf, subAgentSessionsOf } from "./sidebar-activity.ts";

const meta = (over: { id: string } & Partial<SessionMeta>): SessionMeta => ({
  title: `Task ${over.id}`,
  titleSource: "derived",
  cwd: "/tmp",
  workspaceId: "ws",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "skip",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** own = 根会话自己的槽，state = 含子会话的汇总（与 stateIndexOf 同形） */
const index = (own: Record<string, SessionRunState>, rolled: Record<string, SessionRunState> = {}) => ({
  own: (m: SessionMeta): SessionRunState => own[m.id] ?? null,
  state: (m: SessionMeta): SessionRunState => rolled[m.id] ?? own[m.id] ?? null,
});

describe("rowActivityOf —— 侧栏行里「谁在干活」", () => {
  const sessions = [
    meta({ id: "r1" }),
    meta({ id: "r2" }),
    meta({ id: "r3" }),
    meta({ id: "k1", parentId: "r1" }),
    meta({ id: "k2", parentId: "r1" }),
    meta({ id: "k3", parentId: "r3" }),
    meta({ id: "g1", parentId: "k3" }),
    meta({ id: "other", workspaceId: "else" }),
    meta({ id: "old", archived: true }),
  ];

  test("根会话自己在跑 = 主智能体在干活；子会话在跑 = 会话在跑；孙会话记在子会话头上", () => {
    const states = index({ r1: "running", k1: "running", k2: "waiting", other: "running", old: "running" }, { r1: "waiting", k3: "running" });
    const activity = rowActivityOf(sessions, "ws", states);
    assert.deepEqual(activity, { main: "working", mainWorking: 1, mainWaiting: 0, sessionsRunning: 2, sessionsWaiting: 1, subAgents: [] });
  });

  test("主智能体等你压过在干活（两条根会话一条等你一条在跑）", () => {
    const activity = rowActivityOf(sessions, "ws", index({ r1: "waiting", r2: "running", k1: "running" }));
    assert.equal(activity.main, "waiting");
    assert.equal(activity.mainWorking, 1);
    assert.equal(activity.sessionsRunning, 1);
  });

  test("只有会话在跑：主智能体空闲", () => {
    const activity = rowActivityOf(sessions, "ws", index({ k1: "running", k3: "running" }));
    assert.deepEqual(activity, { main: "idle", mainWorking: 0, mainWaiting: 0, sessionsRunning: 2, sessionsWaiting: 0, subAgents: [] });
  });

  test("星际空间没有主智能体：根会话在跑算会话", () => {
    const home = [meta({ id: "h1", workspaceId: null }), meta({ id: "h2", workspaceId: null }), meta({ id: "hk", workspaceId: null, parentId: "h1" })];
    const activity = rowActivityOf(home, null, index({ h1: "running", h2: "waiting", hk: "running" }));
    assert.deepEqual(activity, { main: "idle", mainWorking: 0, mainWaiting: 0, sessionsRunning: 2, sessionsWaiting: 1, subAgents: [] });
  });

  test("与 scopeSummary 逐件同数：主 + 会话 = 在跑 / 等你的件数（侧栏、页头、星系三处同一个数）", () => {
    const cases: Record<string, SessionRunState>[] = [
      { r1: "running", k1: "running", k2: "waiting", k3: "running" },
      { r1: "waiting", r2: "running", r3: "running", k1: "done", k2: "failed" },
      {},
      { k1: "waiting", k2: "waiting", k3: "waiting" },
    ];
    for (const own of cases) {
      const states = index(own, { k3: own.k3 ?? null });
      for (const workspaceId of ["ws", null]) {
        const activity = rowActivityOf(sessions, workspaceId, states);
        const summary = scopeSummary(sessions, workspaceId, states);
        const agentRunning = activity.subAgents.reduce((sum, agent) => sum + agent.running, 0);
        const agentWaiting = activity.subAgents.reduce((sum, agent) => sum + agent.waiting, 0);
        assert.equal(activity.mainWorking + activity.sessionsRunning + agentRunning, summary.running);
        assert.equal(activity.mainWaiting + activity.sessionsWaiting + agentWaiting, summary.waiting);
      }
    }
  });
});

describe("真数据：有归属的会话 = 那个子智能体在干活", () => {
  const owned = (id: string, subAgentId: string, extra: Partial<SessionMeta> = {}) =>
    meta({ id, parentId: "r1", attribution: { subAgentId, source: "assigned" }, ...extra });
  const sessions = [
    meta({ id: "r1" }),
    owned("a1", "agent-1"),
    owned("a2", "agent-1"),
    owned("b1", "agent-2"),
    meta({ id: "plain", parentId: "r1" }),
    meta({ id: "weak", parentId: "r1", attribution: { subAgentId: "agent-3", source: "inferred", share: 0.2 } }),
    owned("gone", "agent-deleted"),
  ];

  test("同一个子智能体几件活只画一个头像（有一件等你就是等你）；没归属 / 推断比例不够的算普通会话；不计两次", () => {
    const states = index({ a1: "running", a2: "waiting", b1: "running", plain: "running", weak: "running", gone: "running" });
    const activity = rowActivityOf(sessions, "ws", states);
    assert.deepEqual(activity.subAgents, [
      { id: "agent-1", state: "waiting", running: 1, waiting: 1 },
      { id: "agent-2", state: "working", running: 1, waiting: 0 },
      { id: "agent-deleted", state: "working", running: 1, waiting: 0 },
    ]);
    assert.equal(activity.sessionsRunning, 2);
    assert.equal(activity.sessionsWaiting, 0);
    // 做完的不画
    assert.deepEqual(rowActivityOf(sessions, "ws", index({ a1: "done", b1: "failed" })).subAgents, []);
  });

  test("头像只画名单里还在的行星；档案删了的那件退回插入符；头像带 demo:false（提示里不写「演示数据」）", () => {
    const activity = rowActivityOf(sessions, "ws", index({ a1: "running", b1: "running", gone: "running" }));
    const faces = realSubAgentFaces(activity.subAgents, ["rec", "agent-2", undefined, "agent-1"]);
    assert.deepEqual(faces.faces, [
      { planet: 3, state: "working", demo: false },
      { planet: 1, state: "working", demo: false },
    ]);
    assert.equal(faces.leftoverRunning, 1);
  });

  test("subAgentSessionsOf：按归属分组（不论状态，给下一轮的卫星 / 光环）；星际空间为空", () => {
    const grouped = subAgentSessionsOf(sessions, "ws");
    assert.deepEqual([...grouped.keys()], ["agent-1", "agent-2", "agent-deleted"]);
    assert.deepEqual(grouped.get("agent-1")?.map((m) => m.id), ["a1", "a2"]);
    assert.equal(subAgentSessionsOf(sessions, null).size, 0);
  });
});

describe("orderedSubAgents / fixture 解析", () => {
  test("全部都画、不折成 +N；等你的在前，同档按原次序", () => {
    assert.deepEqual(orderedSubAgents([]), []);
    const eight = Array.from({ length: 8 }, (_, planet) => ({ planet, state: planet === 5 ? ("waiting" as const) : ("working" as const) }));
    const ordered = orderedSubAgents(eight);
    assert.equal(ordered.length, 8);
    assert.deepEqual(ordered.map((agent) => agent.planet), [5, 0, 1, 2, 3, 4, 6, 7]);
  });

  test("坏值忽略", () => {
    assert.equal(subAgentFixtureEnabled("?fixture=sub-agents"), true);
    assert.equal(subAgentFixtureEnabled("?designer=full&fixture=sub-agents"), true);
    assert.equal(subAgentFixtureEnabled(""), false);
    assert.equal(subAgentFixtureEnabled("?fixture=other"), false);
    assert.deepEqual(subAgentFixturesOf({ orbita: [{ planet: 1, state: "working" }] }), { orbita: [{ planet: 1, state: "working" }] });
    assert.equal(subAgentFixturesOf({ orbita: [{ planet: -1, state: "working" }] }), null);
    assert.equal(subAgentFixturesOf({ orbita: [{ planet: 0, state: "busy" }] }), null);
    assert.equal(subAgentFixturesOf([1]), null);
    assert.equal(subAgentFixturesOf(null), null);
  });
});
