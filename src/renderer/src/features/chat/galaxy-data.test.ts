import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionMeta } from "@shared/session";
import { runStateOf, type SessionRunState } from "../notify/completion-notice.ts";
import { FRAME_EXTENT, PLANET_MASS, PLANET_ZONE, STAR_MASS, VISIBLE_ORBIT_CAP, layoutGalaxy, planetRadius, starRadius } from "./galaxy.ts";
import { IDLE_CHILD_MS, ORBIT_FIRST, ORBIT_SPREAD_MAX, ORBIT_STEP, RECENT_MENU_LIMIT, latestWorkspaceId, orbitRadiusOf, planetMassOf, scopeGalaxy, scopeRecent, scopeSummary, scopeTone, stateIndexOf, stateOfIndex } from "./galaxy-data.ts";

const meta = (over: { id: string; updatedAt: number } & Partial<SessionMeta>): SessionMeta => ({
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
  ...over,
});

const states = (map: Record<string, SessionRunState>) => (m: SessionMeta): SessionRunState => map[m.id] ?? null;

describe("scopeGalaxy —— 真实会话 → 星系", () => {
  test("空工作区：只有主星，没有行星与碎石（交给 layoutGalaxy 画预期轨道）", () => {
    const galaxy = scopeGalaxy({ sessions: [], workspaceId: "ws", now: 100_000, stateOf: states({}), starMass: 620, designedPlanet: null });
    assert.deepEqual(galaxy.spec, { starMass: 620, planets: [], sessions: 0 });
    assert.equal(layoutGalaxy(galaxy.spec).expectedOrbit !== null, true);
  });

  test("行星 = 子会话 + 在跑 / 等你的根会话；其余根会话进碎石带；别的工作区、归档、未转正的自动化不算", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 10 }),
      meta({ id: "b", updatedAt: 20 }),
      meta({ id: "c", updatedAt: 30 }),
      meta({ id: "a-child", updatedAt: 40, parentId: "a" }),
      meta({ id: "other", updatedAt: 50, workspaceId: "ws2" }),
      meta({ id: "old", updatedAt: 60, archived: true }),
      meta({ id: "auto", updatedAt: 70, automationId: "x" }),
      meta({ id: "other-child", updatedAt: 80, parentId: "other" }),
    ];
    const galaxy = scopeGalaxy({ sessions, workspaceId: "ws", now: 100_000, stateOf: states({ b: "running", c: "done" }), starMass: 620, designedPlanet: null });
    assert.deepEqual(galaxy.planetIds, ["b", "a-child"]);
    assert.equal(galaxy.spec.sessions, 2); // a 与 c
  });

  test("排序：等你 → 在跑 → 出错 → 跑完 → 其它，同档新的在前；越要紧越靠内圈", () => {
    const sessions = [
      meta({ id: "p", updatedAt: 1 }),
      meta({ id: "k1", updatedAt: 5, parentId: "p" }),
      meta({ id: "k2", updatedAt: 6, parentId: "p" }),
      meta({ id: "k3", updatedAt: 7, parentId: "p" }),
      meta({ id: "k4", updatedAt: 8, parentId: "p" }),
      meta({ id: "w", updatedAt: 2 }),
    ];
    const galaxy = scopeGalaxy({
      sessions,
      workspaceId: "ws",
      now: 100_000, stateOf: states({ k1: "done", k2: "failed", k3: "running", w: "waiting", p: "running" }),
      starMass: 620,
      designedPlanet: null,
    });
    assert.deepEqual(galaxy.planetIds, ["w", "k3", "p", "k2", "k1", "k4"]);
    const orbits = galaxy.spec.planets.map((planet) => planet.orbitRadius);
    assert.deepEqual([...orbits].sort((a, b) => a - b), orbits);
    assert.equal(galaxy.spec.planets[0]?.state, "waiting");
  });

  test("满载（十几件在跑、40 多条子会话、2000 条旧会话）：只画 6 圈，最要紧的都在里面；外缘不出统一画框；行星都远小于主星", () => {
    const sessions: SessionMeta[] = [];
    const map: Record<string, SessionRunState> = {};
    for (let i = 0; i < 2000; i++) sessions.push(meta({ id: `old${i}`, updatedAt: i, stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: i * 9000 }, cost: 0, contextUsage: null } }));
    for (let i = 0; i < 14; i++) {
      sessions.push(meta({ id: `run${i}`, updatedAt: 5000 + i }));
      map[`run${i}`] = i < 3 ? "waiting" : "running";
    }
    for (let i = 0; i < 42; i++) sessions.push(meta({ id: `kid${i}`, updatedAt: 3000 + i, parentId: `run${i % 14}`, stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 ** (i % 8) }, cost: 0, contextUsage: null } }));
    const galaxy = scopeGalaxy({ sessions, workspaceId: "ws", now: 100_000, stateOf: states(map), starMass: 620, designedPlanet: null });
    const layout = layoutGalaxy(galaxy.spec);
    assert.equal(layout.planets.length, VISIBLE_ORBIT_CAP);
    assert.equal(layout.hidden, 14 + 42 - VISIBLE_ORBIT_CAP);
    assert.deepEqual(layout.planets.slice(0, 3).map((planet) => planet.state), ["waiting", "waiting", "waiting"]);
    assert.equal(galaxy.spec.sessions, 2000);
    assert.ok(layout.extent <= FRAME_EXTENT, `外缘 ${layout.extent}`);
    const biggest = Math.max(...galaxy.spec.planets.map((planet) => planetRadius(planet)));
    assert.ok(biggest < starRadius(STAR_MASS.min) / 2);
  });

  test("设计过的行星套在排第一的那颗上（质量、成分），轨道仍按排名", () => {
    const sessions = [meta({ id: "a", updatedAt: 1 }), meta({ id: "b", updatedAt: 2 })];
    const galaxy = scopeGalaxy({
      sessions,
      workspaceId: "ws",
      now: 100_000, stateOf: states({ a: "running", b: "running" }),
      starMass: 900,
      designedPlanet: { mass: 30, composition: "gas" },
    });
    assert.equal(galaxy.spec.starMass, 900);
    assert.equal(galaxy.spec.planets[0]?.id, "b");
    assert.equal(galaxy.spec.planets[0]?.mass, 30);
    assert.equal(galaxy.spec.planets[0]?.composition, "gas");
    assert.notEqual(galaxy.spec.planets[1]?.mass, 30);
  });

  test("没动静的子会话超过 IDLE_CHILD_MS 就退场进碎石带；亮着状态的不管多久都留在轨道上", () => {
    const now = 10 * IDLE_CHILD_MS;
    const sessions = [
      meta({ id: "p", updatedAt: now }),
      meta({ id: "fresh", updatedAt: now - 1000, parentId: "p" }),
      meta({ id: "stale", updatedAt: now - IDLE_CHILD_MS - 1, parentId: "p" }),
      meta({ id: "stale-running", updatedAt: 0, parentId: "p" }),
    ];
    const galaxy = scopeGalaxy({ sessions, workspaceId: "ws", now, stateOf: states({ "stale-running": "running" }), starMass: 620, designedPlanet: null });
    assert.deepEqual(galaxy.planetIds, ["stale-running", "fresh"]);
    assert.equal(galaxy.spec.sessions, 2); // 根会话 p + 退场的 stale
  });

  test("母会话只因孩子在跑而亮：只有孩子上轨道；母会话自己在跑才也上（给了 ownStateOf）", () => {
    const sessions = [meta({ id: "p", updatedAt: 1 }), meta({ id: "k", updatedAt: 2, parentId: "p" }), meta({ id: "q", updatedAt: 3 })];
    const rollup = states({ p: "running", k: "running", q: "running" });
    const own = states({ q: "running" });
    const galaxy = scopeGalaxy({ sessions, workspaceId: "ws", now: 100_000, stateOf: rollup, ownStateOf: own, starMass: 620, designedPlanet: null });
    assert.deepEqual(galaxy.planetIds, ["q", "k"]);
    assert.equal(galaxy.spec.sessions, 1); // p
  });

  test("同一份数据每次排出同一座星系（确定、不随机）；全局首页（workspaceId null）只收不属于工作区的会话", () => {
    const sessions = [meta({ id: "x", updatedAt: 1, workspaceId: null }), meta({ id: "y", updatedAt: 2 })];
    const one = scopeGalaxy({ sessions, workspaceId: null, now: 100_000, stateOf: states({ x: "running" }), starMass: 620, designedPlanet: null });
    const two = scopeGalaxy({ sessions, workspaceId: null, now: 100_000, stateOf: states({ x: "running" }), starMass: 620, designedPlanet: null });
    assert.deepEqual(one, two);
    assert.deepEqual(one.planetIds, ["x"]);
    assert.equal(one.spec.sessions, 0);
  });
});

