import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkspacePlanets } from "../../../../shared/planet-design.ts";
import {
  agentInputsOf,
  agentPlanetsOf,
  bodyArt,
  createDesignStore,
  designFromPlanets,
  normalizeDesign,
  planetsWriteOf,
  commitPlanet,
  addPlanet,
  seededDesign,
  selectPlanet,
  writableDesign,
  eyeStyleOf,
  EYE_SIZES,
} from "./design.ts";
import { isPlanetWriteRequest } from "../../../../shared/planet-design.ts";

/** 意图系统的样子：主星烛霓 60 M⊕ + 三颗子智能体（地表都是插件出的无脸图） */
const INTENT: WorkspacePlanets = {
  main: { id: "main", name: "烛霓", massEarth: 60, composition: null, note: "故事", surface: "data:image/png;base64,AAA", flip: true, orbit: null, elements: null, eyeStyle: null, mix: null },
  planets: [
    { id: "rec", name: "聆箴", massEarth: 2.2, composition: "rock", note: "会议", surface: "data:image/png;base64,BBB", flip: false, orbit: 19, elements: null, eyeStyle: "xl-white", mix: null },
    { id: "eval", name: "衡璨", massEarth: 3, composition: "rock", note: null, surface: null, flip: false, orbit: 31, elements: { ring: true }, eyeStyle: "s", mix: null },
    { id: "mem", name: "银珀", massEarth: 1.6, composition: null, note: null, surface: null, flip: false, orbit: null, elements: null, eyeStyle: null, mix: null },
  ],
  warnings: [],
};

describe("工作区 planet/ → 设计稿", () => {
  const fallback = seededDesign("ws-intent");
  const design = designFromPlanets(INTENT, fallback);

  test("主星：名字、质量（M⊕ × 10）、地表图与翻转、故事；只开眼睛，不随机加星环 / 日冕", () => {
    assert.equal(design.star?.name, "烛霓");
    assert.equal(design.star?.mass, 600);
    assert.deepEqual(design.star?.surface, { src: "data:image/png;base64,AAA", flip: true });
    assert.equal(design.star?.note, "故事");
    assert.deepEqual(design.star?.elements, { eyes: true, ring: false, clouds: false, moons: false, corona: false });
    assert.equal(design.editing, "star");
  });

  test("行星：每颗子智能体一颗，质量 × 10、轨道照盘上（没给的按次序补），成分缺省岩质", () => {
    assert.deepEqual(
      design.planets?.map((p) => [p.id, p.name, p.mass, p.composition, p.orbitRadius]),
      [
        ["rec", "聆箴", 22, "rock", 19],
        ["eval", "衡璨", 30, "rock", 31],
        ["mem", "银珀", 16, "rock", 43],
      ],
    );
    assert.equal(design.planets?.[1]?.elements.ring, true);
    assert.equal(design.planet, design.planets?.[0]);
  });

  test("地表图进 bodyArt.image，成分纹理（坑、极冠、带）不再画；眼睛照旧代码画", () => {
    const star = bodyArt(design, "star", 40);
    assert.deepEqual(star.image, { src: "data:image/png;base64,AAA", flip: true });
    assert.deepEqual(star.bands, []);
    assert.notEqual(star.eyes, null);
    const planet = bodyArt(design, "planet", 20);
    assert.deepEqual(planet.craters, []);
    // 没有地表图的行星照旧画纹理
    const plain = bodyArt(selectPlanet(design, 1), "planet", 20);
    assert.equal(plain.image, null);
    assert.ok(plain.craters.length > 0);
  });

  test("盘上只有行星没有主星：主星取种子稿的（行星依赖主星）；什么都没有回退种子稿", () => {
    const onlyPlanets = designFromPlanets({ ...INTENT, main: null }, fallback);
    assert.equal(onlyPlanets.star?.mass, fallback.star?.mass);
    assert.equal(onlyPlanets.planets?.length, 3);
    assert.equal(designFromPlanets({ main: null, planets: [], warnings: [] }, fallback), fallback);
  });
});

