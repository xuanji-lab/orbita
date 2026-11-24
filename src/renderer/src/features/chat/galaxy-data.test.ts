import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GALAXY_TILT } from "../../../../shared/settings.ts";

const TILT: number = GALAXY_TILT.default;
import type { SessionMeta } from "@shared/session";
import { runStateOf, type RunStateSource, type SessionRunState } from "../notify/completion-notice.ts";
import { AGENT_READABLE_MAX, BELT_OVERSHOOT, FRAME_EXTENT, GALAXY_MAX_FILL, PLANET_MASS, PLANET_ZONE, STAR_MASS, VISIBLE_ORBIT_CAP, galaxyBox, layoutGalaxy, planetRadius, starRadius } from "./galaxy.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { orchestraTree } from "./orchestra-data.ts";
import { defaultDesign, type GalaxyDesign } from "../galaxy-designer/design.ts";
import { IDLE_CHILD_MS, ORBIT_FIRST, ORBIT_SPREAD_MAX, ORBIT_STEP, RECENT_MENU_LIMIT, latestWorkspaceId, orbitRadiusOf, ROCK_CAP, planetMassOf, homeGalaxyOf, scopeGalaxy, scopeRecent, scopeSummary, scopeTone, stateIndexOf, stateOfIndex } from "./galaxy-data.ts";

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
    assert.deepEqual(galaxy.spec, { starMass: 620, planets: [], sessions: 0, dust: [] });
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
    assert.ok(layout.extent <= FRAME_EXTENT * BELT_OVERSHOOT, `外缘 ${layout.extent}`);
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
  test("按件数：根会话自己 + 子会话各算一件；等你压过在跑；最近活动只看根会话；空工作区全零", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 10, title: "旧的" }),
      meta({ id: "b", updatedAt: 30, title: "最新的" }),
      meta({ id: "b-kid", updatedAt: 99, parentId: "b" }),
    ];
    const summary = scopeSummary(sessions, "ws", states({ a: "running", b: "waiting", "b-kid": "running" }));
    assert.deepEqual(summary, { waiting: 1, running: 2, failed: 0, total: 2, lastActive: 30, lastTitle: "最新的", waitingId: "b", attention: 1 });
    assert.equal(scopeTone(summary), "waiting");
    assert.equal(scopeTone({ waiting: 0, running: 2 }), "running");
    const empty = scopeSummary([], "ws", states({}));
    assert.deepEqual(empty, { waiting: 0, running: 0, failed: 0, total: 0, lastActive: null, lastTitle: null, waitingId: null, attention: 0 });
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

describe("scopeSummary.attention —— 小圆点只给没看过的", () => {
  const sessions = [meta({ id: "w", updatedAt: 3 }), meta({ id: "d", updatedAt: 2 }), meta({ id: "f", updatedAt: 1 }), meta({ id: "r", updatedAt: 4 }), meta({ id: "n", updatedAt: 5 })];
  const stateOf = states({ w: "waiting", d: "done", f: "failed", r: "running" });
  test("等你 + 跑完没看 + 出错没看都算；在跑与无状态不算", () => {
    assert.equal(scopeSummary(sessions, "ws", stateOf).attention, 3);
  });
  test("眼下正开着的那条不算（看过即退），但「等你」的件数不变", () => {
    const viewing = scopeSummary(sessions, "ws", stateOf, "w");
    assert.equal(viewing.attention, 2);
    assert.equal(viewing.waiting, 1);
    assert.equal(scopeSummary(sessions, "ws", stateOf, "nope").attention, 3);
  });
});

describe("scopeGalaxy 的行星带名字", () => {
  test("label = 会话标题（去首尾空白）；没有标题是空串（HomeGalaxy 不标）", () => {
    const galaxy = scopeGalaxy({
      sessions: [meta({ id: "a", updatedAt: 1, title: "  梳理周报  " }), meta({ id: "b", updatedAt: 2, title: "" })],
      workspaceId: "ws",
      now: 100_000,
      stateOf: states({ a: "running", b: "running" }),
      starMass: 620,
      designedPlanet: null,
    });
    assert.deepEqual(galaxy.spec.planets.map((planet) => planet.label), ["", "梳理周报"]);
  });
});

