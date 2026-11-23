import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  drawFrame,
  DUST_PX,
  elevationFor,
  galaxyBox,
  GALAXY_MAX_FILL,
  galaxySpecOf,
  orbitArcs,
  starRadius,
  type GalaxySpec,
  type PlanetItem,
  type StarItem,
} from "./galaxy.ts";
import { orbitRadiusOf } from "./galaxy-data.ts";
import { fitScreenSafe, SAFE_ELEVATION_MAX } from "./screen-safe.ts";

/** 画布：New Task 页（无右栏 / 开着右栏）、右栏星系图（宽 / 最窄可用） */
const CANVASES = [
  ["页面", 1088, 726],
  ["页面 + 右栏", 600, 726],
  ["右栏宽", 416, 333],
  ["右栏最窄", 336, 269],
] as const;

/** 工作区页真实数据的形状：轨道按排名等距铺（orbitRadiusOf），前几颗等你 / 在跑，质量小 */
function realistic(count: number, waiting: number, starMass = 620, starExtent?: number): GalaxySpec {
  return {
    starMass,
    ...(starExtent === undefined ? {} : { starExtent }),
    sessions: 400,
    planets: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      mass: [2, 6, 3.5, 9, 1.6, 12, 4, 2.8][i % 8] ?? 3,
      composition: (["rock", "gas", "ice"] as const)[i % 3] ?? "rock",
      orbitRadius: orbitRadiusOf(i, count),
      inclinationDeg: ((i * 37) % 11) - 5,
      nodeDeg: (i * 83) % 360,
      phaseDeg: (i * 137) % 360,
      state: i < waiting ? ("waiting" as const) : ("running" as const),
      label: `活 ${i}`,
    })),
  };
}

const SPECS: [string, GalaxySpec][] = [
  ["空", galaxySpecOf("empty")],
  ["平常（fixture）", galaxySpecOf("typical")],
  ["满载（fixture）", galaxySpecOf("full")],
  ["平常（真实形状，1 件等你）", realistic(4, 1)],
  ["满载（真实形状，3 件等你）", realistic(9, 3)],
  ["满载 · 最重主星带星环", realistic(9, 3, 1000, starRadius(1000) * 1.7)],
  ["满载 · 最轻主星", realistic(9, 6, 300)],
];

function collisions(spec: GalaxySpec, w: number, h: number): string[] {
  const box = galaxyBox(w, h, GALAXY_MAX_FILL);
  const scene = fitScreenSafe(spec, w, h, box, elevationFor(box));
  const arcs = orbitArcs(scene.layout, scene.camera, scene.viewport);
  const extent = Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass);
  const problems: string[] = [];
  for (let t = 0; t <= 600; t += 3.7) {
    const items = drawFrame(scene.layout, scene.camera, scene.viewport, arcs, t, scene.minPlanetPx, DUST_PX, false);
    const star = items.find((item): item is StarItem => item.kind === "star");
    const planets = items.filter((item): item is PlanetItem => item.kind === "planet");
    const order = new Map(items.map((item, index) => [item.key, index]));
    for (const p of planets) {
      if (star === undefined) break;
      const d = Math.hypot(p.x - star.x, p.y - star.y);
      const overlap = d < star.r * extent + p.r;
      // 与主星重叠只允许它在主星背后、且画在主星之前（被挡住）
      if (overlap && (p.depth <= star.depth || (order.get(p.key) ?? 0) > (order.get(star.key) ?? 0))) {
        problems.push(`t=${t.toFixed(1)} ${p.planetId} 画在主星上面（中心距 ${d.toFixed(1)} < ${(star.r * extent + p.r).toFixed(1)}）`);
      }
    }
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        const a = planets[i] as PlanetItem;
        const b = planets[j] as PlanetItem;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < a.r + b.r) problems.push(`t=${t.toFixed(1)} ${a.planetId} 与 ${b.planetId} 相交（${d.toFixed(1)} < ${(a.r + b.r).toFixed(1)}）`);
      }
    }
  }
  return problems;
}

describe("屏幕安全布局：任何公转相位上，没有两个天体在屏幕上相交（星系规则：天体不得相撞）", () => {
  for (const [specName, spec] of SPECS) {
    for (const [canvasName, w, h] of CANVASES) {
      test(`${specName} × ${canvasName}（${w}×${h}）`, () => {
        const problems = collisions(spec, w, h);
        assert.deepEqual(problems.slice(0, 5), [], `${problems.length} 处相交`);
      });
    }
  }

  test("轨道一律放平、只往外推不往里收；俯角不超过上限；装不下就少画最外一圈（计进 hidden）", () => {
    const spec = realistic(9, 3);
    const box = galaxyBox(336, 269, GALAXY_MAX_FILL);
    const scene = fitScreenSafe(spec, 336, 269, box, elevationFor(box));
    assert.ok(scene.elevationDeg <= SAFE_ELEVATION_MAX);
    for (const planet of scene.layout.planets) assert.equal(planet.inclination, 0);
    const radii = scene.layout.planets.map((planet) => planet.orbitRadius);
    for (let i = 1; i < radii.length; i++) assert.ok((radii[i] ?? 0) > (radii[i - 1] ?? 0));
    assert.equal(scene.layout.planets.length + scene.layout.hidden, 9);
  });
});