describe("眼睛样式（面板 DIY）", () => {
  const design = designFromPlanets(INTENT, seededDesign("ws-intent"));

  test("盘上设过的照盘上，没设过的不编一个（缺席），画的时候取默认「大」", () => {
    assert.equal(design.star?.eyeStyle, undefined);
    assert.deepEqual(design.planets?.map((p) => p.eyeStyle), ["xl-white", "s", undefined]);
    assert.equal(eyeStyleOf(design.star), "l");
    assert.equal(bodyArt(design, "star", 40).eyeStyle, "l");
    assert.equal(bodyArt(selectPlanet(design, 1), "planet", 40).eyeStyle, "s");
  });

  test("没设过的默认是「大」：眼宽 = 大档几何，比小档大", () => {
    const fresh = seededDesign("ws-new");
    const art = bodyArt(fresh, "star", 40);
    assert.equal(art.eyeStyle, "l");
    assert.ok(Math.abs((art.eyes?.[0].w ?? 0) - EYE_SIZES.l.w * 40) < 1e-9);
    const small = bodyArt({ ...fresh, star: { ...fresh.star, eyeStyle: "s" } }, "star", 40);
    assert.ok((small.eyes?.[0].w ?? 0) < (art.eyes?.[0].w ?? 0));
  });

  test("白眼用特大的几何", () => {
    const fresh = seededDesign("ws-new");
    const white = bodyArt({ ...fresh, star: { ...fresh.star, eyeStyle: "xl-white" } }, "star", 40);
    const xl = bodyArt({ ...fresh, star: { ...fresh.star, eyeStyle: "xl" } }, "star", 40);
    assert.deepEqual(white.eyes, xl.eyes);
    assert.equal(white.eyeStyle, "xl-white");
  });

  test("写回：设过的带上，没设过的不写（盘上原值不动）", () => {
    const edited = { ...design, star: { ...(design.star as NonNullable<typeof design.star>), eyeStyle: "m" as const } };
    const request = planetsWriteOf("ws-intent", edited);
    assert.equal(request.main?.eyeStyle, "m");
    assert.deepEqual(request.planets.map((p) => p.eyeStyle), ["xl-white", "s", undefined]);
    assert.equal(isPlanetWriteRequest(request), true);
  });
});

describe("面板编辑多颗子智能体", () => {
  const design = designFromPlanets(INTENT, seededDesign("ws-intent"));

  test("切到第 2 颗再改质量：名单里那一颗跟着变，别的不动", () => {
    const picked = selectPlanet(design, 1);
    assert.equal(picked.planet?.name, "衡璨");
    assert.equal(picked.editing, "planet");
    const changed = normalizeDesign({ ...picked, planet: { ...(picked.planet as NonNullable<typeof picked.planet>), mass: 35 } });
    assert.deepEqual(changed.planets?.map((p) => p.mass), [22, 35, 16]);
  });

  test("越界的下标夹回来", () => {
    assert.equal(selectPlanet(design, 9).planet?.name, "银珀");
    assert.equal(selectPlanet(design, -3).planet?.name, "聆箴");
  });

  test("删了主星：行星名单一起清掉（不变量）", () => {
    const next = normalizeDesign({ ...design, star: null });
    assert.equal(next.planet, null);
    assert.deepEqual(next.planets, []);
  });
});

describe("写回请求", () => {
  const design = designFromPlanets(INTENT, seededDesign("ws-intent"));

  test("质量换回 M⊕，行星带 id / 成分 / 轨道", () => {
    const request = planetsWriteOf("ws-intent", { ...design, star: { ...(design.star as NonNullable<typeof design.star>), mass: 720 } });
    assert.equal(request.main?.massEarth, 72);
    assert.equal(request.main?.name, "烛霓");
    assert.deepEqual(
      request.planets.map((p) => [p.id, p.massEarth, p.composition, p.orbit]),
      [
        ["rec", 2.2, "rock", 19],
        ["eval", 3, "rock", 31],
        ["mem", 1.6, "rock", 43],
      ],
    );
  });

  test("没有 id 的新行星按次序起名（用户点了添加 / 改了它才进名单）；质量清空（NaN）时不写", () => {
    const seeded = seededDesign("ws-x");
    assert.equal(planetsWriteOf("ws-x", commitPlanet(seeded)).planets[0]?.id, "planet-1");
    assert.equal(writableDesign({ ...seeded, star: { ...seeded.star, mass: Number.NaN } }), false);
    assert.equal(writableDesign(seeded), true);
  });
});

describe("只改主星不落盘行星（2026-11-24 Windows 验收：主星质量 40 → 71 后多出一颗「未命名行星」）", () => {
  test("没有子智能体的种子稿：只改主星 → 写盘的 planets 为空；页面星系也不画行星", () => {
    const seeded = seededDesign("ws-z");
    assert.ok(seeded.planet !== null, "面板里有一颗示例草稿");
    const edited = { ...seeded, star: { ...seeded.star, mass: 710 } };
    const request = planetsWriteOf("ws-z", edited);
    assert.equal(request.main?.massEarth, 71);
    assert.deepEqual(request.planets, []);
    assert.deepEqual(agentPlanetsOf(edited), []);
  });

  test("有子智能体时只改主星 → planets 原样（id、质量、成分、轨道、顺序都不变）", () => {
    const fromFile = designFromPlanets(INTENT, seededDesign("ws-intent"));
    const before = planetsWriteOf("ws-intent", fromFile).planets;
    const after = planetsWriteOf("ws-intent", { ...fromFile, star: { ...(fromFile.star as NonNullable<typeof fromFile.star>), mass: 710 } }).planets;
    assert.deepEqual(after, before);
    assert.deepEqual(after.map((p) => p.id), ["rec", "eval", "mem"]);
  });

  test("点了「添加行星」或改了那颗草稿才进名单、才写盘", () => {
    const seeded = seededDesign("ws-w");
    const added = addPlanet({ ...seeded, planet: null }, "ws-w");
    assert.ok(added.ok);
    if (added.ok) assert.equal(planetsWriteOf("ws-w", added.design).planets.length, 1);
    assert.equal(agentPlanetsOf(commitPlanet(seeded)).length, 1);
    assert.equal(commitPlanet(commitPlanet(seeded)).planets?.length, 1, "重复提交不加第二颗");
  });
});

