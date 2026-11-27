import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auToDisplay,
  DENSITY,
  displayToAu,
  displayZone,
  INNER_ORBIT_AU_AT_SOLAR,
  ladderOrbit,
  MASS_UNIT_PER_EARTH,
  ORBIT_LADDER_RATIO,
  physicalOrbitOf,
  physicalZone,
  starPhysicalEarth,
  starPlanetCapacity,
  starSolarMass,
  MIN_CLEARANCE,
  PLANET_ZONE,
  STAR_DENSITY,
  STAR_MASS,
  STAR_MASS_DEFAULT,
  STAR_MASS_STEPS,
  bodyRadius,
  DRAWN_INNER_PER_STAR_RADIUS,
  orbitClearance,
  PLANET_DRAW_SCALE,
  planetDrawRadius,
  planetRadius,
  seededStarMass,
  starRadius,
} from "./galaxy-scale.ts";
import { findSubAgentOrbit, ladderDisplay } from "./sub-agent.ts";
import { checkSystem, orbitLevel, pairGapInRH } from "./orbit-physics.ts";
import { PLANET_AGENTS_MAX } from "./planet-design.ts";

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
    const r = starRadius(star.mass) + planetDrawRadius(planet) + MIN_CLEARANCE;
    assert.deepEqual(orbitClearance({ star, planet: { ...planet, a: r, e: 0 } }), { ok: true });
    const hit = orbitClearance({ star, planet: { ...planet, a: r - 0.01, e: 0 } });
    assert.equal(hit.ok, false);
    assert.equal(!hit.ok && hit.kind, "collision");
    // 合法的最小半长轴：圆轨道就是它本身
    assert.ok(!hit.ok && hit.kind === "collision" && Math.abs(hit.min - r) < 1e-9);
  });

  it("偏心轨道按近日距算：同样的半长轴，越扁越容易撞；合法下限随之抬高", () => {
    const e = 0.3;
    const min = (starRadius(star.mass) + planetDrawRadius(planet) + MIN_CLEARANCE) / (1 - e);
    const hit = orbitClearance({ star, planet: { ...planet, a: min - 0.01, e } });
    assert.equal(!hit.ok && hit.kind, "collision");
    assert.ok(!hit.ok && hit.kind === "collision" && Math.abs(hit.min - min) < 1e-9);
    assert.deepEqual(orbitClearance({ star, planet: { ...planet, a: min, e } }), { ok: true });
  });

  it("远日距连同行星半径要留在行星区里，越界报 far 并给合法上限", () => {
    const max = PLANET_ZONE - planetDrawRadius(planet);
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
  it("读不到主星质量（连工作区 id 都没有）：按最轻那档（0.3 M☉）的第一档默认轨道，在那颗主星之外", () => {
    const first = findSubAgentOrbit(null, [], 2);
    assert.equal(first, ladderDisplay(STAR_MASS.min, 0));
    assert.ok(orbitClearance({ star: { mass: STAR_MASS.min }, planet: { mass: design(4), composition: "gas", a: first as number, e: 0 } }).ok);
  });

  it("每一档主星的每一档默认轨道都不碰主星：连最大的那种行星（4 M⊕ 气态）都放得下", () => {
    for (let ui = STAR_MASS.min; ui <= STAR_MASS.max; ui += 10) {
      for (let k = 0; k < starPlanetCapacity(ui); k++) {
        assert.ok(orbitClearance({ star: { mass: ui }, planet: { mass: design(4), composition: "gas", a: ladderDisplay(ui, k), e: 0 } }).ok, `${ui} 第 ${k} 档`);
      }
    }
  });

  it("主星质量写明了：给任何一档主星、带着一颗老行星找出来的轨道都在主星之外，物理层的行星间距也不是红区", () => {
    for (const starMassEarth of starMassesEarth) {
      for (const old of [{ massEarth: 2, orbit: 19, eccentricity: 0 }, { massEarth: 0.5, orbit: 31, eccentricity: 0.2 }]) {
        const found = findSubAgentOrbit(starMassEarth, [{ ...old, periapsisDeg: 0 }], 2);
        assert.notEqual(found, null, `主星 ${starMassEarth} M⊕、老行星在 ${old.orbit}：应当排得下第二颗`);
        assert.ok(
          orbitClearance({ star: { mass: design(starMassEarth) }, planet: { mass: design(2), composition: "gas", a: found as number, e: 0 } }).ok,
          `主星 ${starMassEarth} M⊕、老行星在 ${old.orbit}：新轨道 ${found} 落进了主星`,
        );
        const starUi = design(starMassEarth);
        const next = [
          physicalOrbitOf(starUi, { mass: design(old.massEarth), a: old.orbit, e: old.eccentricity, omegaDeg: 0 }),
          physicalOrbitOf(starUi, { mass: design(2), a: found as number, e: 0, omegaDeg: 0 }),
        ];
        assert.equal(
          checkSystem({ mass: starPhysicalEarth(starUi) }, next).warnings.some((warning) => warning.level === "red"),
          false,
          `主星 ${starMassEarth} M⊕、老行星在 ${old.orbit}：新轨道 ${found} 与老行星隔不开`,
        );
      }
    }
  });

  it("挑不冲突的最内一档：1.0 M☉ 带一颗 e=0.3、画面 19 的老行星（物理 0.32 AU，在第一档里面），第一档与它的远日点相交，落在第二档", () => {
    assert.ok(displayToAu(1000, 19) < ladderOrbit(1000, 0).au);
    assert.equal(findSubAgentOrbit(100, [{ massEarth: 2.2, orbit: 19, eccentricity: 0.3, periapsisDeg: 0 }], 2), ladderDisplay(1000, 1));
  });

  it("排不下时仍是 null：0.3 M☉ 带两颗很扁的大行星，整个画面行星区都与它们相交", () => {
    assert.equal(
      findSubAgentOrbit(30, [{ massEarth: 4, orbit: 20, eccentricity: 0.6 }, { massEarth: 4, orbit: 40, eccentricity: 0.4 }], 2),
      null,
    );
  });

  it("从空星系一颗一颗建到上限：都落在默认档上（等比 1.3），物理层全绿，画面上不进主星、不出行星区，画面顺序 = 物理顺序", () => {
    for (let ui = STAR_MASS.min; ui <= STAR_MASS.max; ui += 100) {
      const massEarth = ui / MASS_UNIT_PER_EARTH;
      const built: { massEarth: number; orbit: number; eccentricity: number }[] = [];
      for (let k = 0; k < starPlanetCapacity(ui); k++) {
        const orbit = findSubAgentOrbit(massEarth, built, 2);
        assert.equal(orbit, ladderDisplay(ui, k), `${ui / 1000} M☉ 第 ${k + 1} 颗`);
        built.push({ massEarth: 2, orbit: orbit as number, eccentricity: 0 });
      }
      const physical = built.map((planet) => physicalOrbitOf(ui, { mass: design(planet.massEarth), a: planet.orbit, e: 0, omegaDeg: 0 }));
      assert.deepEqual(checkSystem({ mass: starPhysicalEarth(ui) }, physical).warnings, [], `${ui / 1000} M☉ 满载应当全绿`);
      for (let i = 1; i < physical.length; i++) {
        assert.ok(Math.abs((physical[i] as { a: number }).a / (physical[i - 1] as { a: number }).a - ORBIT_LADDER_RATIO) < 1e-3);
        assert.ok((built[i] as { orbit: number }).orbit > (built[i - 1] as { orbit: number }).orbit);
      }
      for (const planet of built) {
        assert.ok(orbitClearance({ star: { mass: ui }, planet: { mass: design(4), composition: "gas", a: planet.orbit, e: 0 } }).ok, `${ui} 上 ${planet.orbit}`);
      }
    }
  });
});