describe("编排星系：行星 = 子智能体，会话 = 碎石", () => {
  const ws = "ws";
  const at = 1_000_000_000;
  const mk = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => meta({ id, updatedAt: at, ...over });
  const agents = [
    { id: "rec", mass: 22, composition: "rock" as const, orbitRadius: 19 },
    { id: "eval", mass: 30, composition: "rock" as const, orbitRadius: 31 },
  ];
  test("行星只来自子智能体；在跑 / 等你的会话成碎石块（等你在前），其余会话只计数", () => {
    const sessions = [mk("a"), mk("b"), mk("c"), mk("k", { parentId: "a" })];
    const states: Record<string, "running" | "waiting" | null> = { a: "running", b: "waiting", c: null, k: "running" };
    const data = scopeGalaxy({ sessions, workspaceId: ws, stateOf: (m) => states[m.id] ?? null, now: at, starMass: 600, designedPlanet: null, agents });
    assert.deepEqual(data.spec.planets.map((p) => [p.id, p.mass, p.orbitRadius, p.state]), [["rec", 22, 19, null], ["eval", 30, 31, null]]);
    assert.deepEqual(data.spec.rocks?.map((r) => [r.id, r.state, r.child === true]), [["b", "waiting", false], ["a", "running", false], ["k", "running", true]]);
    // 会话数只数根会话（与右栏树主卡同源）；子会话碎石块 k 带 child 标记，不进这个数
    assert.equal(data.spec.sessions, 3);
  });
  test("在做事的会话再多，碎石块也只拎 ROCK_CAP 块，等你的一定在里面", () => {
    const sessions = Array.from({ length: 20 }, (_, i) => mk(`s${i}`, { updatedAt: at + i }));
    const data = scopeGalaxy({ sessions, workspaceId: ws, stateOf: (m) => (m.id === "s0" ? "waiting" : "running"), now: at, starMass: 600, designedPlanet: null, agents });
    assert.equal(data.spec.rocks?.length, ROCK_CAP);
    assert.equal(data.spec.rocks?.[0]?.id, "s0");
  });
});

describe("「等你」件数：页头 / 侧栏（scopeSummary）与星系碎石（scopeGalaxy）同一个数（2026-11-24 设计审查 R2）", () => {
  // 复现 ann-1：一条母会话自己空着，派出去的三个子会话里两个停下来等你、一个在跑；另一条根会话自己在等你
  const sessions = [
    meta({ id: "main", updatedAt: 10, title: "主线" }),
    meta({ id: "k1", updatedAt: 11, parentId: "main", title: "整理数据" }),
    meta({ id: "k2", updatedAt: 12, parentId: "main", title: "核对图标" }),
    meta({ id: "k3", updatedAt: 13, parentId: "main", title: "查内存" }),
    meta({ id: "ask", updatedAt: 20, title: "问一句" }),
    meta({ id: "idle", updatedAt: 5 }),
  ];
  // 真实的运行态来源：母会话的汇总态由子会话推出来（stateIndexOf），不是测试里写死
  const source: RunStateSource = {
    sessions,
    phaseOf: (id) => (id === "k3" ? "turn" : "idle"),
    approvalsOf: (id) => (id === "k1" || id === "k2" || id === "ask" ? [{ id: `${id}-approval` }] : []),
  };
  const index = stateIndexOf(source);
  const agents = [{ id: "p1", mass: 20, composition: "rock" as const, orbitRadius: 19 }];

  test("三处同一个数：等你 3 件（两个子会话 + 一条根会话），在跑 1 件", () => {
    const summary = scopeSummary(sessions, "ws", index);
    const galaxy = scopeGalaxy({ sessions, workspaceId: "ws", stateOf: index.state, ownStateOf: index.own, now: 100, starMass: 620, designedPlanet: null, agents });
    const rocks = galaxy.spec.rocks ?? [];
    assert.equal(summary.waiting, 3);
    assert.equal(summary.running, 1);
    assert.equal(rocks.filter((rock) => rock.state === "waiting").length, summary.waiting);
    assert.equal(rocks.filter((rock) => rock.state === "running").length, summary.running);
    // 胶囊直达最近一件等你的（可以是子会话）
    assert.equal(summary.waitingId, "ask");
  });

  test("只传一个函数（没有 own）时退成同一个口径，不重复数母会话", () => {
    const flat = scopeSummary(sessions, "ws", states({ k1: "waiting", k2: "waiting", ask: "waiting", k3: "running" }));
    assert.equal(flat.waiting, 3);
    assert.equal(flat.running, 1);
  });
});

