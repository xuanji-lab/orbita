import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DENSITY,
  MASS_UNIT_PER_EARTH,
  MIN_CLEARANCE,
  PLANET_ZONE,
  STAR_DENSITY,
  STAR_MASS,
  STAR_MASS_DEFAULT,
  STAR_MASS_STEPS,
  bodyRadius,
  orbitClearance,
  planetRadius,
  seededStarMass,
  starRadius,
} from "./galaxy-scale.ts";
import { findSubAgentOrbit } from "./sub-agent.ts";
import { checkSystem } from "./orbit-physics.ts";

/** 界面可能画出的主星质量（M⊕）：没设计过的工作区按工作区 id 在 STAR_MASS.min–max 之间播种 */
const starMassesEarth = Array.from({ length: STAR_MASS_STEPS }, (_, index) => (STAR_MASS.min + index * 100) / MASS_UNIT_PER_EARTH);
const design = (massEarth: number): number => massEarth * MASS_UNIT_PER_EARTH;

describe("星系的比例：质量单位、密度、半径（界面画图与主进程找空轨共用这一份）", () => {
  it("1 个界面质量单位 = 10 M⊕；默认主星 620 = 62 M⊕；球体半径 ∝ (质量 / 密度)^(1/3)", () => {
    assert.equal(MASS_UNIT_PER_EARTH, 10);
    assert.equal(STAR_MASS_DEFAULT, 620);
    assert.equal(STAR_MASS.min, 300);
    assert.equal(STAR_MASS.max, 1000);
    assert.equal(bodyRadius(1000, STAR_DENSITY), Math.cbrt(1000 / 1.4));
    // 越界的质量被夹回区间：主星 6000（600 M⊕）按最重的那档画
    assert.equal(starRadius(6000), starRadius(1000));
    assert.equal(starRadius(30), starRadius(300));
  });

  it("同质量下密度越小半径越大", () => {
    const radii = (["rock", "ice", "gas"] as const).map((composition) => planetRadius({ mass: 20, composition }));
    assert.ok((radii[0] as number) < (radii[1] as number) && (radii[1] as number) < (radii[2] as number));
    assert.equal(planetRadius({ mass: 20, composition: "rock" }), Math.cbrt(20 / DENSITY.rock));
  });
});

describe("seededStarMass：没设计过的工作区画出来的那颗主星", () => {
  it("同一个工作区永远是同一档；只在 STAR_MASS_STEPS 档整百里取", () => {
    const masses = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const mass = seededStarMass(`ws-${i}`);
      assert.equal(seededStarMass(`ws-${i}`), mass);
      assert.ok(mass >= STAR_MASS.min && mass <= STAR_MASS.max && mass % 100 === 0, `${mass}`);
      masses.add(String(mass));
    }
    assert.equal(masses.size, STAR_MASS_STEPS);
  });
});

describe("orbitClearance：行星不落进主星、不出行星区（与设计面板同一条判据）", () => {
  const star = { mass: design(30) };
  const planet = { mass: design(2), composition: "rock" as const };

  it("近日距放得下两颗天体加间距才算不撞：差一点点就是撞", () => {
    const r = starRadius(star.mass) + planetRadius(planet) + MIN_CLEARANCE;
    assert.deepEqual(orbitClearance({ star, planet: { ...planet, a: r, e: 0 } }), { ok: true });
    const hit = orbitClearance({ star, planet: { ...planet, a: r - 0.01, e: 0 } });
    assert.equal(hit.ok, false);
    assert.equal(!hit.ok && hit.kind, "collision");
    // 合法的最小半长轴：圆轨道就是它本身
    assert.ok(!hit.ok && hit.kind === "collision" && Math.abs(hit.min - r) < 1e-9);
  });

  it("偏心轨道按近日距算：同样的半长轴，越扁越容易撞；合法下限随之抬高", () => {
    const e = 0.3;
    const min = (starRadius(star.mass) + planetRadius(planet) + MIN_CLEARANCE) / (1 - e);
    const hit = orbitClearance({ star, planet: { ...planet, a: min - 0.01, e } });
    assert.equal(!hit.ok && hit.kind, "collision");
    assert.ok(!hit.ok && hit.kind === "collision" && Math.abs(hit.min - min) < 1e-9);
    assert.deepEqual(orbitClearance({ star, planet: { ...planet, a: min, e } }), { ok: true });
  });

  it("远日距连同行星半径要留在行星区里，越界报 far 并给合法上限", () => {
    const max = PLANET_ZONE - planetRadius(planet);
    assert.deepEqual(orbitClearance({ star, planet: { ...planet, a: max, e: 0 } }), { ok: true });
    const far = orbitClearance({ star, planet: { ...planet, a: max + 0.01, e: 0 } });
    assert.equal(!far.ok && far.kind, "far");
    assert.ok(!far.ok && far.kind === "far" && Math.abs(far.max - max) < 1e-9);
  });

  it("偏心率越界、不是数字：都算撞（面板把这种一律报在轨道行上）", () => {
    assert.equal(orbitClearance({ star, planet: { ...planet, a: 19, e: 0.61 } }).ok, false);
    assert.equal(orbitClearance({ star, planet: { ...planet, a: Number.NaN, e: 0 } }).ok, false);
  });
});

