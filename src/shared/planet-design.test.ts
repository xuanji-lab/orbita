import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compositionFromDensity,
  isPlanetWriteRequest,
  isSafeRelative,
  mergeCompanion,
  parseCompanion,
  patchPluginDesign,
  pluginDesignFields,
  PLANET_AGENTS_MAX,
} from "./planet-design.ts";

describe("伴随文件 planet/galaxy.json 的解析", () => {
  it("正常路径：主星与行星都读得出来", () => {
    const parsed = parseCompanion({
      version: 1,
      main: { surface: "surface.png", flip: true, elements: { eyes: true, ring: false, bogus: 1 } },
      planets: [{ id: "rec", design: "agents/rec/design.json", surface: "agents/rec/surface.png", composition: "rock", orbit: 19 }],
    });
    assert.deepEqual(parsed.main, { surface: "surface.png", flip: true, elements: { eyes: true, ring: false } });
    assert.equal(parsed.planets[0]?.design, "agents/rec/design.json");
    assert.equal(parsed.planets[0]?.orbit, 19);
  });

  it("坏路径、重复 id、坏 id 丢掉；超上限截掉", () => {
    const planets = [
      { id: "a", surface: "../../etc/passwd" },
      { id: "a", surface: "x.png" },
      { id: "b/../c" },
      { id: "d", design: "/abs/design.json" },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `p${i}` })),
    ];
    const parsed = parseCompanion({ planets });
    assert.equal(parsed.planets[0]?.id, "a");
    assert.equal(parsed.planets[0]?.surface, undefined);
    assert.equal(parsed.planets.some((p) => p.id === "b/../c"), false);
    assert.equal(parsed.planets.find((p) => p.id === "d")?.design, undefined);
    assert.equal(parsed.planets.length, PLANET_AGENTS_MAX);
  });

  it("每颗自己的 e / ω 读写得回来；旧稿缺字段保持 undefined，坏值丢掉", () => {
    const body = { id: "rec", name: "聆箴", massEarth: 2.2, composition: "rock" as const, orbit: 24, elements: { eyes: true } };
    const parsed = parseCompanion({ planets: [{ id: "rec", orbit: 19, eccentricity: 0.25, periapsisDeg: 135 }, { id: "bad", eccentricity: 0.9, periapsisDeg: -2 }] });
    assert.equal(parsed.planets[0]?.eccentricity, 0.25);
    assert.equal(parsed.planets[0]?.periapsisDeg, 135);
    assert.equal(parsed.planets[1]?.eccentricity, undefined);
    assert.equal(parsed.planets[1]?.periapsisDeg, undefined);
    const next = mergeCompanion(parsed, { main: null, planets: [{ ...body, eccentricity: 0.4, periapsisDeg: 280 }] }, { main: false, planets: new Set() });
    assert.equal(next.planets[0]?.eccentricity, 0.4);
    assert.equal(next.planets[0]?.periapsisDeg, 280);
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [{ ...body, eccentricity: 0.4, periapsisDeg: 280 }] }), true);
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [{ ...body, eccentricity: 0.7 }] }), false);
  });

  it("不是对象 → 空稿，不抛", () => {
    assert.deepEqual(parseCompanion(null).planets, []);
    assert.deepEqual(parseCompanion("x").main, null);
  });

  it("相对路径只能在 planet/ 里", () => {
    assert.equal(isSafeRelative("agents/rec/surface.png"), true);
    for (const bad of ["", "/x", "..", "a/../b", "C:/x", "a\\b", "a//b"]) assert.equal(isSafeRelative(bad), false, bad);
  });
});

