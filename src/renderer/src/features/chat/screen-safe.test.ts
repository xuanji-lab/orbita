import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GALAXY_TILT } from "../../../../shared/settings.ts";

const TILT: number = GALAXY_TILT.default;
import {
  drawFrame,
  dustLookOf,
  dustPoints,
  galaxyBox,
  GALAXY_MAX_FILL,
  orbitArcs,
  orbitFrame,
  framePoint,
  planetPx,
  starRadius,
  AGENT_READABLE_MAX,
  PLANET_READABLE_MAX,
  STAR_OVER_PLANET,
  WAITING_SCALE,
  type GalaxySpec,
  type PlanetItem,
  type RockItem,
  type StarItem,
  VISIBLE_ORBIT_CAP,
} from "./galaxy.ts";
import { orbitRadiusOf } from "./galaxy-data.ts";
import { AGENT_READABLE_FLOOR, ROCK_CLEAR_PX, bodyGapOf, curveGap, fitScreenSafe } from "./screen-safe.ts";
import { FAR_MARGIN } from "./galaxy-motion.ts";
import { lockFrame } from "./callouts.ts";

/** 原单智能体首页的三档写死 fixture 的形状（产品里已不用，测试里保留这几种形状） */
function galaxySpecOf(fixture: "empty" | "typical" | "full"): GalaxySpec {
  if (fixture === "empty") return { starMass: 620, planets: [], sessions: 0 };
  const typical = [
    { id: "p1", mass: 2.4, composition: "rock" as const, orbitRadius: 17, inclinationDeg: 4.5, nodeDeg: 20, phaseDeg: 200 },
    { id: "p2", mass: 14, composition: "gas" as const, orbitRadius: 27, inclinationDeg: -3, nodeDeg: 140, phaseDeg: 320 },
    { id: "p3", mass: 4, composition: "ice" as const, orbitRadius: 38, inclinationDeg: 6, nodeDeg: 260, phaseDeg: 70 },
    { id: "p4", mass: 7, composition: "rock" as const, orbitRadius: 50, inclinationDeg: -4.5, nodeDeg: 80, phaseDeg: 150 },
  ];
  if (fixture === "typical") return { starMass: 620, planets: typical, sessions: 14 };
  return {
    starMass: 620,
    sessions: 2000,
    planets: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i + 1}`,
      mass: [2, 9, 3.5, 22, 5, 1.6, 30, 6, 12, 2.8, 18, 4][i] ?? 3,
      composition: (["rock", "gas", "ice"] as const)[(i * 7) % 3] ?? "rock",
      orbitRadius: 15 + i * 9.5 + i * i * 0.35,
      inclinationDeg: (((i * 37) % 13) - 6) * 0.9,
      nodeDeg: (i * 83) % 360,
      phaseDeg: (i * 137) % 360,
    })),
  };
}

/**
 * 「表情可读」（行星 ≥ AGENT_READABLE_FLOOR）保证到几颗：今晚六个真实工作区的子智能体都是 2–3 颗。
 * 更多颗、画布又小时，子智能体照样全部画出、不相撞，但会缩到可读下限以下（最小 4px）——不藏行星优先于表情可读
 */
const READABLE_UP_TO = 3;
/** 再小的画布（窄窗 + 右栏 196×214 那块）只对普通质量的三颗保证可读；最重的三颗会缩一点 */
const READABLE_MIN_SIDE = 260;
function readableBound(spec: GalaxySpec, w = Infinity, h = Infinity): boolean {
  return spec.planets.length <= READABLE_UP_TO && (Math.min(w, h) >= READABLE_MIN_SIDE || (Math.min(w, h) >= 190 && spec.planets.every((p) => p.mass <= 30)));
}

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

/**
 * 编排星系（行星 = 子智能体、会话 = 碎石）：几颗子智能体照设计稿的质量与轨道，在做事的会话是碎石块。
 * 质量单位 = M⊕ × 10（今晚六个工作区：主星 35–90 M⊕，行星 1.1–3.4 M⊕）
 */
function agentSpec(starMass: number, agents: readonly [number, "rock" | "ice" | "gas", number][], rocks: number, waitingRocks = 0, sessions = 120): GalaxySpec {
  return {
    starMass,
    sessions,
    planets: agents.map(([mass, composition, orbitRadius], i) => ({
      id: `a${i}`,
      mass,
      composition,
      orbitRadius,
      inclinationDeg: ((i * 37) % 11) - 5,
      nodeDeg: (i * 83) % 360,
      phaseDeg: (i * 137) % 360,
      state: null,
    })),
    rocks: Array.from({ length: rocks }, (_, i) => ({ id: `s${i}`, state: i < waitingRocks ? ("waiting" as const) : ("running" as const), label: `会话 ${i}` })),
  };
}

const AGENT_SPECS: [string, GalaxySpec][] = [
  ["意图系统（烛霓 60 + 三颗，2 块碎石在做事）", agentSpec(600, [[22, "rock", 19], [30, "rock", 31], [16, "rock", 43]], 2, 1)],
  ["游戏灵感（最轻主星 35 + 两颗）", agentSpec(350, [[20, "rock", 19], [11, "ice", 31]], 1)],
  ["空（只有主星与子智能体，没有在做事的会话）", agentSpec(900, [[34, "rock", 19], [20, "rock", 31], [28, "rock", 43]], 0)],
  ["满载（6 颗子智能体 + 8 块碎石，3 块等你）", agentSpec(620, [[40, "gas", 19], [34, "rock", 25], [11, "ice", 31], [22, "rock", 37], [16, "ice", 43], [30, "gas", 49]], 8, 3)],
  ["满载 · 最轻主星 6 颗最重行星", agentSpec(300, Array.from({ length: 6 }, (_, i): [number, "gas", number] => [40, "gas", 19 + 6 * i]), 6, 2)],
  ["只有 3 条会话（碎石带最窄）", agentSpec(600, [[22, "rock", 19], [30, "rock", 31], [16, "rock", 43]], 1, 0, 3)],
  ["450 条会话（满载 orbita）", agentSpec(620, [[40, "gas", 19], [34, "rock", 25], [11, "ice", 31], [22, "rock", 37]], 8, 3, 450)],
  ["3000 条会话（碎石带铺到画框外沿）", agentSpec(620, [[40, "gas", 19], [34, "rock", 25], [11, "ice", 31], [22, "rock", 37], [16, "ice", 43], [30, "gas", 49]], 8, 3, 3000)],
];

function collisions(spec: GalaxySpec, w: number, h: number, readableMax: number = PLANET_READABLE_MAX, tilt: number = TILT, tStep = 3.7, azimuth = 0): string[] {
  const box = galaxyBox(w, h, GALAXY_MAX_FILL);
  // 与 HomeGalaxy 的工作区页一样：每条会话都是一颗碎石（不封顶）
  const scene = fitScreenSafe({ ...spec }, w, h, box, tilt, readableMax, azimuth);
  const arcs = orbitArcs(scene.layout, scene.camera, scene.viewport);
  const extent = Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass);
  const problems: string[] = [];
  for (let t = 0; t <= 600; t += tStep) {
    const items = drawFrame(scene.layout, scene.camera, scene.viewport, arcs, t, scene.minPlanetPx);
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
    // 碎石块（在做事的会话）：不碰任何行星，不画在主星上面，彼此不碰
    const rocks = items.filter((item): item is RockItem => item.kind === "rock");
    for (const rock of rocks) {
      for (const p of planets) {
        const d = Math.hypot(rock.x - p.x, rock.y - p.y);
        if (d < rock.r + p.r) problems.push(`t=${t.toFixed(1)} 碎石 ${rock.planetId} 与 ${p.planetId} 相交（${d.toFixed(1)}）`);
      }
      if (star !== undefined) {
        const d = Math.hypot(rock.x - star.x, rock.y - star.y);
        if (d < star.r * extent + rock.r && (order.get(rock.key) ?? 0) > (order.get(star.key) ?? 0)) problems.push(`t=${t.toFixed(1)} 碎石 ${rock.planetId} 画在主星上面`);
      }
    }
    for (let i = 0; i < rocks.length; i++) {
      for (let j = i + 1; j < rocks.length; j++) {
        const a = rocks[i] as RockItem;
        const b = rocks[j] as RockItem;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) problems.push(`t=${t.toFixed(1)} 碎石 ${a.planetId} 与 ${b.planetId} 相交`);
      }
    }
    // 碎石带（每条会话一颗）：每颗都不压任何行星，也不画在主星上面
    const belt = scene.layout.belt;
    if (belt !== null) {
      const px = dustLookOf(belt.count).px;
      for (const dot of dustPoints(belt, scene.camera, scene.viewport, t)) {
        for (const p of planets) {
          const d = Math.hypot(dot.x - p.x, dot.y - p.y);
          if (d < px + p.r) problems.push(`t=${t.toFixed(1)} 碎石带的一颗 ${dot.id} 压在 ${p.planetId} 上（${d.toFixed(1)} < ${(px + p.r).toFixed(1)}）`);
        }
        if (star !== undefined && !dot.far && Math.hypot(dot.x - star.x, dot.y - star.y) < star.r * extent + px) problems.push(`t=${t.toFixed(1)} 碎石带的一颗画在主星上面`);
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

  test("轨道一律放平、由内到外；行星不少画（只有 6 圈上限之外的计进 hidden）；俯角不低于设置值", () => {
    const spec = realistic(9, 3);
    const box = galaxyBox(336, 269, GALAXY_MAX_FILL);
    const scene = fitScreenSafe(spec, 336, 269, box, TILT);
    assert.ok(scene.elevationDeg >= TILT);
    for (const planet of scene.layout.planets) assert.equal(planet.inclination, 0);
    const radii = scene.layout.planets.map((planet) => planet.orbitRadius);
    for (let i = 1; i < radii.length; i++) assert.ok((radii[i] ?? 0) > (radii[i - 1] ?? 0));
    assert.equal(scene.layout.planets.length, VISIBLE_ORBIT_CAP);
    assert.equal(scene.dropped, 0);
  });
});

describe("编排星系（行星 = 子智能体、会话 = 碎石）：屏幕上照样不相撞，行星大到表情看得清，主星明显最大", () => {
  for (const [specName, spec] of AGENT_SPECS) {
    for (const [canvasName, w, h] of CANVASES) {
      test(`${specName} × ${canvasName}（${w}×${h}）`, () => {
        const problems = collisions(spec, w, h, AGENT_READABLE_MAX);
        assert.deepEqual(problems.slice(0, 5), [], `${problems.length} 处相交`);
      });
    }
  }

  // 默认画法（页面装得下时）主星仍比行星大一截；这不是铁律（质量的高低才是，2026-11-24 用户），窄画布装不下时允许主星画得比行星小
  test("页面上：行星可读半径比旧星系大一档，主星屏幕半径 ≥ 最大行星（等你放大后）的 STAR_OVER_PLANET 倍", () => {
    for (const [, spec] of AGENT_SPECS) {
      for (const [canvasName, w, h] of CANVASES.slice(0, 2)) {
        const box = galaxyBox(w, h, GALAXY_MAX_FILL);
        const scene = fitScreenSafe(spec, w, h, box, TILT, AGENT_READABLE_MAX);
        const items = drawFrame(scene.layout, scene.camera, scene.viewport, orbitArcs(scene.layout, scene.camera, scene.viewport), 0, scene.minPlanetPx);
        const star = items.find((item): item is StarItem => item.kind === "star");
        const biggest = Math.max(...items.filter((item): item is PlanetItem => item.kind === "planet").map((p) => p.r), 0);
        assert.ok(star !== undefined && star.r >= biggest * STAR_OVER_PLANET * 0.99, `${canvasName}: 主星 ${star?.r.toFixed(1)} 行星 ${biggest.toFixed(1)}`);
        if (canvasName === "页面" && spec.planets.length <= READABLE_UP_TO) assert.ok(scene.minPlanetPx > PLANET_READABLE_MAX, `页面上的行星可读半径 ${scene.minPlanetPx.toFixed(1)}`);
      }
    }
    assert.ok(WAITING_SCALE > 1);
  });
});

/**
 * 窄窗（2026-11-24 设计审查 R3 / R8，ann-2：1024×720 的窗口开着右栏，New Task 页的星系只剩约 200px 宽）：
 * 宁可少画外圈、把碎石块归进角上那一行字，也要保住——行星表情可读、碎石永远小于行星、锁定框不压别的天体、天体都在画布里。
 */
const NARROW_CANVASES = [
  ["窄窗页面 + 右栏（ann-2）", 196, 214],
  ["窄窗页面 + 右栏 · 矮", 240, 160],
  ["窄窗页面", 560, 420],
  ["右栏最窄", 336, 269],
  ["页面（宽窗，ann-1 的琉璃）", 1088, 726],
] as const;

describe("编排星系 · 窄窗：行星可读、碎石小于行星、锁定框不压天体、天体不出画", () => {
  for (const [specName, spec] of AGENT_SPECS) {
    for (const [canvasName, w, h] of NARROW_CANVASES) {
      test(`${specName} × ${canvasName}（${w}×${h}）`, () => {
        const box = galaxyBox(w, h, GALAXY_MAX_FILL);
        const scene = fitScreenSafe(spec, w, h, box, TILT, AGENT_READABLE_MAX);
        const arcs = orbitArcs(scene.layout, scene.camera, scene.viewport);
        const problems: string[] = [];
        for (let t = 0; t <= 600; t += 7.3) {
          const items = drawFrame(scene.layout, scene.camera, scene.viewport, arcs, t, scene.minPlanetPx);
          const star = items.find((item): item is StarItem => item.kind === "star");
          const planets = items.filter((item): item is PlanetItem => item.kind === "planet");
          const rocks = items.filter((item): item is RockItem => item.kind === "rock");
          for (const p of planets) {
            // 近侧（画在主星前面）的行星离主星轮廓至少半个行星半径（R8：屏上近相切）
            if (star !== undefined && p.depth < star.depth) {
              const gap = Math.hypot(p.x - star.x, p.y - star.y) - star.r * (Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass)) - p.r;
              if (gap < bodyGapOf(scene.minPlanetPx) - 0.6) problems.push(`t=${t.toFixed(1)} ${p.planetId} 离主星只有 ${gap.toFixed(1)}px`);
            }
            if (readableBound(spec, w, h) && p.r < AGENT_READABLE_FLOOR - 0.01) problems.push(`t=${t.toFixed(1)} ${p.planetId} 半径 ${p.r.toFixed(1)} < ${AGENT_READABLE_FLOOR}`);
            if (p.x - p.r < 0 || p.x + p.r > w || p.y - p.r < 0 || p.y + p.r > h) problems.push(`t=${t.toFixed(1)} ${p.planetId} 出画`);
          }
          if (planets.length !== Math.min(spec.planets.length, VISIBLE_ORBIT_CAP)) problems.push(`只画了 ${planets.length} 颗子智能体（设计稿 ${spec.planets.length} 颗）`);
          for (const p of planets) {
          }
          for (const rock of rocks) {
            const smallest = Math.min(...planets.map((p) => p.r));
            if (planets.length > 0 && rock.r >= smallest) problems.push(`t=${t.toFixed(1)} 碎石 ${rock.r.toFixed(1)} 不小于行星 ${smallest.toFixed(1)}`);
            // 锁定框（以碎石为中心的方框，半边 = r + LOCK_GAP）不压任何行星；整个框在画布里
            const { half } = lockFrame(rock.r);
            for (const p of planets) {
              const dx = Math.max(Math.abs(rock.x - p.x) - half, 0);
              const dy = Math.max(Math.abs(rock.y - p.y) - half, 0);
              if (Math.hypot(dx, dy) < p.r) problems.push(`t=${t.toFixed(1)} 碎石 ${rock.planetId} 的锁定框压在 ${p.planetId} 上`);
            }
            if (rock.x - half < 0 || rock.x + half > w || rock.y - half < 0 || rock.y + half > h) problems.push(`t=${t.toFixed(1)} 碎石 ${rock.planetId} 的锁定框出画`);
          }
        }
        assert.deepEqual(problems.slice(0, 5), [], `${problems.length} 处`);
      });
    }
  }

  test("ann-2 那块画布：设计稿里的子智能体一颗不少；三颗以内表情可读；锁定框让开的距离按框算，不按石头算", () => {
    const box = galaxyBox(196, 214, GALAXY_MAX_FILL);
    for (const [, spec] of [AGENT_SPECS[0], AGENT_SPECS[3]] as [string, GalaxySpec][]) {
      for (const eccentricity of [0, 0.3]) {
        const scene = fitScreenSafe({ ...spec, eccentricity }, 196, 214, box, TILT, AGENT_READABLE_MAX);
        assert.equal(scene.layout.planets.length, spec.planets.length, `e=${eccentricity} 只剩 ${scene.layout.planets.length} 颗`);
        if (readableBound(spec, 196, 214)) assert.ok(scene.minPlanetPx >= AGENT_READABLE_FLOOR - 0.01, `e=${eccentricity} 行星 ${scene.minPlanetPx.toFixed(1)}px`);
      }
    }
    assert.ok(ROCK_CLEAR_PX > 4.5);
  });
});

/**
 * 开普勒椭圆（2026-11-24 用户：「这个轨道不够椭圆」）：主星在焦点上，所有轨道共用偏心率与近日点方向。
 * 两颗行星周期不同，迟早会出现任意一对相位——所以不只按时间抽样，还把相邻两圈的相位两两组合扫一遍（含近日点那一侧最挤的地方）。
 */
const ECCS = [0.15, 0.3, 0.45] as const;
const PHASES = 240;

function sweepProblems(spec: GalaxySpec, w: number, h: number, ecc: number, tilt: number = TILT, phases: number = PHASES): string[] {
  const box = galaxyBox(w, h, GALAXY_MAX_FILL);
  const scene = fitScreenSafe({ ...spec, eccentricity: ecc }, w, h, box, tilt, AGENT_READABLE_MAX);
  const { layout, camera, viewport } = scene;
  const problems: string[] = [];
  if (layout.ecc > ecc || layout.ecc < 0) problems.push(`偏心率不对：${layout.ecc}`);
  const star = drawFrame({ ...layout, belt: null }, camera, viewport, [], 0, scene.minPlanetPx).find((item): item is StarItem => item.kind === "star");
  if (star === undefined) return ["没有主星"];
  const starReach = star.r * (Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass));
  // 每条轨道（行星 + 碎石块那一圈）在一圈相位上的屏幕位置与半径
  const rings = layout.planets.map((planet) => {
    const frame = orbitFrame(planet.orbitRadius, 0, 0, camera, viewport, layout.ecc);
    const r = planetPx(planet.radius, planet.state === "waiting", camera, viewport, scene.minPlanetPx);
    return { id: planet.id, r, points: Array.from({ length: phases }, (_, i) => framePoint(frame, (i / phases) * Math.PI * 2)) };
  });
  if (layout.rockOrbit !== null && layout.rocks.length > 0) {
    const frame = orbitFrame(layout.rockOrbit, 0, 0, camera, viewport, layout.ecc);
    rings.push({ id: "碎石块", r: ROCK_CLEAR_PX, points: Array.from({ length: phases }, (_, i) => framePoint(frame, (i / phases) * Math.PI * 2)) });
  }
  for (const ring of rings) {
    // 画在主星前面那一段（不在远层）不碰主星
    ring.points.forEach((p, i) => {
      const theta = (i / phases) * Math.PI * 2;
      if (theta > FAR_MARGIN && theta < Math.PI - FAR_MARGIN) return;
      const d = Math.hypot(p.x - star.x, p.y - star.y);
      if (d < starReach + ring.r) problems.push(`${ring.id} 在相位 ${((theta * 180) / Math.PI).toFixed(0)}° 压在主星上（${d.toFixed(1)} < ${(starReach + ring.r).toFixed(1)}）`);
    });
  }
  // 相邻两圈：任意一对相位都不相交（行星之间、最外行星与碎石块的锁定框之间）
  for (let k = 1; k < rings.length; k++) {
    const a = rings[k - 1];
    const b = rings[k];
    if (a === undefined || b === undefined) continue;
    let best = Infinity;
    let at = "";
    for (let i = 0; i < phases; i++) {
      const p = a.points[i] as { x: number; y: number };
      for (let j = 0; j < phases; j++) {
        const q = b.points[j] as { x: number; y: number };
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) {
          best = d;
          at = `${((i / phases) * 360).toFixed(0)}°/${((j / phases) * 360).toFixed(0)}°`;
        }
      }
    }
    if (best < a.r + b.r) problems.push(`${a.id} 与 ${b.id} 在相位 ${at} 相交（${best.toFixed(1)} < ${(a.r + b.r).toFixed(1)}）`);
  }
  return problems;
}

describe("开普勒椭圆：主星在焦点上，三档偏心率下任何一对相位都不相撞、不压主星", () => {
  for (const ecc of ECCS) {
    for (const [specName, spec] of AGENT_SPECS) {
      for (const [canvasName, w, h] of [...CANVASES, ...NARROW_CANVASES.slice(0, 2)]) {
        test(`e=${ecc} · ${specName} × ${canvasName}（${w}×${h}）`, () => {
          const swept = sweepProblems(spec, w, h, ecc);
          assert.deepEqual(swept.slice(0, 5), [], `${swept.length} 处（相位两两组合）`);
          const timed = collisions({ ...spec, eccentricity: ecc }, w, h, AGENT_READABLE_MAX);
          assert.deepEqual(timed.slice(0, 5), [], `${timed.length} 处（按时间抽样，含碎石带）`);
        });
      }
    }
  }

  test("宽画布上偏心率原样生效；小画布排不下时偏心率往下退；椭圆与正圆都不少画子智能体", () => {
    for (const [, spec] of AGENT_SPECS) {
      for (const [canvasName, w, h] of [...CANVASES, ...NARROW_CANVASES]) {
        const box = galaxyBox(w, h, GALAXY_MAX_FILL);
        const round = fitScreenSafe(spec, w, h, box, TILT, AGENT_READABLE_MAX);
        const kepler = fitScreenSafe({ ...spec, eccentricity: 0.3 }, w, h, box, TILT, AGENT_READABLE_MAX);
        assert.equal(kepler.layout.planets.length, Math.min(spec.planets.length, VISIBLE_ORBIT_CAP), `${canvasName}: 椭圆少画了`);
        assert.equal(round.layout.planets.length, Math.min(spec.planets.length, VISIBLE_ORBIT_CAP), `${canvasName}: 正圆少画了`);
        // 三颗以内（真实工作区的量）宽画布上偏心率原样；六颗满载时宽画布也可能先退偏心率、不抬俯角
        if (canvasName === "页面" && spec.planets.length <= READABLE_UP_TO) assert.equal(kepler.layout.ecc, 0.3, "宽画布上偏心率被退了");
      }
    }
  });

  test("近日点那一侧确实是最挤的：相邻两圈的最近距离出现在近日点附近（|相位| < 90°），且比正圆时的同一对更近", () => {
    const [, spec] = AGENT_SPECS[3] as [string, GalaxySpec];
    const box = galaxyBox(1088, 726, GALAXY_MAX_FILL);
    const scene = fitScreenSafe({ ...spec, eccentricity: 0.45 }, 1088, 726, box, TILT, AGENT_READABLE_MAX);
    const [inner, outer] = scene.layout.planets;
    assert.ok(inner !== undefined && outer !== undefined);
    const fa = orbitFrame(inner.orbitRadius, 0, 0, scene.camera, scene.viewport, 0.45);
    const fb = orbitFrame(outer.orbitRadius, 0, 0, scene.camera, scene.viewport, 0.45);
    let best = Infinity;
    let bestTheta = 0;
    for (let i = 0; i < 360; i++) {
      const theta = (i / 360) * Math.PI * 2;
      const p = framePoint(fa, theta);
      for (let j = 0; j < 360; j++) {
        const q = framePoint(fb, (j / 360) * Math.PI * 2);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) {
          best = d;
          bestTheta = theta;
        }
      }
    }
    assert.ok(Math.cos(bestTheta) > 0, `最近处在相位 ${((bestTheta * 180) / Math.PI).toFixed(0)}°，不在近日点一侧`);
    assert.ok(Math.abs(curveGap(fa, 1, fb, 1) - best) < 1.5, `curveGap ${curveGap(fa, 1, fb, 1).toFixed(2)} 与穷举 ${best.toFixed(2)} 对不上`);
  });

  test("主星不在画框中心：偏在近日点（右）一侧，偏移随偏心率变大；同一偏心率下空 / 平常 / 满载主星同位同大", () => {
    const xs = ECCS.map((ecc) => {
      const scenes = [AGENT_SPECS[2], AGENT_SPECS[0], AGENT_SPECS[5]].map((entry) => {
        const [, spec] = entry as [string, GalaxySpec];
        const box = galaxyBox(1088, 726, GALAXY_MAX_FILL);
        const scene = fitScreenSafe({ ...spec, eccentricity: ecc }, 1088, 726, box, TILT, AGENT_READABLE_MAX);
        const star = drawFrame({ ...scene.layout, belt: null }, scene.camera, scene.viewport, [], 0, scene.minPlanetPx).find((item): item is StarItem => item.kind === "star");
        return star?.x ?? 0;
      });
      return scenes;
    });
    for (const row of xs) assert.ok((row[0] ?? 0) > 1088 / 2 + 5, `主星 x=${row[0]?.toFixed(1)}`);
    // 0.15 → 0.3 主星往近日点一侧挪；0.45 在满的星系里会退回 0.3（见上一条），所以只要求不往回
    assert.ok((xs[0]?.[0] ?? 0) < (xs[1]?.[0] ?? 0) && (xs[1]?.[0] ?? 0) <= (xs[2]?.[0] ?? 0));
    for (const row of xs.slice(0, 2)) assert.ok(Math.max(...row) - Math.min(...row) < 0.5, `空 / 平常 / 满载主星不同位：${row.map((x) => x.toFixed(1)).join(" ")}`);
  });
});

/**
 * 星系倾角是设置项（10°–60°，步长 5°，2026-11-24）：每一档都要守「不相撞、不压主星」——宽窗、窄窗、右栏三块画布 × 偏心率三档 × 编排星系各形状。
 * 布局不改用户选的俯角，装不下就少画外圈。
 */
// 存盘精度是 1°（拖动无极），这里每 5° 取样（与原来的档位同一组，测试时长不变）
const TILTS = Array.from({ length: (GALAXY_TILT.max - GALAXY_TILT.min) / 5 + 1 }, (_, i) => GALAXY_TILT.min + i * 5);
const TILT_CANVASES = [
  ["宽窗页面", 1088, 726],
  ["单智能体首页那条带子", 1000, 330],
  ["窄窗页面", 560, 420],
  ["右栏", 416, 333],
  ["窄窗 + 右栏（ann-2）", 196, 214],
] as const;

describe("星系倾角 10°–60°（每 5° 一档）× 三块画布 × 偏心率三档：子智能体一颗不少、不相撞、不压主星；三颗以内表情可读；俯角不低于设置", () => {
  for (const tilt of TILTS) {
    for (const ecc of ECCS) {
      test(`${tilt}° · e=${ecc}`, () => {
        const problems: string[] = [];
        for (const [specName, spec] of AGENT_SPECS) {
          for (const [canvasName, w, h] of TILT_CANVASES) {
            const box = galaxyBox(w, h, GALAXY_MAX_FILL);
            const scene = fitScreenSafe({ ...spec, eccentricity: ecc }, w, h, box, tilt, AGENT_READABLE_MAX);
            if (scene.elevationDeg < tilt) problems.push(`${specName} × ${canvasName}：俯角被压低成 ${scene.elevationDeg}`);
            if (scene.layout.planets.length !== Math.min(spec.planets.length, VISIBLE_ORBIT_CAP)) problems.push(`${specName} × ${canvasName}：只画了 ${scene.layout.planets.length} 颗`);
            if (readableBound(spec, w, h) && scene.minPlanetPx < AGENT_READABLE_FLOOR - 0.01) problems.push(`${specName} × ${canvasName}：行星 ${scene.minPlanetPx.toFixed(1)}px 不可读`);
            if (scene.minPlanetPx < 2.5 - 1e-9) problems.push(`${specName} × ${canvasName}：行星 ${scene.minPlanetPx.toFixed(1)}px`);
            for (const p of sweepProblems(spec, w, h, ecc, tilt, 90).slice(0, 2)) problems.push(`${specName} × ${canvasName}：${p}`);
            for (const p of collisions({ ...spec, eccentricity: ecc }, w, h, AGENT_READABLE_MAX, tilt, 37).slice(0, 2)) problems.push(`${specName} × ${canvasName}：${p}`);
          }
        }
        assert.deepEqual(problems.slice(0, 6), [], `${problems.length} 处`);
      });
    }
  }
});

describe("极端输入下布局有界、够快", () => {
  test("6 颗最重行星 × 196×214 × e=0.45 × 10°：50ms 内返回，子智能体一颗不少、不相撞", () => {
    const [, spec] = AGENT_SPECS[4] as [string, GalaxySpec];
    const box = galaxyBox(196, 214, GALAXY_MAX_FILL);
    fitScreenSafe({ ...spec, eccentricity: 0.45 }, 196, 214, box, 10, AGENT_READABLE_MAX); // 预热 JIT
    const t0 = performance.now();
    const scene = fitScreenSafe({ ...spec, eccentricity: 0.45 }, 196, 214, box, 10, AGENT_READABLE_MAX);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${ms.toFixed(1)}ms`);
    assert.equal(scene.layout.planets.length, 6);
    assert.deepEqual(sweepProblems(spec, 196, 214, 0.45, 10, 90).slice(0, 3), []);
  });
});