describe("stateOfIndex —— 批量问运行态", () => {
  test("与 runStateOf 逐条一致：自己在跑、子会话等你、未读、什么都没有", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 1 }),
      meta({ id: "b", updatedAt: 2 }),
      meta({ id: "b1", updatedAt: 3, parentId: "b" }),
      meta({ id: "c", updatedAt: 4, unread: { at: 1, failed: true } }),
      meta({ id: "d", updatedAt: 5 }),
    ];
    const source = {
      sessions,
      phaseOf: (id: string) => (id === "a" ? ("turn" as const) : ("idle" as const)),
      approvalsOf: (id: string) => (id === "b1" ? [1] : []),
      planAwaitingOf: () => false,
    };
    const fast = stateOfIndex(source);
    for (const m of sessions) assert.equal(fast(m), runStateOf(source, m), m.id);
    assert.deepEqual(sessions.map(fast), ["running", "waiting", "waiting", "failed", null]);
  });
});

describe("stateIndexOf.own —— 只看自己的槽", () => {
  test("母会话自己空闲、孩子在跑：汇总态是在跑，自己的态不是", () => {
    const parent = meta({ id: "p", updatedAt: 1 });
    const child = meta({ id: "k", updatedAt: 2, parentId: "p" });
    const index = stateIndexOf({
      sessions: [parent, child],
      phaseOf: (id) => (id === "k" ? "turn" : "idle"),
      approvalsOf: () => [],
    });
    assert.equal(index.state(parent), "running");
    assert.equal(index.own(parent), null);
    assert.equal(index.own(child), "running");
  });
});

