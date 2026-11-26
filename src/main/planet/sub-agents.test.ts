import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanetStore } from "./store.ts";
import { DELETED_DIR, SubAgentStore } from "./sub-agents.ts";
import { applySubAgentRequest, type SubAgentRequestDeps } from "./sub-agent-requests.ts";
import { DEFAULT_SETTINGS } from "../../shared/settings.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { SubAgentsChanged } from "../../shared/sub-agent.ts";
import { MASS_UNIT_PER_EARTH, orbitClearance, seededStarMass, STAR_MASS } from "../../shared/galaxy-scale.ts";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orbita-subagents-"));
}

const fakeSurface = async (path: string): Promise<string | null> => (/\.(png|jpg|webp)$/.test(path) ? `data:${path.split("/").pop()}` : null);

function counter(): () => string {
  let n = 0;
  return () => `agent-${++n}`;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

/** 一座有主星（600 M⊕）和一颗老行星（聆箴，没有档案）的星系：新规则下还放得下一颗圆轨道行星 */
async function seeded(): Promise<string> {
  const dir = await workspace();
  await mkdir(join(dir, "planet"), { recursive: true });
  await writeFile(join(dir, "planet", "design.json"), JSON.stringify({ name: "烛霓", mass: { value: 600, unit: "M⊕" } }));
  await writeFile(join(dir, "planet", "galaxy.json"), JSON.stringify({ version: 1, main: {}, planets: [{ id: "rec", name: "聆箴", massEarth: 2.2, orbit: 19 }] }));
  return dir;
}

describe("SubAgentStore：建", () => {
  it("建出 agent.json + 名单里一颗行星（默认空轨道、只开眼睛），PlanetStore 读回带档案", async () => {
    const dir = await seeded();
    const store = new SubAgentStore({ now: () => 1000, newId: counter() });
    const created = await store.create(dir, { name: "衡璨", role: "你负责没有标准答案的评测。" }, "chat");
    assert.deepEqual(created, { ok: true, value: { id: "agent-1", name: "衡璨" } });
    const profile = await readJsonFile(join(dir, "planet", "agents", "agent-1", "agent.json"));
    assert.equal(profile["name"], "衡璨");
    assert.equal(profile["role"], "你负责没有标准答案的评测。");
    assert.equal(profile["source"], "chat");
    assert.equal(profile["createdAt"], 1000);
    assert.equal(profile["version"], 1);
    const galaxy = await readJsonFile(join(dir, "planet", "galaxy.json"));
    const planets = galaxy["planets"] as Record<string, unknown>[];
    assert.equal(planets.length, 2);
    assert.equal(planets[1]?.["id"], "agent-1");
    // 老轨道 e=0.3、远日距 24.7；新圆轨道在 38 首次满足 2√3 个相互希尔半径
    assert.equal(planets[1]?.["orbit"], 38);
    assert.equal(planets[1]?.["eccentricity"], 0);
    assert.equal(planets[1]?.["massEarth"], 2);
    assert.deepEqual(planets[1]?.["elements"], { eyes: true });
    assert.equal(planets[1]?.["surface"], undefined);
    const read = await new PlanetStore(fakeSurface).read(dir);
    assert.equal(read?.planets[1]?.profile?.role, "你负责没有标准答案的评测。");
    assert.equal(read?.planets[1]?.surface, null);
    // 老行星没有档案：profile 为 null，名字照旧
    assert.equal(read?.planets[0]?.profile, null);
    assert.equal(read?.planets[0]?.name, "聆箴");
    await rm(dir, { recursive: true });
  });

  it("带地表图：拷进 planet/agents/<id>/，伴随文件记相对路径", async () => {
    const dir = await seeded();
    const image = join(dir, "qwen.png");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const store = new SubAgentStore({ newId: counter() });
    const created = await store.create(dir, { name: "银珀", role: "记忆系统调研。", surfacePath: image }, "chat");
    assert.equal(created.ok, true);
    assert.equal((await stat(join(dir, "planet", "agents", "agent-1", "surface.png"))).isFile(), true);
    const read = await new PlanetStore(fakeSurface).read(dir);
    assert.equal(read?.planets[1]?.surface, "data:surface.png");
    await rm(dir, { recursive: true });
  });

  it("校验：同名（含主星、不分大小写）、职能空、名字太长、质量越过主星、地表读不到、名单满", async () => {
    const dir = await seeded();
    const store = new SubAgentStore({ newId: counter() });
    const fail = async (raw: unknown, needle: string): Promise<void> => {
      const result = await store.create(dir, raw, "chat");
      assert.equal(result.ok, false, JSON.stringify(raw));
      if (!result.ok) assert.match(result.error, new RegExp(needle));
    };
    await fail({ name: "聆箴", role: "x" }, "已经有一个叫「聆箴」");
    await fail({ name: "烛霓", role: "x" }, "主星");
    await fail({ name: "新的", role: "   " }, "role");
    await fail({ name: "一".repeat(25), role: "x" }, "最多 24");
    // 主星 600 M⊕ → 上限 4（夹在绝对上限）；给 5 越界
    await fail({ name: "新的", role: "x", massEarth: 5 }, "越过了上限 4");
    await fail({ name: "新的", role: "x", surfacePath: join(dir, "nope.png") }, "读不到");
    await fail({ name: "新的", role: "x", surfacePath: "relative.png" }, "绝对路径");
    // 前面的校验失败都没有写进去
    const before = await readJsonFile(join(dir, "planet", "galaxy.json"));
    assert.equal((before["planets"] as unknown[]).length, 1);
    // 名单上限与轨道容量是两件事：直接备一份 8 颗名单，checkCreate 应先报名额满
    await writeFile(join(dir, "planet", "galaxy.json"), JSON.stringify({ version: 1, main: {}, planets: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, massEarth: 0.1, orbit: 19 + i })) }));
    await fail({ name: "第九颗", role: "x" }, "最多 8");
    await rm(dir, { recursive: true });
  });

  it("小主星：上限跟着主星走（主星 20 M⊕ → 行星最多 2）", async () => {
    const dir = await seeded();
    await writeFile(join(dir, "planet", "design.json"), JSON.stringify({ name: "红矮星", mass: { value: 20, unit: "M⊕" } }));
    await writeFile(join(dir, "planet", "galaxy.json"), JSON.stringify({ version: 1, main: {}, planets: [] }));
    const store = new SubAgentStore({ newId: counter() });
    const over = await store.create(dir, { name: "大个子", role: "x", massEarth: 2.5 }, "chat");
    assert.equal(over.ok, false);
    assert.equal((await store.create(dir, { name: "大个子", role: "x", massEarth: 2 }, "chat")).ok, true);
    await rm(dir, { recursive: true });
  });

  it("轨道容量：小主星带着老行星时排不下第二颗，提示加主星质量或调远，且不先写档案", async () => {
    const dir = await seeded();
    await writeFile(join(dir, "planet", "design.json"), JSON.stringify({ name: "红矮星", mass: { value: 20, unit: "M⊕" } }));
    const result = await new SubAgentStore({ newId: counter() }).create(dir, { name: "挤不下", role: "x", massEarth: 2 }, "chat");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /增加主星质量|调远/);
    const galaxy = await readJsonFile(join(dir, "planet", "galaxy.json"));
    assert.equal((galaxy["planets"] as unknown[]).length, 1);
    await rm(dir, { recursive: true });
  });

  it("空工作区连建两颗：第二颗不落进主星——主星多大，按界面给这个工作区播种的那颗算", async () => {
    // 界面给没设计过的工作区画的主星按工作区 id 播种（STAR_MASS.min–max 整百一档）：各找一个落在最重、最轻那档的工作区
    const idSeededTo = (mass: number): string => {
      for (let i = 0; ; i += 1) if (seededStarMass(`ws-${i}`) === mass) return `ws-${i}`;
    };
    const newPlanetClear = (workspaceId: string, a: unknown): boolean =>
      typeof a === "number" &&
      orbitClearance({ star: { mass: seededStarMass(workspaceId) }, planet: { mass: 20, composition: "rock", a, e: 0 } }).ok;
    const store = new SubAgentStore({ newId: counter() });

    // 主星最重（100 M⊕）：两颗都排得下，第二颗在第一颗外侧、主星之外
    const heavy = idSeededTo(STAR_MASS.max);
    const heavyDir = await workspace();
    assert.equal((await store.create(heavyDir, { name: "第一颗", role: "x" }, "panel", heavy)).ok, true);
    const second = await store.create(heavyDir, { name: "第二颗", role: "x" }, "panel", heavy);
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    const heavyPlanets = (await readJsonFile(join(heavyDir, "planet", "galaxy.json")))["planets"] as Record<string, unknown>[];
    assert.equal(heavyPlanets.length, 2);
    assert.equal(heavyPlanets[0]?.["orbit"], 19);
    assert.ok(newPlanetClear(heavy, heavyPlanets[1]?.["orbit"]), `第二颗落在 ${String(heavyPlanets[1]?.["orbit"])}，主星 ${STAR_MASS.max / MASS_UNIT_PER_EARTH} M⊕`);
    assert.ok((heavyPlanets[1]?.["orbit"] as number) > 19);
    await rm(heavyDir, { recursive: true });

    // 主星最轻（30 M⊕）：以前第二颗被排到 4.5，整个落在主星里；现在要么落在主星之外，要么如实说排不下
    const light = idSeededTo(STAR_MASS.min);
    const lightDir = await workspace();
    assert.equal((await store.create(lightDir, { name: "第一颗", role: "x" }, "panel", light)).ok, true);
    const lightSecond = await store.create(lightDir, { name: "第二颗", role: "x" }, "panel", light);
    const lightPlanets = (await readJsonFile(join(lightDir, "planet", "galaxy.json")))["planets"] as Record<string, unknown>[];
    if (lightSecond.ok) {
      assert.equal(lightPlanets.length, 2);
      assert.ok(newPlanetClear(light, lightPlanets[1]?.["orbit"]), `第二颗落在 ${String(lightPlanets[1]?.["orbit"])}，主星 ${STAR_MASS.min / MASS_UNIT_PER_EARTH} M⊕`);
    } else {
      assert.match(lightSecond.error, /排不下/);
      assert.equal(lightPlanets.length, 1);
    }
    await rm(lightDir, { recursive: true });
  });

  it("空工作区（planet/ 还没有）也能建：伴随文件新建出来", async () => {
    const dir = await workspace();
    const store = new SubAgentStore({ newId: counter() });
    assert.equal((await store.create(dir, { name: "第一颗", role: "x" }, "panel")).ok, true);
    const galaxy = await readJsonFile(join(dir, "planet", "galaxy.json"));
    assert.equal((galaxy["planets"] as Record<string, unknown>[])[0]?.["orbit"], 19);
    await rm(dir, { recursive: true });
  });
});

