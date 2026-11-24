import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../features/notify/completion-notice.ts";
import { scopeSummary } from "../features/chat/galaxy-data.ts";
import { activityVariantOf, orderedSubAgents, rowActivityOf, subAgentFixturesOf } from "./sidebar-activity.ts";

const meta = (over: { id: string } & Partial<SessionMeta>): SessionMeta => ({
  title: `Task ${over.id}`,
  titleSource: "derived",
  cwd: "/tmp",
  workspaceId: "ws",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "manual",
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
    assert.deepEqual(activity, { main: "working", mainWorking: 1, mainWaiting: 0, sessionsRunning: 2, sessionsWaiting: 1 });
  });

  test("主智能体等你压过在干活（两条根会话一条等你一条在跑）", () => {
    const activity = rowActivityOf(sessions, "ws", index({ r1: "waiting", r2: "running", k1: "running" }));
    assert.equal(activity.main, "waiting");
    assert.equal(activity.mainWorking, 1);
    assert.equal(activity.sessionsRunning, 1);
  });

  test("只有会话在跑：主智能体空闲", () => {
    const activity = rowActivityOf(sessions, "ws", index({ k1: "running", k3: "running" }));
    assert.deepEqual(activity, { main: "idle", mainWorking: 0, mainWaiting: 0, sessionsRunning: 2, sessionsWaiting: 0 });
  });

  test("星际空间没有主智能体：根会话在跑算会话", () => {
    const home = [meta({ id: "h1", workspaceId: null }), meta({ id: "h2", workspaceId: null }), meta({ id: "hk", workspaceId: null, parentId: "h1" })];
    const activity = rowActivityOf(home, null, index({ h1: "running", h2: "waiting", hk: "running" }));
    assert.deepEqual(activity, { main: "idle", mainWorking: 0, mainWaiting: 0, sessionsRunning: 2, sessionsWaiting: 1 });
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
        assert.equal(activity.mainWorking + activity.sessionsRunning, summary.running);
        assert.equal(activity.mainWaiting + activity.sessionsWaiting, summary.waiting);
      }
    }
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
    assert.equal(activityVariantOf("b"), "b");
    assert.equal(activityVariantOf("d"), null);
    assert.deepEqual(subAgentFixturesOf({ orbita: [{ planet: 1, state: "working" }] }), { orbita: [{ planet: 1, state: "working" }] });
    assert.equal(subAgentFixturesOf({ orbita: [{ planet: -1, state: "working" }] }), null);
    assert.equal(subAgentFixturesOf({ orbita: [{ planet: 0, state: "busy" }] }), null);
    assert.equal(subAgentFixturesOf([1]), null);
    assert.equal(subAgentFixturesOf(null), null);
  });
});