describe("行星默认画成 0.7 倍（2026-11-26 用户定）", () => {
  it("PLANET_DRAW_SCALE = 0.7：只缩行星的画面半径，主星不缩、物理质量与轨道不变", () => {
    assert.equal(PLANET_DRAW_SCALE, 0.7);
    const planet = { mass: 20, composition: "rock" as const };
    assert.equal(planetDrawRadius(planet), planetRadius(planet) * 0.7);
    assert.equal(starRadius(1000), Math.cbrt(1000 / STAR_DENSITY));
    // 物理层不看画面大小：同一条画面轨道的 AU、容量都与缩放无关
    assert.equal(starPlanetCapacity(1000), 8);
  });

  it("判据用画出来的半径：不落进主星的下限 = 主星半径 + 0.7 × 行星半径 + 间距；画面内缘的倍数按 0.7 推出", () => {
    const planet = { mass: 20, composition: "rock" as const };
    const r = starRadius(600) + planetRadius(planet) * 0.7 + MIN_CLEARANCE;
    assert.deepEqual(orbitClearance({ star: { mass: 600 }, planet: { ...planet, a: r, e: 0 } }), { ok: true });
    assert.equal(orbitClearance({ star: { mass: 600 }, planet: { ...planet, a: r - 0.01, e: 0 } }).ok, false);
    // (1 + 0.7 / 2.16) / sin 40° + 0.2 ≈ 2.26（原大小时是 2.48）
    assert.ok(Math.abs(DRAWN_INNER_PER_STAR_RADIUS - ((1 + 0.7 / 2.16) / Math.sin((40 * Math.PI) / 180) + 0.2)) < 1e-12);
    assert.ok(Math.abs(displayZone(1000).dIn - DRAWN_INNER_PER_STAR_RADIUS * starRadius(1000)) < 1e-12);
  });
});

