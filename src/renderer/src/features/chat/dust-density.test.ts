import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GALAXY_DUST_DEFAULT, GALAXY_DUST_KEEP, galaxyDustDensityOf, parseSettings } from "../../../../shared/settings.ts";
import { dustKept, layoutGalaxy, type GalaxySpec } from "./galaxy.ts";

/** orbita 满载那样：435 条会话，其中 8 条在做事 / 等你 / 最近（碎石块），其余进碎石带 */
function orbitaSpec(keep: number): GalaxySpec {
  const rocks = Array.from({ length: 8 }, (_, i) => ({ id: `rock-${i}`, state: i < 2 ? ("waiting" as const) : i < 5 ? ("running" as const) : ("recent" as const), label: `活 ${i}` }));
  return {
    starMass: 620,
    sessions: 435,
    eccentricity: 0.3,
    planets: [{ id: "a0", mass: 22, composition: "rock", orbitRadius: 19, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 0, state: null }],
    rocks,
    dust: Array.from({ length: 427 }, (_, i) => ({ id: `session-${String(i).padStart(4, "0")}`, title: `会话 ${i}` })),
    dustKeep: keep,
  };
}

describe("碎石密度（设置 › 外观）", () => {
  test("抽样确定性：同一条会话每次的结果一样；十分之一画出的一定也在一半里", () => {
    for (let i = 0; i < 500; i++) {
      const id = `s-${i}-${(i * 7919) % 1000}`;
      assert.equal(dustKept(id, 0.5), dustKept(id, 0.5));
      if (dustKept(id, 0.1)) assert.ok(dustKept(id, 0.5), `${id} 在十分之一里却不在一半里`);
    }
    const a = layoutGalaxy(orbitaSpec(0.5)).belt?.particles.map((p) => p.id);
    const b = layoutGalaxy(orbitaSpec(0.5)).belt?.particles.map((p) => p.id);
    assert.deepEqual(a, b);
  });

  test("四档画出的比例大致对（427 条进带子）；不显示一颗不画、全部一颗不少", () => {
    const count = (keep: number) => layoutGalaxy(orbitaSpec(keep)).belt?.particles.length ?? -1;
    assert.equal(count(1), 427);
    assert.equal(count(0), 0);
    assert.ok(Math.abs(count(0.5) - 213) < 30, `一半画了 ${count(0.5)}`);
    assert.ok(Math.abs(count(0.1) - 43) < 15, `十分之一画了 ${count(0.1)}`);
  });

  test("留下来的碎石位置不挪：调密度只是少画，名次与方位照旧按全部会话排", () => {
    const all = new Map((layoutGalaxy(orbitaSpec(1)).belt?.particles ?? []).map((p) => [p.id, p]));
    for (const p of layoutGalaxy(orbitaSpec(0.1)).belt?.particles ?? []) {
      const same = all.get(p.id);
      assert.ok(same !== undefined);
      assert.equal(p.r, same.r);
      assert.equal(p.theta0, same.theta0);
    }
  });

  test("带标注的会话（在跑 / 等你 / 最近，碎石块）永不被删；计数与带子宽窄按全部会话算", () => {
    const full = layoutGalaxy(orbitaSpec(1));
    for (const keep of [1, 0.5, 0.1, 0]) {
      const layout = layoutGalaxy(orbitaSpec(keep));
      assert.deepEqual(layout.rocks.map((rock) => rock.id), full.rocks.map((rock) => rock.id), `keep=${keep}`);
      assert.equal(layout.belt?.count, 435, "「全部 N 条会话」按全部算");
      assert.equal(layout.belt?.inner, full.belt?.inner);
      assert.equal(layout.belt?.outer, full.belt?.outer);
      assert.equal(layout.belt?.alpha, full.belt?.alpha);
    }
  });

  test("设置：缺席 = 一半；只认四档；每档的比例", () => {
    assert.equal(GALAXY_DUST_DEFAULT, "half");
    assert.equal(galaxyDustDensityOf(parseSettings({})), "half");
    for (const ok of ["all", "half", "tenth", "none"] as const) assert.equal(parseSettings({ galaxyDustDensity: ok }).galaxyDustDensity, ok);
    for (const bad of ["most", 0.5, null]) assert.equal(parseSettings({ galaxyDustDensity: bad }).galaxyDustDensity, undefined);
    assert.deepEqual(GALAXY_DUST_KEEP, { all: 1, half: 0.5, tenth: 0.1, none: 0 });
  });
});