describe("findSubAgentOrbit：新行星不落进主星", () => {
  /** 这条轨道上的新行星（按最大的那种半径算）在界面上可能画出的每一档主星之外，且不出行星区 */
  function outsideEveryStar(a: number, massEarth: number): boolean {
    return starMassesEarth.every(
      (starMassEarth) => orbitClearance({ star: { mass: design(starMassEarth) }, planet: { mass: design(massEarth), composition: "gas", a, e: 0 } }).ok,
    );
  }

  it("读不到主星质量：第一颗照旧落在 19（对最轻的那档主星也在外面）", () => {
    const first = findSubAgentOrbit(null, [], 2);
    assert.equal(first, 19);
    assert.equal(outsideEveryStar(first, 2), true);
  });

  it("读不到主星质量、已经有一颗在 19：绝不给出落进主星的轨道——排不开就如实回 null", () => {
    const second = findSubAgentOrbit(null, [{ massEarth: 2, orbit: 19, eccentricity: 0, periapsisDeg: 0 }], 2);
    if (second !== null) assert.equal(outsideEveryStar(second, 2), true, `第二颗落在 ${second}，落进了界面上某一档主星里`);
    assert.notEqual(second, 4.5, "以前第二颗落在 4.5，叠在主星上");
  });

  it("主星质量写明了：给任何一档主星、带着一颗老行星找出来的轨道都在主星之外，行星间距也不是红区", () => {
    for (const starMassEarth of starMassesEarth) {
      for (const old of [{ massEarth: 2, orbit: 19, eccentricity: 0 }, { massEarth: 0.5, orbit: 31, eccentricity: 0.2 }]) {
        const found = findSubAgentOrbit(starMassEarth, [{ ...old, periapsisDeg: 0 }], 2);
        if (found === null) continue;
        assert.ok(
          orbitClearance({ star: { mass: design(starMassEarth) }, planet: { mass: design(2), composition: "gas", a: found, e: 0 } }).ok,
          `主星 ${starMassEarth} M⊕、老行星在 ${old.orbit}：新轨道 ${found} 落进了主星`,
        );
        const next = [
          { mass: old.massEarth, a: old.orbit, e: old.eccentricity, omegaDeg: 0 },
          { mass: 2, a: found, e: 0, omegaDeg: 0 },
        ];
        // 黄区（拥挤）允许，红区不行——与原来一样
        assert.equal(
          checkSystem({ mass: starMassEarth }, next).warnings.some((warning) => warning.level === "red" && (warning.innerIndex === 1 || warning.outerIndex === 1)),
          false,
          `主星 ${starMassEarth} M⊕、老行星在 ${old.orbit}：新轨道 ${found} 与老行星隔不开`,
        );
      }
    }
  });

  it("主星够重时两颗排得开：第二颗落在第一颗外侧、主星之外", () => {
    const second = findSubAgentOrbit(100, [{ massEarth: 2, orbit: 19, eccentricity: 0, periapsisDeg: 0 }], 2);
    assert.notEqual(second, null);
    assert.ok(second !== null && second > 19);
    assert.equal(outsideEveryStar(second as number, 2), true);
  });

  it("原来的行星间距规则不回退：主星 600 M⊕ 带一颗 e=0.3、a=19 的老行星，新圆轨道仍在 38", () => {
    assert.equal(findSubAgentOrbit(600, [{ massEarth: 2.2, orbit: 19, eccentricity: 0.3, periapsisDeg: 0 }], 2), 38);
  });

  it("排不下时仍是 null：小主星带着一颗老行星，两颗默认质量的行星在行星区里隔不开", () => {
    assert.equal(findSubAgentOrbit(20, [{ massEarth: 2.2, orbit: 19, eccentricity: 0.3, periapsisDeg: 0 }], 2), null);
  });
});