describe("页面星系画哪些子智能体", () => {
  const seeded = seededDesign("ws-y");
  test("种子稿 / 默认稿不画行星（那颗只是面板示例）；进了名单的画它；盘上读来的画名单", () => {
    assert.deepEqual(agentPlanetsOf(seeded), []);
    assert.equal(agentPlanetsOf(commitPlanet(seeded)).length, 1);
    const fromFile = designFromPlanets(INTENT, seeded);
    assert.equal(agentPlanetsOf(fromFile).length, 3);
    assert.deepEqual(agentInputsOf(fromFile.planets ?? []).map((a) => a.id), ["rec", "eval", "mem"]);
  });
});

describe("设计稿仓库：盘上的稿与面板改的稿", () => {
  test("读来的稿不算改过；面板一改就是 edited；reset 回到盘上的稿而不是种子稿", () => {
    const store = createDesignStore("default", { seeded: true });
    assert.equal(store.origin("w"), "default");
    const fromFile = designFromPlanets(INTENT, store.fallback("w"));
    store.load("w", fromFile);
    assert.equal(store.origin("w"), "file");
    assert.equal(store.get("w").star?.name, "烛霓");
    store.set("w", { ...fromFile, star: { ...(fromFile.star as NonNullable<typeof fromFile.star>), mass: 700 } });
    assert.equal(store.origin("w"), "edited");
    assert.equal(store.reset("w").star?.mass, 600);
    store.load("w", null);
    assert.equal(store.origin("w"), "default");
  });
});

describe("子智能体档案进设计稿（面板「职能」一节读它）", () => {
  test("有档案的行星带上 profile；没有的是 null；写回请求不带档案（档案另走 subagent:* IPC）", () => {
    const profile = { id: "eval", name: "衡璨", role: "你负责没有标准答案的评测。", createdAt: 1, updatedAt: 1, source: "chat" as const };
    const data: WorkspacePlanets = { ...INTENT, planets: INTENT.planets.map((planet) => (planet.id === "eval" ? { ...planet, profile } : planet)) };
    const design = designFromPlanets(data, seededDesign("ws-intent"));
    assert.equal(design.planets?.[1]?.profile?.role, "你负责没有标准答案的评测。");
    assert.equal(design.planets?.[0]?.profile, null);
    const request = planetsWriteOf("ws-intent", design);
    assert.equal(isPlanetWriteRequest(request), true);
    assert.equal(JSON.stringify(request).includes("没有标准答案"), false);
  });
});

describe("写回请求里的元素构成", () => {
  const body = { id: "rec", name: "聆箴", massEarth: 2, composition: "rock", orbit: 19, elements: { eyes: true } };
  const req = (mix: unknown) => ({ workspaceId: "ws", main: null, planets: [{ ...body, mix }] });
  test("合法的构成放行；留空（null）与 0 都合法", () => {
    assert.ok(isPlanetWriteRequest(req({ seed: 1, items: [{ id: "Fe", kind: "element", scope: "bulk", basis: "mass_fraction", share: 0, origin: "user" }, { id: "O", kind: "element", scope: "bulk", basis: "mass_fraction", share: null, origin: "default" }] })));
  });
  test("越界的比例、不认识的层、坏符号、坏种子一律拒绝（不静默丢条目）", () => {
    const item = { id: "Fe", kind: "element", scope: "bulk", basis: "mass_fraction", share: 0.3, origin: "user" };
    assert.ok(!isPlanetWriteRequest(req({ seed: 1, items: [{ ...item, share: 1.2 }] })));
    assert.ok(!isPlanetWriteRequest(req({ seed: 1, items: [{ ...item, scope: "core" }] })));
    assert.ok(!isPlanetWriteRequest(req({ seed: 1, items: [{ ...item, id: "fe" }] })));
    assert.ok(!isPlanetWriteRequest(req({ seed: -1, items: [item] })));
    assert.ok(!isPlanetWriteRequest(req({ seed: 1, items: [item, item] })), "重复条目");
  });
});