describe("转台（方位角）：转到任何方向、松手后的屏幕安全布局里天体照样不相撞", () => {
  const canvases = [
    ["页面", 1088, 726],
    ["单智能体带子", 1000, 330],
    ["右栏宽", 416, 333],
  ] as const;
  for (const [specName, spec] of AGENT_SPECS.slice(0, 4)) {
    for (const [canvasName, w, h] of canvases) {
      test(`${specName} × ${canvasName}`, () => {
        const problems: string[] = [];
        for (const tilt of [10, 25, 40, 60]) {
          for (const azimuth of [45, 90, 135, 200, 300]) {
            for (const eccentricity of [0, 0.3, 0.45]) {
              const found = collisions({ ...spec, eccentricity }, w, h, AGENT_READABLE_MAX, tilt, 11.3, azimuth);
              if (found.length > 0) problems.push(`俯角 ${tilt}° 方位 ${azimuth}° e=${eccentricity}：${found[0]}（共 ${found.length} 处）`);
            }
          }
        }
        assert.deepEqual(problems.slice(0, 5), [], `${problems.length} 种组合有相交`);
      });
    }
  }
});

describe("转台：转方位角不把行星缩小（近日点朝向镜头时先把椭圆放圆一档）", () => {
  test("意图系统 · 编排页宽窗 1040×722 · 俯角 40°：每 15° 一个方位，行星屏幕半径都与方位 0 时一样大", () => {
    const spec = { ...(AGENT_SPECS[0]?.[1] as GalaxySpec), eccentricity: 0.3 };
    const box = galaxyBox(1040, 722, GALAXY_MAX_FILL);
    const base = fitScreenSafe(spec, 1040, 722, box, 40, AGENT_READABLE_MAX, 0);
    for (let azimuth = 0; azimuth < 360; azimuth += 15) {
      const scene = fitScreenSafe(spec, 1040, 722, box, 40, AGENT_READABLE_MAX, azimuth);
      assert.ok(scene.minPlanetPx >= base.minPlanetPx - 0.75, `方位 ${azimuth}°：${scene.minPlanetPx.toFixed(1)}px < ${base.minPlanetPx.toFixed(1)}px`);
      assert.ok(scene.layout.ecc > 0, `方位 ${azimuth}°：椭圆放圆了也不该变成正圆（${scene.layout.ecc}）`);
    }
  });
});
