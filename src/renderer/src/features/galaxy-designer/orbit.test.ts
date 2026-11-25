import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bounceOrbit, designPlanets, eccentricityLevel, orbitTrackStops, orbitUiStatus, withOrbitValue } from "./orbit.ts";
import { defaultDesign, withStarMass, type GalaxyDesign, type PlanetDesign } from "./design.ts";

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
});
