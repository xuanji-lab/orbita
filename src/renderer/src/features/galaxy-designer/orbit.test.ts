import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bounceOrbit, designPlanets, eccentricityLevel, orbitTrackStops, orbitUiStatus, withOrbitValue } from "./orbit.ts";
import { defaultDesign, withStarMass, writableDesign, type GalaxyDesign, type PlanetDesign } from "./design.ts";
import { displayToAu, starPlanetCapacity } from "../../../../shared/galaxy-scale.ts";
import { ladderDisplay } from "../../../../shared/sub-agent.ts";

function fixture(): GalaxyDesign {
  const base = defaultDesign("orbit-ui", "default");
  const make = (id: string, a: number, e: number, omega: number): PlanetDesign => ({ ...base.planet, id, mass: 1, orbitRadius: a, eccentricity: e, periapsisDeg: omega });
  const planets = [make("a", 14, 0.1, 20), make("b", 34, 0.2, 140), make("c", 50, 0.3, 260)];
  return { ...base, editing: "planet", planet: planets[1] ?? null, planets, planetIndex: 1 };
}

describe("轨道专业版的弹回与着色", () => {
  test("a 拖进红区：松手弹到最近的硬合法下界，黄区不弹", () => {
    const safe = fixture();
    const two = { ...safe, planets: designPlanets(safe).slice(0, 2) };
    const red = withOrbitValue(two, "a", 15);
    assert.equal(orbitUiStatus(red).level, "red");
    const bounced = bounceOrbit(red, two, "a");
    assert.equal(bounced.kind, "a-min");
    if (bounced.kind === "a-min") {
      assert.ok((bounced.design.planet?.orbitRadius ?? 0) > 15);
      assert.notEqual(orbitUiStatus(bounced.design).level, "red");
      assert.equal(bounced.value, bounced.design.planet?.orbitRadius);
    }
    let yellow: GalaxyDesign | null = null;
    for (let a = 4; a <= 52 && yellow === null; a += 0.25) {
      const candidate = withOrbitValue(two, "a", a);
      if (orbitUiStatus(candidate).level === "yellow") yellow = candidate;
    }
    assert.ok(yellow !== null, "这组轨道应能找到一段黄区");
    assert.equal(bounceOrbit(yellow, two, "a").kind, "kept");
  });

  test("e 太扁：弹回硬上限；轨道色带按位置分红黄绿", () => {
    const safe = fixture();
    const two = { ...safe, planets: designPlanets(safe).slice(0, 2) };
    const red = withOrbitValue(two, "e", 0.6);
    const bounced = bounceOrbit(red, two, "e");
    assert.equal(bounced.kind, "e-max");
    if (bounced.kind === "e-max") {
      assert.ok(bounced.value < 0.6);
      assert.notEqual(eccentricityLevel(orbitUiStatus(bounced.design), bounced.value, false), "red");
    }
    const stops = orbitTrackStops(orbitUiStatus(two), 4, 52);
    assert.deepEqual([...new Set(stops.map((stop) => stop.color))].sort(), ["green", "red", "yellow"]);
    for (let i = 1; i < stops.length; i++) assert.ok((stops[i]?.at ?? 0) >= (stops[i - 1]?.at ?? 0));
  });

  test("ω 只转朝向，不伪造一个碰撞弹回；单行星物理合法时绿", () => {
    const safe = fixture();
    const turned = withOrbitValue(safe, "omega", 359);
    assert.equal(bounceOrbit(turned, safe, "omega").kind, "omega");
    const single = { ...safe, planets: designPlanets(safe).slice(0, 1), planet: designPlanets(safe)[0] ?? null, planetIndex: 0 };
    assert.equal(orbitUiStatus(single).level, "green");
  });

  test("主星变轻：质量上限跟到 10%，越界行星同步收紧", () => {
    const safe = fixture();
    const heavy = { ...safe, planet: { ...(safe.planet as PlanetDesign), mass: 40 } };
    const next = withStarMass(heavy, 300);
    assert.equal(next.design.star?.mass, 300);
    assert.equal(next.design.planet?.mass, 30);
    assert.ok(next.clamped.includes("b"));
  });

  test("红黄绿按物理层判：1.0 M☉ 满 8 颗默认轨道全绿、能落盘；面板上的 AU 与主进程同一个映射", () => {
    const base = defaultDesign("orbit-ui", "default");
    const starMass = 1000;
    const planets = Array.from({ length: starPlanetCapacity(starMass) }, (_, k): PlanetDesign => ({ ...base.planet, id: `p${k}`, mass: 20, composition: "rock", orbitRadius: ladderDisplay(starMass, k), eccentricity: 0, periapsisDeg: 0 }));
    const star = { ...(base.star ?? { name: "", elements: base.planet.elements, zoom: base.planet.zoom }), mass: starMass };
    for (let index = 0; index < planets.length; index++) {
      const design: GalaxyDesign = { ...base, star, editing: "planet", planets, planet: planets[index] ?? null, planetIndex: index };
      const status = orbitUiStatus(design);
      assert.equal(status.level, "green", `第 ${index + 1} 颗`);
      assert.ok(Math.abs(status.au - displayToAu(starMass, ladderDisplay(starMass, index))) < 1e-12);
      // 画面区间与物理区间是同一段：内外顺序一致
      assert.ok(status.minA <= (planets[index]?.orbitRadius ?? 0) && (planets[index]?.orbitRadius ?? 0) <= status.maxA);
      assert.ok(status.minAu < status.au && status.au < status.maxAu);
    }
    assert.equal(writableDesign({ ...base, star, editing: "planet", planets, planet: planets[0] ?? null, planetIndex: 0 }), true);
    // 同样 8 颗放在 0.3 M☉ 上：真实比例下照样按 1.3 倍等比，但画面挤进了 3 颗的地盘——物理上仍判得出来（不是一律绿）
    const light = { ...base, star: { ...star, mass: 300 }, editing: "planet" as const, planets, planet: planets[1] ?? null, planetIndex: 1 };
    assert.notEqual(orbitUiStatus(light).level, "green");
  });
});
