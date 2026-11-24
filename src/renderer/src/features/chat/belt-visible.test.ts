import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGENT_READABLE_MAX, GALAXY_MAX, GALAXY_MAX_FILL, drawFrame, galaxyBox, type GalaxySpec, type RockItem } from "./galaxy.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { planOverlay } from "./overlay-plan.ts";

/**
 * 回归：用户真实的「意图系统」（2026-11-24 导入 101 条会话）在编排页上一颗碎石都没有、碎石带不画，最近三条全进了左下角那一列。
 * 根因：82d49a6c「装不下先收碎石」——低俯角下行星为了竖向让开被推进原来碎石带那一圈，碎石带整条收掉，碎石块连同引线一起没了。
 * 这里钉住：3 颗子智能体 + 约 100 条根会话、0 条在跑（3 条最近），任何视角下碎石带都有粒子、在画框里，带标注的碎石块至少一块画在画布上。
 */
const SPEC: GalaxySpec = {
  starMass: 600,
  sessions: 101,
  eccentricity: 0.3,
  planets: [
    [22, "rock", 19],
    [30, "rock", 31],
    [16, "rock", 43],
  ].map(([mass, composition, orbitRadius], i) => ({ id: `a${i}`, mass: mass as number, composition: composition as "rock", orbitRadius: orbitRadius as number, inclinationDeg: 0, nodeDeg: 0, phaseDeg: i * 120, state: null })),
  rocks: [0, 1, 2].map((i) => ({ id: `r${i}`, state: "recent" as const, label: `最近 ${i}` })),
  dust: Array.from({ length: 98 }, (_, i) => ({ id: `d${i}`, title: `会话 ${i}` })),
};

const CANVASES = [
  ["编排页（用户的窗口）", 810, 612, GALAXY_MAX_FILL],
  ["编排页（宽窗）", 1040, 722, GALAXY_MAX_FILL],
  ["单智能体首页", 1000, 330, GALAXY_MAX],
] as const;

describe("碎石带与碎石块在任何视角下都看得见（3 颗子智能体 + 100 条根会话）", () => {
  for (const [name, w, h, max] of CANVASES) {
    test(`${name} ${w}×${h}：俯角 10–60 每 10°、方位每 30°`, () => {
      const box = galaxyBox(w, h, max);
      const problems: string[] = [];
      for (let tilt = 10; tilt <= 60; tilt += 10) {
        for (let azimuth = 0; azimuth < 360; azimuth += 30) {
          const scene = fitScreenSafe(SPEC, w, h, box, tilt, AGENT_READABLE_MAX, azimuth);
          const belt = scene.layout.belt;
          if (belt === null || belt.particles.length === 0) {
            problems.push(`${tilt}°·${azimuth}°：没有碎石带`);
            continue;
          }
          if (belt.outer > 64 * 1.06 + 1e-6) problems.push(`${tilt}°·${azimuth}°：碎石带推出了画框（外沿 ${belt.outer.toFixed(1)}）`);
          if (scene.layout.rockOrbit === null) problems.push(`${tilt}°·${azimuth}°：碎石块那一圈没画`);
          // 碎石块（带标注的最近会话）至少一块画在画布上（取几个相位）
          let inside = false;
          for (const t of [0, 17, 41]) {
            const items = drawFrame({ ...scene.layout, belt: null }, scene.camera, scene.viewport, [], t, scene.minPlanetPx);
            inside ||= items.some((item): item is RockItem => item.kind === "rock" && item.x >= 0 && item.x <= w && item.y >= 0 && item.y <= h);
          }
          if (!inside) problems.push(`${tilt}°·${azimuth}°：碎石块一块都不在画布上`);
        }
      }
      assert.deepEqual(problems.slice(0, 6), [], `${problems.length} 处`);
    });
  }

  test("默认视角 40° · 0° · 1×：最近的碎石块拉引线，不默认就进左下角那一列", () => {
    for (const [name, w, h, max] of CANVASES.slice(0, 2)) {
      const box = galaxyBox(w, h, max);
      const scene = fitScreenSafe(SPEC, w, h, box, 40, AGENT_READABLE_MAX, 0);
      let best = 0;
      for (const t of [0, 13, 29, 47]) {
        const items = drawFrame({ ...scene.layout, belt: null }, scene.camera, scene.viewport, [], t, scene.minPlanetPx);
        const plan = planOverlay({ items, layout: scene.layout, starExtent: 1, agentNames: new Map(SPEC.planets.map((p) => [p.id, p.id])), starless: false, avoid: null, width: w, height: h, glyphPx: 12, waitingWord: "等你", rankOf: new Map(), previous: new Map() });
        best = Math.max(best, plan.callouts.size);
      }
      assert.ok(best >= 2, `${name}：只有 ${best} 条引线`);
    }
  });
});
