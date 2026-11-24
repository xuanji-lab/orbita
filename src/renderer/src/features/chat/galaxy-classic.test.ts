import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CAMERA_ELEVATION_DEG, FRAME_EXTENT, GALAXY_MAX, frameViewport, galaxyBox, galaxySpecOf, layoutGalaxy, makeCamera, type GalaxySpec, type PlanetSpec } from "./galaxy.ts";
import { MAX_STEP_MS, advanceClock, classicOrbitArcs, drawClassicFrame, type ClassicItem } from "./galaxy-classic.ts";

/**
 * 单智能体首页的原型星系「原样保留」的钉子（2026-11-24 主会话打回：这一支被一起换成了合成器，碎石压扁、受光面固定）。
 * GOLDEN 是 d12f2e2a 的 layoutGalaxy + orbitArcs + drawFrame（默认参数，即单智能体首页的调用）在同样场景下
 * 绘制表 JSON 的 FNV-1a 哈希：四种 fixture × 三块画布 × 三个时刻，逐字节一致才算原样。
 * 动过共用的 layoutGalaxy（碎石带）或 classic 的投影 / 受光 / 碎石，这里就红。
 */
const GOLDEN: Record<string, string> = {
  "empty@900x240@0": "912f605",
  "empty@900x240@7.3": "912f605",
  "empty@900x240@123.4": "912f605",
  "empty@1088x420@0": "44a60e5b",
  "empty@1088x420@7.3": "44a60e5b",
  "empty@1088x420@123.4": "44a60e5b",
  "empty@1400x460@0": "a1fa756d",
  "empty@1400x460@7.3": "a1fa756d",
  "empty@1400x460@123.4": "a1fa756d",
  "typical@900x240@0": "ad036574",
  "typical@900x240@7.3": "d72ab184",
  "typical@900x240@123.4": "ad7506ed",
  "typical@1088x420@0": "ee92957b",
  "typical@1088x420@7.3": "3acfa553",
  "typical@1088x420@123.4": "916c5c02",
  "typical@1400x460@0": "713e2b1f",
  "typical@1400x460@7.3": "c3bf20fa",
  "typical@1400x460@123.4": "aa905a87",
  "full@900x240@0": "edf92877",
  "full@900x240@7.3": "ebfb9248",
  "full@900x240@123.4": "3a85de32",
  "full@1088x420@0": "aa250392",
  "full@1088x420@7.3": "1b5d9671",
  "full@1088x420@123.4": "2f4e98f3",
  "full@1400x460@0": "f75f07e0",
  "full@1400x460@7.3": "ab2343d0",
  "full@1400x460@123.4": "44a67a6f",
  "typical-waiting@900x240@0": "16580bdb",
  "typical-waiting@900x240@7.3": "b0b4ee5c",
  "typical-waiting@900x240@123.4": "7f537d8",
  "typical-waiting@1088x420@0": "7961fafb",
  "typical-waiting@1088x420@7.3": "2ec7eddc",
  "typical-waiting@1088x420@123.4": "ab128585",
  "typical-waiting@1400x460@0": "dc31facf",
  "typical-waiting@1400x460@7.3": "a13a8cc6",
  "typical-waiting@1400x460@123.4": "7432c796",
};

function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function specOf(fixture: "empty" | "typical" | "full" | "typical-waiting"): GalaxySpec {
  if (fixture !== "typical-waiting") return galaxySpecOf(fixture);
  const base = galaxySpecOf("typical");
  return { ...base, planets: base.planets.map((p, i) => (i === 1 ? { ...p, state: "waiting" as const } : p)) };
}

function sceneOf(spec: GalaxySpec, w: number, h: number) {
  const camera = makeCamera(FRAME_EXTENT, CAMERA_ELEVATION_DEG);
  const vp = frameViewport(camera, w, h, galaxyBox(w, h, GALAXY_MAX));
  const layout = layoutGalaxy(spec);
  return { camera, vp, layout, arcs: classicOrbitArcs(layout, camera, vp) };
}

describe("单智能体首页的原型星系：与 d12f2e2a 逐字节一致", () => {
  for (const fixture of ["empty", "typical", "full", "typical-waiting"] as const) {
    for (const [w, h] of [[900, 240], [1088, 420], [1400, 460]] as const) {
      test(`${fixture} @ ${w}×${h}：三个时刻的绘制表哈希`, () => {
        const { camera, vp, layout, arcs } = sceneOf(specOf(fixture), w, h);
        for (const t of [0, 7.3, 123.4]) {
          const key = `${fixture}@${w}x${h}@${t}`;
          assert.equal(fnv(JSON.stringify(drawClassicFrame(layout, camera, vp, arcs, t))), GOLDEN[key], key);
        }
      });
    }
  }
});

describe("原型星系的画法：真透视、受光随位相、碎石各自转", () => {
  const planet = (id: string, orbitRadius: number, extra: Partial<PlanetSpec> = {}): PlanetSpec => ({ id, mass: 4, composition: "rock", orbitRadius, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 0, ...extra });
  const frameAt = (spec: GalaxySpec, t: number): ClassicItem[] => {
    const { camera, vp, layout, arcs } = sceneOf(spec, 900, 240);
    return drawClassicFrame(layout, camera, vp, arcs, t);
  };
  const planetOf = (items: ClassicItem[]) => items.find((item) => item.kind === "planet");

  test("受光（位相）：行星在主星与相机之间时只看到背光面（「新月」），在主星远侧时看到满面（「满月」）", () => {
    const front = planetOf(frameAt({ starMass: 600, planets: [planet("x", 30, { phaseDeg: 270 })], sessions: 0 }, 0));
    const back = planetOf(frameAt({ starMass: 600, planets: [planet("x", 30, { phaseDeg: 90 })], sessions: 0 }, 0));
    assert.ok(front?.kind === "planet" && front.lit < 0.1);
    assert.ok(back?.kind === "planet" && back.lit > 0.9);
  });

  test("透视：同一颗行星转到近侧比在远侧大（近大远小）", () => {
    const near = planetOf(frameAt({ starMass: 600, planets: [planet("x", 30, { phaseDeg: 270 })], sessions: 0 }, 0));
    const far = planetOf(frameAt({ starMass: 600, planets: [planet("x", 30, { phaseDeg: 90 })], sessions: 0 }, 0));
    assert.ok(near?.kind === "planet" && far?.kind === "planet" && near.r > far.r * 1.05);
  });

  test("星屑按主星前后拆成两条路径：满载也只有两个对象，原型带子封顶 60 颗", () => {
    const items = frameAt(galaxySpecOf("full"), 3);
    const dust = items.filter((item) => item.kind === "dust");
    assert.equal(dust.length, 2);
    const index = (key: string) => items.findIndex((item) => item.key === key);
    assert.ok(index("dust-back") < index("star") && index("dust-front") > index("star"));
    assert.equal(layoutGalaxy(galaxySpecOf("full")).belt?.particles.length, 60);
  });

  test("时钟只在跑的时候走：恢复后第一帧不推进，卡顿 / 节流后最多推进一步", () => {
    assert.equal(advanceClock(500, null, 99999), 500);
    assert.equal(advanceClock(500, 1000, 1016), 516);
    assert.equal(advanceClock(500, 1000, 60_000), 500 + MAX_STEP_MS);
    assert.equal(advanceClock(500, 1000, 900), 500);
  });
});