describe("插件格式设计稿", () => {
  it("取名字、M⊕ 质量、密度；别的单位当没有", () => {
    assert.deepEqual(pluginDesignFields({ name: "烛霓", mass: { value: 60, unit: "M⊕" }, density: { value: 1326 }, story: "s" }), {
      name: "烛霓",
      massEarth: 60,
      density: 1326,
      story: "s",
    });
    assert.equal(pluginDesignFields({ mass: { value: 3, unit: "kg" } }).massEarth, undefined);
  });

  it("按密度粗分成分", () => {
    assert.equal(compositionFromDensity(1326), "gas");
    assert.equal(compositionFromDensity(2000), "ice");
    assert.equal(compositionFromDensity(5513), "rock");
    assert.equal(compositionFromDensity(undefined), null);
  });

  it("写回只改名字、质量与按密度重算的半径，其余字段原样", () => {
    const raw = { name: "烛霓", mass: { value: 60, unit: "M⊕", origin: "user" }, density: { value: 1326 }, match: { body: "jupiter" }, status: "已确认" };
    const out = patchPluginDesign(raw, { name: "烛霓", massEarth: 72 }, "星系设计面板");
    assert.equal((out["mass"] as { value: number }).value, 72);
    assert.equal((out["mass"] as { source: string }).source, "星系设计面板");
    assert.deepEqual(out["match"], { body: "jupiter" });
    assert.equal(out["status"], "已确认");
    // 72 M⊕、密度 1326 → 半径约 42.6 千公里
    const radius = (out["radius"] as { value: number }).value;
    assert.ok(radius > 42000 && radius < 43500, String(radius));
  });

  it("质量没变就不碰 mass / radius", () => {
    const raw = { mass: { value: 60, unit: "M⊕", origin: "inherited" }, density: { value: 1326 }, radius: { value: 1 } };
    const out = patchPluginDesign(raw, { name: "", massEarth: 60 }, "x");
    assert.deepEqual(out["mass"], raw.mass);
    assert.deepEqual(out["radius"], raw.radius);
  });
});

describe("写回伴随文件", () => {
  const body = { id: "rec", name: "聆箴", massEarth: 2.2, composition: "rock" as const, orbit: 24, elements: { eyes: true } };
  it("保留地表路径与翻转，覆盖元素与轨道；有插件稿的不记名字质量", () => {
    const current = parseCompanion({ main: { surface: "surface.png", flip: true }, planets: [{ id: "rec", surface: "agents/rec/surface.png", orbit: 19 }] });
    const next = mergeCompanion(
      current,
      { main: { ...body, id: "main", composition: null, orbit: null, massEarth: 60 }, planets: [body] },
      { main: true, planets: new Set(["rec"]) },
    );
    assert.equal(next.main?.surface, "surface.png");
    assert.equal(next.main?.flip, true);
    assert.equal(next.main?.massEarth, undefined);
    assert.equal(next.planets[0]?.surface, "agents/rec/surface.png");
    assert.equal(next.planets[0]?.orbit, 24);
  });

  it("没有插件稿的天体把名字与质量记在伴随文件；请求里没有的行星原样留着（删除另走 subagent:delete）", () => {
    const current = parseCompanion({ planets: [{ id: "kept", name: "聊天里刚建的", orbit: 31 }] });
    const next = mergeCompanion(current, { main: null, planets: [body] }, { main: false, planets: new Set() });
    assert.equal(next.planets.length, 2);
    // 盘上原有的留在原位，请求里新出现的接在后面
    assert.deepEqual(next.planets.map((planet) => planet.id), ["kept", "rec"]);
    assert.equal(next.planets[0]?.name, "聊天里刚建的");
    assert.equal(next.planets[0]?.orbit, 31);
    assert.equal(next.planets[1]?.name, "聆箴");
    assert.equal(next.planets[1]?.massEarth, 2.2);
  });

  it("眼睛样式：写进伴随文件、读得回来；请求里没带就保留盘上原值；坏值读时丢掉", () => {
    const current = parseCompanion({ main: { eyeStyle: "xl" }, planets: [{ id: "rec", eyeStyle: "huge" }] });
    assert.equal(current.main?.eyeStyle, "xl");
    assert.equal(current.planets[0]?.eyeStyle, undefined);
    const next = mergeCompanion(
      current,
      { main: { ...body, id: "main", composition: null, orbit: null, massEarth: 60 }, planets: [{ ...body, eyeStyle: "xl-white" }] },
      { main: false, planets: new Set() },
    );
    assert.equal(next.main?.eyeStyle, "xl");
    assert.equal(next.planets[0]?.eyeStyle, "xl-white");
    const reread = parseCompanion(JSON.parse(JSON.stringify(next)));
    assert.equal(reread.planets[0]?.eyeStyle, "xl-white");
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [{ ...body, eyeStyle: "l" }] }), true);
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [{ ...body, eyeStyle: "big" }] }), false);
  });

  it("写回请求的形状校验", () => {
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [body] }), true);
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [{ ...body, id: "../x" }] }), false);
    assert.equal(isPlanetWriteRequest({ workspaceId: "w", main: null, planets: [{ ...body, massEarth: -1 }] }), false);
  });
});
