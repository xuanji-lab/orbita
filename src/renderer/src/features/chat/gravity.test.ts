import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGENT_READABLE_MAX, GALAXY_MAX_FILL, PLANET_MASS, STAR_DENSITY, STAR_MASS, drawFrame, galaxyBox, makeCamera, project, starRadius, type PlanetItem, type StarItem } from "./galaxy.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { homeGalaxyOf } from "./galaxy-data.ts";
import { RED_DWARF, redDwarfDesign, radiusOf } from "../galaxy-designer/design.ts";
import { EARTH_DENSITY, bodyPhysics, massRatio, pitBottom, pitDepth, pitSoftening, ratioText, scanPath, sci, sheetZ, shortNumber, unprojectToPlane, type Well } from "./gravity.ts";
import { binaryGeometry, binaryPhase, binaryPositions, BINARY_ZOOM_MIN } from "./binary.ts";

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

describe("质量卡：数值与单位换算", () => {
  test("地球：10 个界面单位、5.514 g/cm³ → 1 M⊕、5.9722×10²⁴ kg、1 R⊕、6371 km", () => {
    const p = bodyPhysics(10, EARTH_DENSITY);
    assert.ok(p !== null);
    near(p.massEarth, 1);
    near(p.massKg, 5.9722e24);
    near(p.radiusEarth, 1);
    near(p.radiusKm, 6371);
  });
  test("同质量密度降到 1/8：半径翻倍（球的体积 ∝ r³）", () => {
    const a = bodyPhysics(40, 4);
    const b = bodyPhysics(40, 0.5);
    assert.ok(a !== null && b !== null);
    near(b.radiusEarth / a.radiusEarth, 2);
    near(b.radiusKm / a.radiusKm, 2);
  });
  test("R⊕ 与星系里的世界半径只差一个常数倍：相对大小一致", () => {
    const star = bodyPhysics(300, 30);
    const giant = bodyPhysics(30, 1.3);
    assert.ok(star !== null && giant !== null);
    near(giant.radiusEarth / star.radiusEarth, Math.cbrt(30 / 1.3) / starRadius(300, 30));
  });
  test("质量或密度不是正数：不编数", () => {
    assert.equal(bodyPhysics(0, 5), null);
    assert.equal(bodyPhysics(10, Number.NaN), null);
    assert.equal(bodyPhysics(-1, 5), null);
  });
  test("质量比与写法", () => {
    near(massRatio(30, 300), 0.1);
    assert.equal(ratioText(0.1), "1/10");
    assert.equal(ratioText(0.08), "1/12.5");
    assert.equal(ratioText(1.25), "1.25×");
    assert.equal(sci(5.9722e24), "5.97×10²⁴");
    assert.equal(shortNumber(13695.4), "13,695");
    assert.equal(shortNumber(2.149), "2.15");
  });
});

describe("引力扫描：坑深只随质量", () => {
  test("坑深随质量严格单调：主星区间的最轻也比行星区间的最重深", () => {
    const masses = [PLANET_MASS.min, 4, 12, PLANET_MASS.max, STAR_MASS.min, 620, STAR_MASS.max];
    for (let i = 1; i < masses.length; i++) assert.ok(pitDepth(masses[i] as number) > pitDepth(masses[i - 1] as number), `${masses[i]}`);
    assert.ok(pitDepth(STAR_MASS.min) > pitDepth(PLANET_MASS.max));
  });
  test("坑深与半径无关：同质量、宽窄不同的坑底一样深", () => {
    const narrow: Well = { id: "a", x: 0, y: 0, depth: pitDepth(30), soft: pitSoftening(1) };
    const wide: Well = { ...narrow, soft: pitSoftening(4) };
    near(sheetZ(0, 0, [narrow]), sheetZ(0, 0, [wide]));
    near(sheetZ(0, 0, [narrow]), -pitDepth(30));
  });
  test("非数字 / 非正质量：不压坑", () => {
    assert.equal(pitDepth(0), 0);
    assert.equal(pitDepth(Number.NaN), 0);
  });
  test("多个坑直接相加，远处回到平面", () => {
    const wells: Well[] = [
      { id: "s", x: 0, y: 0, depth: 10, soft: 5 },
      { id: "p", x: 20, y: 0, depth: 2, soft: 2 },
    ];
    near(sheetZ(20, 0, wells), -2 - 10 / (1 + 16));
    assert.ok(Math.abs(sheetZ(5000, 5000, wells)) < 1e-3);
  });
  test("网格是一条 path，跟着相机变（转方位角，网格换一个样子）", () => {
    const wells: Well[] = [{ id: "s", x: 0, y: 0, depth: 10, soft: 5 }];
    const vp = { width: 800, height: 500, focal: 900, cx: 400, cy: 250 };
    const a = scanPath(makeCamera(64, 40), vp, wells);
    const b = scanPath(makeCamera(64, 40, undefined, 30), vp, wells);
    assert.match(a, /^M/);
    assert.notEqual(a, b);
  });
});