describe("SubAgentStore：改、删、坏文件降级", () => {
  it("改职能与模型；改名两边一起改；给老行星补档案要带职能", async () => {
    const dir = await seeded();
    const store = new SubAgentStore({ now: () => 2000, newId: counter() });
    await store.create(dir, { name: "衡璨", role: "旧职能", modelId: "glm-5.3" }, "chat");
    assert.equal((await store.update(dir, { id: "agent-1", role: "新职能", modelId: null }, "panel")).ok, true);
    let profile = await store.profile(dir, "agent-1");
    assert.equal(profile?.role, "新职能");
    assert.equal(profile?.modelId, undefined);
    assert.equal(profile?.source, "chat");
    assert.equal((await store.update(dir, { id: "agent-1", name: "聆箴" }, "panel")).ok, false);
    assert.equal((await store.update(dir, { id: "agent-1", name: "衡璨二号" }, "panel")).ok, true);
    profile = await store.profile(dir, "agent-1");
    assert.equal(profile?.name, "衡璨二号");
    const galaxy = await readJsonFile(join(dir, "planet", "galaxy.json"));
    assert.equal((galaxy["planets"] as Record<string, unknown>[])[1]?.["name"], "衡璨二号");
    // 老行星（没档案）：只改名不给职能 → 拒；带职能 → 补一份
    assert.equal((await store.update(dir, { id: "rec", name: "聆箴新" }, "panel")).ok, false);
    assert.equal((await store.update(dir, { id: "rec", role: "会议录音与要点" }, "panel")).ok, true);
    assert.equal((await store.profile(dir, "rec"))?.name, "聆箴");
    assert.equal((await store.update(dir, { id: "nope", role: "x" }, "panel")).ok, false);
    await rm(dir, { recursive: true });
  });

  it("删：名单拿掉，目录挪进 .deleted（可恢复）；面板随后的整份写回不会把它写回来，也不会抹掉聊天里新建的", async () => {
    const dir = await seeded();
    const store = new SubAgentStore({ now: () => 3000, newId: counter() });
    await store.create(dir, { name: "衡璨", role: "x" }, "chat");
    assert.equal((await store.delete(dir, "agent-1")).ok, true);
    const galaxy = await readJsonFile(join(dir, "planet", "galaxy.json"));
    assert.deepEqual((galaxy["planets"] as Record<string, unknown>[]).map((p) => p["id"]), ["rec"]);
    const trash = await readdir(join(dir, "planet", "agents", DELETED_DIR));
    assert.deepEqual(trash, ["agent-1-3000"]);
    assert.equal((await store.delete(dir, "agent-1")).ok, false);
    // 聊天里又建了一颗；面板手里那份旧名单只有 rec，去抖写回时不该把新的抹掉
    await store.create(dir, { name: "银珀", role: "y" }, "chat");
    await new PlanetStore(fakeSurface).write(dir, {
      main: null,
      planets: [{ id: "rec", name: "聆箴", massEarth: 2.2, composition: "rock", orbit: 25, elements: { eyes: true } }],
    });
    const after = await readJsonFile(join(dir, "planet", "galaxy.json"));
    assert.deepEqual((after["planets"] as Record<string, unknown>[]).map((p) => p["id"]), ["rec", "agent-2"]);
    assert.equal((after["planets"] as Record<string, unknown>[])[0]?.["orbit"], 25);
    await rm(dir, { recursive: true });
  });

  it("面板改名（planet:write）时档案跟着改名", async () => {
    const dir = await seeded();
    const store = new SubAgentStore({ newId: counter() });
    await store.create(dir, { name: "衡璨", role: "x" }, "chat");
    await new PlanetStore(fakeSurface).write(dir, {
      main: null,
      planets: [{ id: "agent-1", name: "衡璨改", massEarth: 2, composition: "rock", orbit: 31, elements: { eyes: true } }],
    });
    assert.equal((await store.profile(dir, "agent-1"))?.name, "衡璨改");
    await rm(dir, { recursive: true });
  });

  it("坏 agent.json / id 对不上 / 缺职能 → 当作没有档案；星系照读，warnings 记一条", async () => {
    const dir = await seeded();
    await mkdir(join(dir, "planet", "agents", "rec"), { recursive: true });
    await writeFile(join(dir, "planet", "agents", "rec", "agent.json"), "{ 半截");
    const read = await new PlanetStore(fakeSurface).read(dir);
    assert.equal(read?.planets[0]?.name, "聆箴");
    assert.equal(read?.planets[0]?.profile, null);
    assert.equal(read?.warnings.some((line) => line.includes("agent.json")), true);
    await writeFile(join(dir, "planet", "agents", "rec", "agent.json"), JSON.stringify({ id: "other", name: "x", role: "y" }));
    assert.equal(await new SubAgentStore().profile(dir, "rec"), null);
    await writeFile(join(dir, "planet", "agents", "rec", "agent.json"), JSON.stringify({ id: "rec", name: "x", role: "" }));
    assert.equal(await new SubAgentStore().profile(dir, "rec"), null);
    // 名单坏了：建照样能建（当空名单）
    await writeFile(join(dir, "planet", "galaxy.json"), "not json");
    assert.equal((await new SubAgentStore({ newId: counter() }).create(dir, { name: "新", role: "x" }, "chat")).ok, true);
    await rm(dir, { recursive: true });
  });
});

