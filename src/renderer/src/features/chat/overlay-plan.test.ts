import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGENT_READABLE_MAX, GALAXY_MAX, GALAXY_MAX_FILL, drawFrame, galaxyBox, type GalaxySpec } from "./galaxy.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { planOverlay } from "./overlay-plan.ts";

/** 编排星系：几颗子智能体 + 在做事的会话（碎石块，前 waiting 块等你、其余在跑） */
function agentSpec(starMass: number, agents: readonly [number, "rock" | "ice" | "gas", number][], rocks: number, waiting: number): GalaxySpec {
  return {
    starMass,
    sessions: 120,
    eccentricity: 0.3,
    planets: agents.map(([mass, composition, orbitRadius], i) => ({ id: `a${i}`, mass, composition, orbitRadius, inclinationDeg: 0, nodeDeg: (i * 83) % 360, phaseDeg: (i * 137) % 360, state: null })),
    rocks: Array.from({ length: rocks }, (_, i) => ({ id: `s${i}`, state: i < waiting ? ("waiting" as const) : ("running" as const), label: `会话 ${i}` })),
  };
}

const SPECS: [string, GalaxySpec][] = [
  ["意图系统（2 块碎石，1 块等你）", agentSpec(600, [[22, "rock", 19], [30, "rock", 31], [16, "rock", 43]], 2, 1)],
  ["满载（6 颗 + 8 块碎石，3 块等你）", agentSpec(620, [[40, "gas", 19], [34, "rock", 25], [11, "ice", 31], [22, "rock", 37], [16, "ice", 43], [30, "gas", 49]], 8, 3)],
];

const CANVASES = [
  ["编排页", 1040, 722, GALAXY_MAX_FILL],
  ["单智能体首页", 1000, 330, GALAXY_MAX],
  ["右栏星系图", 440, 344, GALAXY_MAX_FILL],
] as const;

describe("会话标注不因视角消失（2026-11-24 用户：「为什么有些视角，session 的 annotation 就消失了」）", () => {
  for (const [specName, spec] of SPECS) {
    for (const [canvasName, w, h, max] of CANVASES) {
      test(`${specName} × ${canvasName}：方位每 30°、俯角 10–60 每 10°，在跑与等你的标注数量不变，只有被主星挡住的那一颗暂时例外`, () => {
        const names = new Map(spec.planets.map((planet) => [planet.id, planet.id]));
        const active = (spec.rocks ?? []).filter((rock) => rock.state === "waiting" || rock.state === "running");
        const waitingTotal = active.filter((rock) => rock.state === "waiting").length;
        const problems: string[] = [];
        let samples = 0;
        let occludedSamples = 0;
        const box = galaxyBox(w, h, max);
        for (let tilt = 10; tilt <= 60; tilt += 10) {
          for (let azimuth = 0; azimuth < 360; azimuth += 30) {
            const scene = fitScreenSafe(spec, w, h, box, tilt, AGENT_READABLE_MAX, azimuth);
            for (const t of [0, 11, 23, 37]) {
              const items = drawFrame({ ...scene.layout, belt: null }, scene.camera, scene.viewport, [], t, scene.minPlanetPx);
              const plan = planOverlay({
                items,
                layout: scene.layout,
                starExtent: 1,
                agentNames: names,
                starless: false,
                avoid: null,
                width: w,
                height: h,
                glyphPx: 12,
                waitingWord: "等你",
                rankOf: new Map(),
                previous: new Map(),
              });
              samples += 1;
              if (plan.occluded.length > 0) occludedSamples += 1;
              const shown = new Set([...plan.callouts.keys(), ...plan.spill.map((target) => target.id)]);
              const missing = active.filter((rock) => !shown.has(rock.id) && !plan.occluded.includes(rock.id));
              if (missing.length > 0) problems.push(`${tilt}°·${azimuth}° t=${t}：${missing.map((rock) => rock.id).join("、")} 没有标注`);
              const waitingShown = active.filter((rock) => rock.state === "waiting" && (shown.has(rock.id) || plan.occluded.includes(rock.id))).length;
              if (waitingShown !== waitingTotal) problems.push(`${tilt}°·${azimuth}° t=${t}：等你只剩 ${waitingShown}/${waitingTotal}`);
              if (plan.occluded.length > 1) problems.push(`${tilt}°·${azimuth}° t=${t}：同时被主星挡住 ${plan.occluded.length} 块`);
            }
          }
        }
        assert.deepEqual(problems.slice(0, 5), [], `${problems.length} 处`);
        // 「被主星挡住」只是一小段：取样里占比不超过三成
        assert.ok(occludedSamples / samples < 0.3, `被主星挡住的取样占 ${((occludedSamples / samples) * 100).toFixed(0)}%`);
      });
    }
  }

  test("碎石块那一圈整圈没画（cramped）时，在做事的会话全部进角落那一列，等你排在前面", () => {
    const [, spec] = SPECS[1] as [string, GalaxySpec];
    const box = galaxyBox(1000, 330, GALAXY_MAX);
    const scene = fitScreenSafe(spec, 1000, 330, box, 40, AGENT_READABLE_MAX, 0);
    const layout = { ...scene.layout, rockOrbit: null };
    const items = drawFrame({ ...layout, belt: null }, scene.camera, scene.viewport, [], 0, scene.minPlanetPx);
    const plan = planOverlay({ items, layout, starExtent: 1, agentNames: new Map(), starless: false, avoid: null, width: 1000, height: 330, glyphPx: 12, waitingWord: "等你", rankOf: new Map(), previous: new Map() });
    assert.equal(plan.callouts.size, 0);
    assert.equal(plan.spill.length, 8);
    assert.deepEqual(plan.spill.slice(0, 3).map((target) => target.state), ["waiting", "waiting", "waiting"]);
    assert.ok((plan.spill[0]?.text ?? "").startsWith("等你 · "));
  });
});