describe("物理层与画面层：两个数分开", () => {
  it("主星质量：盘上 30–100 M⊕ 读作 0.3–1.0 M☉，算希尔半径时 × 333000 换成 M⊕", () => {
    assert.equal(starSolarMass(300), 0.3);
    assert.equal(starSolarMass(620), 0.62);
    assert.equal(starSolarMass(1000), 1);
    assert.equal(starSolarMass(6000), 1, "越界按最重那档");
    assert.equal(starPhysicalEarth(1000), 333000);
  });

  it("容量表 8 档：0.3→3、0.4→4、0.5→4、0.6→5、0.7→6、0.8→7、0.9→7、1.0→8（1.0 正好是 PLANET_AGENTS_MAX）", () => {
    assert.deepEqual(starMassesEarth.map((massEarth) => starPlanetCapacity(design(massEarth))), [3, 4, 4, 5, 6, 7, 7, 8]);
    assert.equal(starPlanetCapacity(STAR_MASS.max), PLANET_AGENTS_MAX);
    // 半档：0.65 M☉ → 5.5 → 6（整数算，不被浮点舍错）
    assert.equal(starPlanetCapacity(650), 6);
  });

  it("默认轨道：a_in × 1.3^k，物理上按真实比例落在绿区（2 M⊕ 相邻约 11–17 个相互希尔半径）", () => {
    for (let ui = STAR_MASS.min; ui <= STAR_MASS.max; ui += 100) {
      const n = starPlanetCapacity(ui);
      const rungs = Array.from({ length: n }, (_, k) => ladderOrbit(ui, k));
      assert.ok(Math.abs((rungs[0] as { au: number }).au - INNER_ORBIT_AU_AT_SOLAR * starSolarMass(ui) ** 2) < 1e-12);
      for (let k = 1; k < n; k++) {
        const inner = rungs[k - 1] as { au: number };
        const outer = rungs[k] as { au: number };
        assert.ok(Math.abs(outer.au / inner.au - ORBIT_LADDER_RATIO) < 1e-12);
        const gap = pairGapInRH({ mass: 2, a: inner.au, e: 0, omegaDeg: 0 }, { mass: 2, a: outer.au, e: 0, omegaDeg: 0 }, starPhysicalEarth(ui));
        assert.equal(orbitLevel(gap), "green", `${ui / 1000} M☉ 第 ${k} 与 ${k + 1} 档相距 ${gap.toFixed(1)} R_H`);
        assert.ok(gap > 10.5 && gap < 17, `${gap}`);
      }
      // 最外一档仍在物理行星区里，物理行星区外缘对上画面行星区外缘（保底 52）
      const zone = physicalZone(ui);
      assert.ok((rungs[n - 1] as { au: number }).au < zone.aOut);
      assert.ok(Math.abs(auToDisplay(ui, zone.aOut) - PLANET_ZONE) < 1e-9);
      assert.equal(displayZone(ui).dOut, PLANET_ZONE);
    }
  });

  it("映射单调：画面上越外，物理上也越外（含区外的旧值，如落进主星的 4.5、出界的 60）", () => {
    for (let ui = STAR_MASS.min; ui <= STAR_MASS.max; ui += 50) {
      let previous = 0;
      for (let display = 0; display <= 64; display += 0.25) {
        const au = displayToAu(ui, display);
        assert.ok(au > previous, `${ui}: 画面 ${display} → ${au} AU 不比 ${previous} 大`);
        previous = au;
      }
    }
  });

  it("往返恒等：画面 → AU → 画面原样回来（旧 galaxy.json 里的 19、45.5 等）；AU → 画面 → AU 也一样", () => {
    for (let ui = STAR_MASS.min; ui <= STAR_MASS.max; ui += 10) {
      for (const display of [4.5, 11, 19, 25, 26, 30, 31, 38, 43, 45.5, 48, 52]) {
        const back = auToDisplay(ui, displayToAu(ui, display));
        assert.ok(Math.abs(back - display) < 1e-9, `${ui}: ${display} → ${back}`);
        assert.equal(Math.round(back * 100) / 100, display, "按盘上的两位小数原样");
      }
      for (const au of [0.01, 0.1, 0.42, 1, 3]) assert.ok(Math.abs(displayToAu(ui, auToDisplay(ui, au)) / au - 1) < 1e-12);
    }
  });
});