describe("applySubAgentRequest：主进程再核一遍形态与身份", () => {
  const meta = (patch: Partial<SessionMeta>): SessionMeta => ({
    id: "s1",
    title: "",
    titleSource: "derived",
    cwd: "/x",
    workspaceId: "w1",
    providerId: "p",
    modelId: "m",
    mode: "skip",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  });

  async function setup(patch: Partial<SessionMeta>, appMode: "agent" | "orchestrate" = "orchestrate"): Promise<{ deps: SubAgentRequestDeps; events: SubAgentsChanged[]; dir: string }> {
    const dir = await seeded();
    const events: SubAgentsChanged[] = [];
    return {
      dir,
      events,
      deps: {
        sessions: { readMeta: async () => meta(patch) },
        workspaces: { list: async () => [{ id: "w1", name: "意图系统", path: dir, attachedDirs: [], createdAt: 0, updatedAt: 0 } as never] },
        settings: { read: async () => ({ ...DEFAULT_SETTINGS, appMode }) },
        store: new SubAgentStore({ newId: counter() }),
        broadcast: (event) => events.push(event),
      },
    };
  }

  it("编排形态的根会话：建成、广播 created（带 sessionId，renderer 据此弹面板）；list 列出来", async () => {
    const { deps, events, dir } = await setup({});
    const created = await applySubAgentRequest(deps, { type: "subAgentRequest", requestId: "r", sessionId: "s1", request: { action: "create", input: { name: "衡璨", role: "评测" } } });
    assert.equal(created.ok, true);
    if (created.ok) assert.match(created.text, /Galaxy Design panel/);
    assert.deepEqual(events, [{ workspaceId: "w1", subAgentId: "agent-1", action: "created", source: "chat", sessionId: "s1" }]);
    const listed = await applySubAgentRequest(deps, { type: "subAgentRequest", requestId: "r", sessionId: "s1", request: { action: "list" } });
    assert.equal(listed.ok && listed.agents?.length, 2);
    if (listed.ok) assert.match(listed.text, /agent-1 · "衡璨"/);
    await rm(dir, { recursive: true });
  });

  it("单智能体形态 / 子会话 / 星际空间：拒", async () => {
    for (const [patch, mode, needle] of [
      [{}, "agent", "编排形态"],
      [{ parentId: "p" }, "orchestrate", "子会话"],
      [{ workspaceId: null }, "orchestrate", "星际空间"],
    ] as const) {
      const { deps, events, dir } = await setup(patch, mode);
      const outcome = await applySubAgentRequest(deps, { type: "subAgentRequest", requestId: "r", sessionId: "s1", request: { action: "create", input: { name: "衡璨", role: "评测" } } });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error, new RegExp(needle));
      assert.deepEqual(events, []);
      await rm(dir, { recursive: true });
    }
  });
});