test("落回平面：精确投影的点落回去是原来那一点（各俯角、方位角）", () => {
  const vp = { width: 800, height: 500, focal: 900, cx: 400, cy: 250 };
  for (const [elev, az] of [[40, 0], [25, 30], [70, -120]] as const) {
    const camera = makeCamera(64, elev, undefined, az);
    for (const p of [{ x: 0, y: 0 }, { x: 30, y: -12 }, { x: -50, y: 44 }]) {
      const q = project({ ...p, z: 0 }, camera);
      const back = unprojectToPlane(vp.cx + vp.focal * q.sx, vp.cy + vp.focal * q.sy, camera, vp);
      assert.ok(back !== null);
      near(back.x, p.x, 1e-6);
      near(back.y, p.y, 1e-6);
    }
  }
});

describe("「大行星浅坑」演示：红矮星 + 气态巨行星", () => {
  const design = redDwarfDesign();
  const galaxy = homeGalaxyOf({ sessions: [], workspaceId: "red-dwarf", stateOf: () => null, now: 0, design });
  test("主星密度跟着设计稿进 spec；默认星系不带这个字段", () => {
    assert.equal(galaxy.spec.starDensity, RED_DWARF.density);
    assert.equal(galaxy.spec.starMass, RED_DWARF.mass);
    assert.equal(starRadius(620), starRadius(620, STAR_DENSITY));
  });
  test("按质量与成分算出的真实半径：巨行星比红矮星大，质量只有它的十分之一", () => {
    const giant = design.planets?.[0];
    assert.ok(giant !== undefined && design.star !== null);
    assert.ok(radiusOf({ ...design, planet: giant }, "planet") > radiusOf(design, "star"));
    near(massRatio(giant.mass, design.star.mass), 0.1);
  });
  test("屏幕安全布局不把它夹小：画出来巨行星确实比主星大，同时坑更浅", () => {
    const width = 1100;
    const height = 640;
    const safe = fitScreenSafe(galaxy.spec, width, height, galaxyBox(width, height, GALAXY_MAX_FILL), 40, AGENT_READABLE_MAX);
    const items = drawFrame({ ...safe.layout, belt: null }, safe.camera, safe.viewport, [], 0, safe.minPlanetPx);
    const star = items.find((item): item is StarItem => item.kind === "star");
    const giant = items.find((item): item is PlanetItem => item.kind === "planet" && item.planetId === "giant");
    const pebble = items.find((item): item is PlanetItem => item.kind === "planet" && item.planetId === "pebble");
    assert.ok(star !== undefined && giant !== undefined && pebble !== undefined);
    assert.ok(giant.r > star.r * 1.1, `巨行星 ${giant.r.toFixed(1)}px 应比主星 ${star.r.toFixed(1)}px 大`);
    // 坑：三颗各压一个，坑深按质量；巨行星的坑比主星浅，小岩质行星最浅
    const starPit = pitDepth(galaxy.spec.starMass);
    const giantPit = pitDepth(galaxy.spec.planets.find((p) => p.id === "giant")?.mass ?? 0);
    const pebblePit = pitDepth(galaxy.spec.planets.find((p) => p.id === "pebble")?.mass ?? 0);
    assert.ok(starPit > giantPit && giantPit > pebblePit);
    // 画出来的坑底：同一张网格上各自坑底比所在处平面沉多少（只看自己的坑）——主星沉得最多
    const camera = safe.camera;
    const vp = safe.viewport;
    const sWell: Well = { id: "star", x: 0, y: 0, depth: starPit, soft: pitSoftening(star.r) };
    const gWell: Well = { id: "giant", x: 30, y: 0, depth: giantPit, soft: pitSoftening(giant.r) };
    const sink = (well: Well): number => pitBottom(camera, vp, well, [well]).y - pitBottom(camera, vp, { ...well, depth: 0 }, [{ ...well, depth: 0 }]).y;
    assert.ok(sink(sWell) > sink(gWell), `主星坑底下沉 ${sink(sWell).toFixed(1)}px 应大于巨行星 ${sink(gWell).toFixed(1)}px`);
  });
});

describe("联星：质心与几何", () => {
  test("质心按质量比：m₁·r₁ = m₂·r₂，r₁ + r₂ = 间距，重的离质心近", () => {
    const geo = binaryGeometry(800, 400, 60, 6);
    near(800 * geo.r1, 400 * geo.r2);
    near(geo.r1 + geo.r2, geo.sep);
    assert.ok(geo.r1 < geo.r2);
  });
  test("伴星整颗在这座星系外缘之外；画面缩放有下限", () => {
    const geo = binaryGeometry(620, 620, 64, 8);
    assert.ok(geo.sep - 8 > 64);
    assert.ok(geo.zoom >= BINARY_ZOOM_MIN && geo.zoom <= 1);
  });
  test("任一时刻两星在质心两侧、连线过质心", () => {
    const geo = binaryGeometry(500, 300, 50, 5);
    for (const t of [0, 37, 600]) {
      const { self, companion } = binaryPositions(geo, 0.7, t);
      near(500 * self.x + 300 * companion.x, 0, 1e-6);
      near(500 * self.y + 300 * companion.y, 0, 1e-6);
      near(Math.hypot(companion.x - self.x, companion.y - self.y), geo.sep, 1e-9);
    }
  });
  test("两边看到的是同一对星：相位差 π，与谁先打开无关", () => {
    const a = binaryPhase("ws-a", "ws-b");
    const b = binaryPhase("ws-b", "ws-a");
    near(Math.abs(b - a), Math.PI);
  });
});