describe("planetMassOf —— 行星质量来自 token 量", () => {
  test("单调、夹在行星区间里，最大也远低于主星下限", () => {
    assert.equal(planetMassOf(null), PLANET_MASS.min * 1.5);
    assert.ok(planetMassOf(10_000) < planetMassOf(1_000_000));
    assert.ok(planetMassOf(1e12) <= 16);
    assert.ok(planetMassOf(1) >= PLANET_MASS.min);
  });
});

describe("scopeSummary / scopeTone —— 侧栏行与页头说的那句状态", () => {
  test("只数根会话：等你压过在跑；最近活动取最新一条；空工作区全零", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 10, title: "旧的" }),
      meta({ id: "b", updatedAt: 30, title: "最新的" }),
      meta({ id: "b-kid", updatedAt: 99, parentId: "b" }),
    ];
    const summary = scopeSummary(sessions, "ws", states({ a: "running", b: "waiting", "b-kid": "running" }));
    assert.deepEqual(summary, { waiting: 1, running: 1, total: 2, lastActive: 30, lastTitle: "最新的", waitingId: "b" });
    assert.equal(scopeTone(summary), "waiting");
    assert.equal(scopeTone({ waiting: 0, running: 2 }), "running");
    const empty = scopeSummary([], "ws", states({}));
    assert.deepEqual(empty, { waiting: 0, running: 0, total: 0, lastActive: null, lastTitle: null, waitingId: null });
    assert.equal(scopeTone(empty), "idle");
  });
});

