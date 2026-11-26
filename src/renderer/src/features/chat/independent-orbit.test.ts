import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { angularSpeed, FRAME_EXTENT, galaxyBox, layoutGalaxy, makeCamera, orbitArcs, orbitFrame, orbitPoint, type GalaxySpec } from "./galaxy.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { moversOf } from "./galaxy-motion.ts";

const SPEC: GalaxySpec = {
  starMass: 620,
  sessions: 0,
  planets: [
    { id: "a", mass: 1, composition: "rock", orbitRadius: 14, eccentricity: 0.1, periapsisDeg: 20, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 30 },
    { id: "b", mass: 2, composition: "gas", orbitRadius: 30, eccentricity: 0.2, periapsisDeg: 140, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 160 },
    { id: "c", mass: 3, composition: "ice", orbitRadius: 44, eccentricity: 0.25, periapsisDeg: 260, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 290 },
  ],
};

describe("每颗自己的轨道根数进入全部渲染层", () => {
  test("布局不暗改 a/e/ω；三颗轨道形状与朝向不同，初相位仍按数据取", () => {
    const layout = layoutGalaxy(SPEC);
    assert.deepEqual(layout.planets.map((planet) => [planet.orbitRadius, Number(planet.ecc.toFixed(2)), Number(((planet.periapsis * 180) / Math.PI).toFixed(0))]), [[14, 0.1, 20], [30, 0.2, 140], [44, 0.25, 260]]);
    assert.deepEqual(layout.adjusted, []);
    assert.equal(layout.orbitScale, 1);
    const arcs = orbitArcs(layout, makeCamera(FRAME_EXTENT), { width: 800, height: 400, focal: 500, cx: 400, cy: 200 });
    assert.equal(new Set(arcs.map((arc) => arc.d)).size, arcs.length);
    for (const planet of layout.planets) {
      const point = orbitPoint(planet.orbitRadius, 0, 0, 0, planet.ecc, planet.periapsis);
      const q = planet.orbitRadius * (1 - planet.ecc);
      assert.ok(Math.abs(Math.hypot(point.x, point.y) - q) < 1e-9);
    }
  });

  test("周期含主星 + 行星质量；主星更重同轨道更快，外圈更慢", () => {
    const layout = layoutGalaxy(SPEC);
    const a = layout.planets[0];
    const b = layout.planets[1];
    assert.ok(a !== undefined && b !== undefined && a.omega > b.omega);
    assert.ok((a?.omega ?? 0) > angularSpeed(14, 620, 0));
    const heavier = layoutGalaxy({ ...SPEC, starMass: 1240 });
    assert.ok(Math.abs((heavier.planets[0]?.omega ?? 0) / (a?.omega ?? 1) - Math.sqrt(1241 / 621)) < 1e-9);
  });

  test("fitScreenSafe 与转台投影保留各自根数，比例尺不随视角变", () => {
    const box = galaxyBox(1000, 700);
    const ref = fitScreenSafe(SPEC, 1000, 700, box, 40, 20);
    const turned = fitScreenSafe(SPEC, 1000, 700, box, 20, 20, 75);
    assert.equal(ref.viewport.focal, turned.viewport.focal);
    assert.deepEqual(turned.layout.planets.map((planet) => [planet.orbitRadius, planet.ecc, planet.periapsis]), ref.layout.planets.map((planet) => [planet.orbitRadius, planet.ecc, planet.periapsis]));
    const movers = moversOf(turned.layout, turned.camera, turned.viewport, turned.minPlanetPx, 4);
    for (const mover of movers) {
      const body = turned.layout.planets.find((planet) => planet.id === mover.id);
      assert.equal(mover.ecc, body?.ecc);
      assert.equal(mover.periapsis, body?.periapsis);
      const frame = orbitFrame(body?.orbitRadius ?? 0, 0, 0, turned.camera, turned.viewport, mover.ecc, mover.periapsis);
      assert.deepEqual(mover.frame, frame);
    }
  });
});