describe("每条根会话都是一颗碎石，与右栏树主卡同源：碎石 + 拎成碎石块的根会话 = 总数（2026-11-24：星系随会话长大，不再折成「另有 N 条」）", () => {
  // 满载 orbita 的形状：40 条根会话，其中一条派出 14 个子会话（11 在跑、3 等你），另一条根会话自己在跑
  const sessions = [
    ...Array.from({ length: 40 }, (_, i) => meta({ id: `r${i}`, updatedAt: 100 + i })),
    ...Array.from({ length: 14 }, (_, i) => meta({ id: `k${i}`, updatedAt: 200 + i, parentId: "r0" })),
  ];
  const source: RunStateSource = {
    sessions,
    phaseOf: (id) => (id === "r1" || /^k([0-9]|10)$/.test(id) ? "turn" : "idle"),
    approvalsOf: (id) => (id === "k11" || id === "k12" || id === "k13" ? [{ id }] : []),
  };
  const index = stateIndexOf(source);
  const agents = [19, 31, 43].map((orbitRadius, i) => ({ id: `p${i}`, mass: 20 + i * 5, composition: "rock" as const, orbitRadius }));
  const galaxy = scopeGalaxy({ sessions, workspaceId: "ws", stateOf: index.state, ownStateOf: index.own, now: 1000, starMass: 620, designedPlanet: null, agents });
  const tree = orchestraTree({ sessions, workspaceId: "ws", stateOf: index.state, now: 1000 });

  test("星系的会话数就是树主卡的总数（只数根会话，子会话碎石块带 child 标记）", () => {
    assert.equal(galaxy.spec.sessions, tree.total);
    assert.equal(tree.total, 40);
    const rocks = galaxy.spec.rocks ?? [];
    assert.equal(rocks.length, ROCK_CAP);
    assert.ok(rocks.some((rock) => rock.child === true));
  });

  for (const [name, w, h] of [
    ["宽窗页面", 1088, 726],
    ["右栏星系图", 416, 333],
    ["窄窗页面 + 右栏（碎石块整圈出画）", 196, 214],
  ] as const) {
    test(`${name}（${w}×${h}）：碎石带颗粒 + 根会话碎石块 = 总数；子会话碎石块不在里面`, () => {
      const box = galaxyBox(w, h, GALAXY_MAX_FILL);
      const scene = fitScreenSafe({ ...galaxy.spec }, w, h, box, TILT, AGENT_READABLE_MAX);
      const layout = scene.layout;
      // 碎石先收（2026-11-24 用户：子智能体永远不藏，少画只能少画碎石与尘埃）：画布小到行星挤进碎石带那一圈时整条不画
      assert.equal(layout.planets.length, galaxy.spec.planets.length, "子智能体少画了");
      if (layout.belt === null) return;
      const dust = layout.belt.particles;
      const rootRocks = layout.rocks.filter((rock) => rock.child !== true);
      assert.equal(dust.length + rootRocks.length, tree.total);
      const ids = new Set(dust.map((p) => p.id));
      for (const rock of layout.rocks) assert.ok(!ids.has(rock.id), `${rock.id} 既是碎石块又是碎石`);
      for (const id of ids) assert.ok(/^r\d+$/.test(id), `${id} 不是根会话`);
    });
  }
});