describe("scopeSummary.waitingId / scopeRecent —— 页头胶囊直达与会话菜单", () => {
  const sessions = [
    meta({ id: "w1", updatedAt: 10 }),
    meta({ id: "w2", updatedAt: 30 }),
    meta({ id: "r", updatedAt: 20 }),
    meta({ id: "idle-new", updatedAt: 99 }),
    meta({ id: "idle-old", updatedAt: 1 }),
    meta({ id: "kid", updatedAt: 50, parentId: "w1" }),
    meta({ id: "elsewhere", updatedAt: 60, workspaceId: "ws2" }),
    meta({ id: "gone", updatedAt: 70, archived: true }),
  ];
  const stateOf = states({ w1: "waiting", w2: "waiting", r: "running" });

  test("waitingId 取最近一条等你的根会话；没有等你的为 null", () => {
    assert.equal(scopeSummary(sessions, "ws", stateOf).waitingId, "w2");
    assert.equal(scopeSummary(sessions, "ws", states({ r: "running" })).waitingId, null);
    assert.equal(scopeSummary([], "ws", stateOf).waitingId, null);
  });

  test("会话菜单：等你 → 在跑 → 其余按最近活动；不含子会话、归档与别的工作区；total 不受 limit 截断", () => {
    const { rows, total } = scopeRecent(sessions, "ws", stateOf);
    assert.deepEqual(rows.map((row) => row.meta.id), ["w2", "w1", "r", "idle-new", "idle-old"]);
    assert.equal(total, 5);
    const capped = scopeRecent(sessions, "ws", stateOf, 2);
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.total, 5);
    assert.equal(RECENT_MENU_LIMIT, 8);
  });

  test("2000 条旧会话：菜单只取 limit 条，总数照实", () => {
    const many = Array.from({ length: 2000 }, (_, i) => meta({ id: `o${i}`, updatedAt: i }));
    const { rows, total } = scopeRecent(many, "ws", states({}));
    assert.equal(rows.length, RECENT_MENU_LIMIT);
    assert.equal(rows[0]?.meta.id, "o1999");
    assert.equal(total, 2000);
  });
});

describe("latestWorkspaceId —— 切到编排先落哪座星系", () => {
  const workspaces = [{ id: "a" }, { id: "b" }, { id: "c" }];
  test("最近有根会话活动的工作区；不认归档、子会话、已移除工作区的会话", () => {
    const sessions = [
      meta({ id: "1", updatedAt: 10, workspaceId: "a" }),
      meta({ id: "2", updatedAt: 20, workspaceId: "c" }),
      meta({ id: "3", updatedAt: 90, workspaceId: "b", archived: true }),
      meta({ id: "4", updatedAt: 95, workspaceId: "b", parentId: "1" }),
      meta({ id: "5", updatedAt: 99, workspaceId: "gone" }),
      meta({ id: "6", updatedAt: 98, workspaceId: null }),
    ];
    assert.equal(latestWorkspaceId(sessions, workspaces), "c");
  });
  test("没有任何会话取列表第一个；一个工作区也没有是 null", () => {
    assert.equal(latestWorkspaceId([], workspaces), "a");
    assert.equal(latestWorkspaceId([], []), null);
  });
});

describe("orbitRadiusOf —— 行星少时铺开，满了回到等距", () => {
  test("只有一颗在行星区中段；n 颗单调递增、间距不超过 ORBIT_STEP 的 2.3 倍、最外圈不出行星区", () => {
    assert.ok(orbitRadiusOf(0, 1) > ORBIT_FIRST + 5 && orbitRadiusOf(0, 1) < PLANET_ZONE - 3);
    for (let n = 2; n <= VISIBLE_ORBIT_CAP + 3; n++) {
      const radii = Array.from({ length: Math.min(n, VISIBLE_ORBIT_CAP) }, (_, i) => orbitRadiusOf(i, n));
      for (let i = 1; i < radii.length; i++) {
        assert.ok((radii[i] ?? 0) > (radii[i - 1] ?? 0));
        assert.ok((radii[i] ?? 0) - (radii[i - 1] ?? 0) <= ORBIT_STEP * ORBIT_SPREAD_MAX + 1e-9);
      }
      assert.ok((radii.at(-1) ?? 0) <= PLANET_ZONE - 3 + 1e-9, `n=${n}`);
    }
  });
  test("满 VISIBLE_ORBIT_CAP 颗（含更多）与原来的等距完全一致", () => {
    for (const n of [VISIBLE_ORBIT_CAP, 20, 56]) {
      for (let i = 0; i < VISIBLE_ORBIT_CAP; i++) assert.ok(Math.abs(orbitRadiusOf(i, n) - (ORBIT_FIRST + ORBIT_STEP * i)) < 1e-9);
    }
  });
});
