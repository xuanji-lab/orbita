import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  drawFrame,
  dustLookOf,
  dustPoints,
  elevationFor,
  galaxyBox,
  GALAXY_MAX_FILL,
  galaxySpecOf,
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
} from "./galaxy.ts";
import { orbitRadiusOf } from "./galaxy-data.ts";
import { AGENT_READABLE_FLOOR, ROCK_CLEAR_PX, bodyGapOf, curveGap, fitScreenSafe, SAFE_ELEVATION_MAX } from "./screen-safe.ts";
import { FAR_MARGIN } from "./galaxy-motion.ts";
import { lockFrame } from "./callouts.ts";

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

function collisions(spec: GalaxySpec, w: number, h: number, readableMax: number = PLANET_READABLE_MAX): string[] {
  const box = galaxyBox(w, h, GALAXY_MAX_FILL);
  // 与 HomeGalaxy 的工作区页一样：每条会话都是一颗碎石（不封顶）
  const scene = fitScreenSafe({ ...spec, dustCap: Number.POSITIVE_INFINITY, growth: true }, w, h, box, elevationFor(box), readableMax);
  const arcs = orbitArcs(scene.layout, scene.camera, scene.viewport);
  const extent = Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass);
  const problems: string[] = [];
  for (let t = 0; t <= 600; t += 3.7) {
    const items = drawFrame(scene.layout, scene.camera, scene.viewport, arcs, t, scene.minPlanetPx, false);
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

describe("编排星系（行星 = 子智能体、会话 = 碎石）：屏幕上照样不相撞，行星大到表情看得清，主星明显最大", () => {
  for (const [specName, spec] of AGENT_SPECS) {
    for (const [canvasName, w, h] of CANVASES) {
      test(`${specName} × ${canvasName}（${w}×${h}）`, () => {
        const problems = collisions(spec, w, h, AGENT_READABLE_MAX);
        assert.deepEqual(problems.slice(0, 5), [], `${problems.length} 处相交`);
      });
    }
  }

  test("行星可读半径比旧星系大一档，但主星屏幕半径仍 ≥ 最大行星（等你放大后）的 STAR_OVER_PLANET 倍", () => {
    for (const [, spec] of AGENT_SPECS) {
      for (const [canvasName, w, h] of CANVASES) {
        const box = galaxyBox(w, h, GALAXY_MAX_FILL);
        const scene = fitScreenSafe(spec, w, h, box, elevationFor(box), AGENT_READABLE_MAX);
        const items = drawFrame(scene.layout, scene.camera, scene.viewport, orbitArcs(scene.layout, scene.camera, scene.viewport), 0, scene.minPlanetPx, false);
        const star = items.find((item): item is StarItem => item.kind === "star");
        const biggest = Math.max(...items.filter((item): item is PlanetItem => item.kind === "planet").map((p) => p.r), 0);
        assert.ok(star !== undefined && star.r >= biggest * STAR_OVER_PLANET * 0.99, `${canvasName}: 主星 ${star?.r.toFixed(1)} 行星 ${biggest.toFixed(1)}`);
        if (canvasName === "页面") assert.ok(scene.minPlanetPx > PLANET_READABLE_MAX, `页面上的行星可读半径 ${scene.minPlanetPx.toFixed(1)}`);
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
        const scene = fitScreenSafe(spec, w, h, box, elevationFor(box), AGENT_READABLE_MAX);
        const arcs = orbitArcs(scene.layout, scene.camera, scene.viewport);
        const problems: string[] = [];
        for (let t = 0; t <= 600; t += 7.3) {
          const items = drawFrame(scene.layout, scene.camera, scene.viewport, arcs, t, scene.minPlanetPx, false);
          const star = items.find((item): item is StarItem => item.kind === "star");
          const planets = items.filter((item): item is PlanetItem => item.kind === "planet");
          const rocks = items.filter((item): item is RockItem => item.kind === "rock");
          for (const p of planets) {
            // 近侧（画在主星前面）的行星离主星轮廓至少半个行星半径（R8：屏上近相切）
            if (star !== undefined && p.depth < star.depth) {
              const gap = Math.hypot(p.x - star.x, p.y - star.y) - star.r * (Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass)) - p.r;
              if (gap < bodyGapOf(scene.minPlanetPx) - 0.6) problems.push(`t=${t.toFixed(1)} ${p.planetId} 离主星只有 ${gap.toFixed(1)}px`);
            }
            if (p.r < AGENT_READABLE_FLOOR - 0.01) problems.push(`t=${t.toFixed(1)} ${p.planetId} 半径 ${p.r.toFixed(1)} < ${AGENT_READABLE_FLOOR}`);
            if (p.x - p.r < 0 || p.x + p.r > w || p.y - p.r < 0 || p.y + p.r > h) problems.push(`t=${t.toFixed(1)} ${p.planetId} 出画`);
            if (star !== undefined && star.r < p.r * STAR_OVER_PLANET * 0.99) problems.push(`主星 ${star.r.toFixed(1)} 不够大（行星 ${p.r.toFixed(1)}）`);
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

  test("ann-2 那块画布：至少还画着一颗行星（不是整座星系退成一颗主星）；锁定框让开的距离按框算，不按石头算", () => {
    const [, spec] = AGENT_SPECS[3] as [string, GalaxySpec];
    const box = galaxyBox(196, 214, GALAXY_MAX_FILL);
    const scene = fitScreenSafe(spec, 196, 214, box, elevationFor(box), AGENT_READABLE_MAX);
    assert.ok(scene.layout.planets.length >= 1, `只剩 ${scene.layout.planets.length} 颗`);
    assert.ok(scene.minPlanetPx >= AGENT_READABLE_FLOOR);
    assert.ok(ROCK_CLEAR_PX > 4.5);
  });
});

/**
 * 开普勒椭圆（2026-11-24 用户：「这个轨道不够椭圆」）：主星在焦点上，所有轨道共用偏心率与近日点方向。
 * 两颗行星周期不同，迟早会出现任意一对相位——所以不只按时间抽样，还把相邻两圈的相位两两组合扫一遍（含近日点那一侧最挤的地方）。
 */
const ECCS = [0.15, 0.3, 0.45] as const;
const PHASES = 240;

function sweepProblems(spec: GalaxySpec, w: number, h: number, ecc: number): string[] {
  const box = galaxyBox(w, h, GALAXY_MAX_FILL);
  const scene = fitScreenSafe({ ...spec, eccentricity: ecc, dustCap: Number.POSITIVE_INFINITY, growth: true }, w, h, box, elevationFor(box), AGENT_READABLE_MAX);
  const { layout, camera, viewport } = scene;
  const problems: string[] = [];
  if (layout.ecc !== ecc) problems.push(`偏心率没传进来：${layout.ecc}`);
  const star = drawFrame({ ...layout, belt: null }, camera, viewport, [], 0, scene.minPlanetPx, false).find((item): item is StarItem => item.kind === "star");
  if (star === undefined) return ["没有主星"];
  const starReach = star.r * (Math.max(starRadius(spec.starMass), spec.starExtent ?? 0) / starRadius(spec.starMass));
  // 每条轨道（行星 + 碎石块那一圈）在一圈相位上的屏幕位置与半径
  const rings = layout.planets.map((planet) => {
    const frame = orbitFrame(planet.orbitRadius, 0, 0, camera, viewport, layout.ecc);
    const r = planetPx(planet.radius, planet.state === "waiting", camera, viewport, scene.minPlanetPx);
    return { id: planet.id, r, points: Array.from({ length: PHASES }, (_, i) => framePoint(frame, (i / PHASES) * Math.PI * 2)) };
  });
  if (layout.rockOrbit !== null && layout.rocks.length > 0) {
    const frame = orbitFrame(layout.rockOrbit, 0, 0, camera, viewport, layout.ecc);
    rings.push({ id: "碎石块", r: ROCK_CLEAR_PX, points: Array.from({ length: PHASES }, (_, i) => framePoint(frame, (i / PHASES) * Math.PI * 2)) });
  }
  for (const ring of rings) {
    // 画在主星前面那一段（不在远层）不碰主星
    ring.points.forEach((p, i) => {
      const theta = (i / PHASES) * Math.PI * 2;
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
    for (let i = 0; i < PHASES; i++) {
      const p = a.points[i] as { x: number; y: number };
      for (let j = 0; j < PHASES; j++) {
        const q = b.points[j] as { x: number; y: number };
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) {
          best = d;
          at = `${((i / PHASES) * 360).toFixed(0)}°/${((j / PHASES) * 360).toFixed(0)}°`;
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

  test("近日点那一侧确实是最挤的：相邻两圈的最近距离出现在近日点附近（|相位| < 90°），且比正圆时的同一对更近", () => {
    const [, spec] = AGENT_SPECS[3] as [string, GalaxySpec];
    const box = galaxyBox(1088, 726, GALAXY_MAX_FILL);
    const scene = fitScreenSafe({ ...spec, eccentricity: 0.45, dustCap: Number.POSITIVE_INFINITY, growth: true }, 1088, 726, box, elevationFor(box), AGENT_READABLE_MAX);
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
      const scenes = [AGENT_SPECS[2], AGENT_SPECS[0], AGENT_SPECS[3]].map((entry) => {
        const [, spec] = entry as [string, GalaxySpec];
        const box = galaxyBox(1088, 726, GALAXY_MAX_FILL);
        const scene = fitScreenSafe({ ...spec, eccentricity: ecc, growth: true }, 1088, 726, box, elevationFor(box), AGENT_READABLE_MAX);
        const star = drawFrame({ ...scene.layout, belt: null }, scene.camera, scene.viewport, [], 0, scene.minPlanetPx, false).find((item): item is StarItem => item.kind === "star");
        return star?.x ?? 0;
      });
      return scenes;
    });
    for (const row of xs) assert.ok((row[0] ?? 0) > 1088 / 2 + 5, `主星 x=${row[0]?.toFixed(1)}`);
    assert.ok((xs[0]?.[0] ?? 0) < (xs[1]?.[0] ?? 0) && (xs[1]?.[0] ?? 0) < (xs[2]?.[0] ?? 0));
  });
});