describe("首页星系：作用域 → 星系（单智能体首页与编排页同一个入口）", () => {
  const sessions = [
    meta({ id: "a1", updatedAt: 9, workspaceId: "A" }),
    meta({ id: "a2", updatedAt: 8, workspaceId: "A" }),
    meta({ id: "b1", updatedAt: 7, workspaceId: "B" }),
    meta({ id: "n1", updatedAt: 6, workspaceId: null }),
    meta({ id: "n2", updatedAt: 5, workspaceId: null }),
    meta({ id: "n3", updatedAt: 4, workspaceId: null }),
  ];
  const designOf = (ws: string, ids: string[], mass: number): GalaxyDesign => {
    const base = defaultDesign(ws, "default");
    return { ...base, star: { ...base.star, mass }, planets: ids.map((id, i) => ({ ...base.planet, id, name: id, orbitRadius: 19 + 12 * i })) };
  };
  const at = (workspaceId: string | null, design: GalaxyDesign) =>
    homeGalaxyOf({ sessions, workspaceId, stateOf: states({}), now: 100_000, design });

  test("选了工作区 A：A 的主星质量、A 的子智能体行星、A 的会话碎石；切到 B 换成 B 的那一套", () => {
    const a = at("A", designOf("A", ["烛霓-1", "烛霓-2", "烛霓-3"], 600));
    assert.equal(a.starless, false);
    assert.equal(a.spec.starMass, 600);
    assert.deepEqual(a.spec.planets.map((p) => p.id), ["烛霓-1", "烛霓-2", "烛霓-3"]);
    assert.deepEqual([...a.agents.keys()], ["烛霓-1", "烛霓-2", "烛霓-3"]);
    assert.deepEqual((a.spec.dust ?? []).map((d) => d.id).sort(), ["a1", "a2"]);
    const b = at("B", designOf("B", ["琉璃"], 350));
    assert.equal(b.spec.starMass, 350);
    assert.deepEqual(b.spec.planets.map((p) => p.id), ["琉璃"]);
    assert.deepEqual((b.spec.dust ?? []).map((d) => d.id), ["b1"]);
  });

  test("没选工作区：星际空间——没有主星与行星，只有不属于任何工作区的会话碎石", () => {
    const n = at(null, designOf("", ["不该出现"], 600));
    assert.equal(n.starless, true);
    assert.deepEqual(n.spec.planets, []);
    assert.equal(n.agents.size, 0);
    assert.equal(n.spec.sessions, 3);
  });

  test("同一作用域在两个首页上画同一座星系：输入里没有「哪个首页」，两种画框下是同一串天体（行星同序、碎石同一批、同一偏心率与俯角）", () => {
    const g = at("A", designOf("A", ["烛霓-1", "烛霓-2", "烛霓-3"], 600));
    const spec = { ...g.spec, eccentricity: 0.3 };
    const single = fitScreenSafe(spec, 1000, 330, galaxyBox(1000, 330), TILT, AGENT_READABLE_MAX);
    const orch = fitScreenSafe(spec, 1000, 700, galaxyBox(1000, 700, GALAXY_MAX_FILL), TILT, AGENT_READABLE_MAX);
    // 画框大小不同，装得下的圈数可能不同（矮的那条带子少画外圈）：画出来的是同一串的前缀，其余计进 hidden
    const orchPlanets = orch.layout.planets.map((p) => [p.id, p.composition]);
    assert.deepEqual(single.layout.planets.map((p) => [p.id, p.composition]), orchPlanets.slice(0, single.layout.planets.length));
    assert.equal(single.layout.planets.length + single.layout.hidden, orch.layout.planets.length + orch.layout.hidden);
    // 碎石带：两边都画时是同一批（矮带子装不下时碎石先收）
    if (single.layout.belt !== null && orch.layout.belt !== null) assert.deepEqual(single.layout.belt.particles.map((p) => p.id), orch.layout.belt.particles.map((p) => p.id));
    assert.equal(single.layout.planets.length, 3, "单智能体首页那条带子里子智能体少画了");
    assert.equal(single.layout.ecc, orch.layout.ecc);
    assert.equal(single.elevationDeg, TILT);
    assert.equal(orch.elevationDeg, TILT);
  });
});

describe("智能体状态「出错」：最近一轮失败、现在没在跑（2026-11-24 Windows 验收：模型 401 之后页头仍写空闲）", () => {
  const sessions = [meta({ id: "a", updatedAt: 3 }), meta({ id: "b", updatedAt: 2 }), meta({ id: "c", updatedAt: 1 })];
  const source = (errors: Record<string, string | null>, phases: Record<string, "idle" | "turn"> = {}) => ({
    sessions,
    phaseOf: (id: string) => phases[id] ?? ("idle" as const),
    approvalsOf: () => [],
    turnErrorOf: (id: string) => errors[id] ?? null,
  });
  test("那一轮的错误还在、没在跑 → 计一件出错（不看未读：你正看着它也算）", () => {
    assert.equal(scopeSummary(sessions, "ws", stateIndexOf(source({ a: "401 Unauthorized" }))).failed, 1);
    assert.equal(scopeSummary(sessions, "ws", stateIndexOf(source({ a: "401 Unauthorized" })), "a").failed, 1);
  });
  test("又开始跑了就不算出错；没错误不算；失败未读（重启后）照旧算", () => {
    assert.equal(scopeSummary(sessions, "ws", stateIndexOf(source({ a: "401" }, { a: "turn" }))).failed, 0);
    assert.equal(scopeSummary(sessions, "ws", stateIndexOf(source({}))).failed, 0);
    const unread = [meta({ id: "x", updatedAt: 1, unread: { at: 1, failed: true } })];
    assert.equal(scopeSummary(unread, "ws", stateIndexOf({ sessions: unread, phaseOf: () => "idle" as const, approvalsOf: () => [] })).failed, 1);
  });
});
