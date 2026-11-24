import {
  ARCS_PER_ORBIT,
  EXPECTED_ID,
  WAITING_SCALE,
  orbitPoint,
  project,
  type Camera,
  type Composition,
  type GalaxyLayout,
  type OrbitArc,
  type PlanetState,
  type Projected,
  type StarItem,
  type Viewport,
} from "./galaxy.ts";

/**
 * 单智能体首页的原型星系（ClassicGalaxy）：d12f2e2a 的画法原样保留（2026-11-24 用户定「单智能体原样保留」）。
 * 编排页（New Task 页、右栏星系图）换成了合成器转动的仿射模型（galaxy.ts 的 orbitFrame / drawFrame、galaxy-motion.ts）；
 * 这里是旧的逐点透视：轨道线、行星、碎石都按真透视投影，行星近大远小、受光面随位相变，碎石各按开普勒转，每帧整张重算。
 * 有像素级的回归钉子（galaxy-classic.test.ts：与 d12f2e2a 同场景的绘制表逐字节一致）。
 */

/** 星屑的屏幕半径区间（px） */
export const DUST_PX = [0.6, 2.2] as const;

export interface ClassicPlanetItem {
  kind: "planet";
  key: string;
  planetId: string;
  composition: Composition;
  state: PlanetState;
  label: string | null;
  depth: number;
  x: number;
  y: number;
  r: number;
  /** 受光面朝向（径向渐变焦点，0..1） */
  fx: number;
  fy: number;
  /** 从相机看到的受光比例（位相）：1 = 在主星远侧、整面亮；0 = 挡在主星前、只看到背光面 */
  lit: number;
}

export interface DustItem {
  kind: "dust";
  key: "dust-back" | "dust-front";
  depth: number;
  d: string;
  alpha: number;
}

export type ClassicItem = OrbitArc | StarItem | ClassicPlanetItem | DustItem;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toScreen(p: Projected, vp: Viewport): { x: number; y: number } {
  return { x: vp.cx + vp.focal * p.sx, y: vp.cy + vp.focal * p.sy };
}

function round1(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function normalizeAngle(theta: number): number {
  const twoPi = Math.PI * 2;
  return ((theta % twoPi) + twoPi) % twoPi;
}

function dustPath(points: { x: number; y: number; r: number }[]): string {
  let d = "";
  for (const p of points) {
    const r = round1(p.r);
    d += `M${round1(p.x - p.r)} ${round1(p.y)}a${r} ${r} 0 1 0 ${round1(p.r * 2)} 0a${r} ${r} 0 1 0 ${round1(-p.r * 2)} 0`;
  }
  return d;
}

/**
 * 轨道是静止的几何：每条拆成 ARCS_PER_ORBIT 段，各带自己的平均深度。分段是为了遮挡——
 * 远半圈画在主星后面、近半圈画在前面；不分段的话整条轨道只能整体在前或在后。逐点真透视。
 */
export function classicOrbitArcs(layout: GalaxyLayout, camera: Camera, vp: Viewport, samplesPerArc = 6): OrbitArc[] {
  const arcs: OrbitArc[] = [];
  const span = (Math.PI * 2) / ARCS_PER_ORBIT;
  const rings = layout.planets.map((p) => ({ id: p.id, a: p.orbitRadius, inclination: p.inclination, node: p.node, expected: false }));
  if (layout.expectedOrbit !== null) {
    rings.push({ id: EXPECTED_ID, a: layout.expectedOrbit, inclination: 0, node: 0, expected: true });
  }
  for (const planet of rings) {
    for (let k = 0; k < ARCS_PER_ORBIT; k++) {
      const from = k * span;
      let d = "";
      let depthSum = 0;
      for (let i = 0; i <= samplesPerArc; i++) {
        const theta = from + (span * i) / samplesPerArc;
        const projected = project(orbitPoint(planet.a, planet.inclination, planet.node, theta), camera);
        const { x, y } = toScreen(projected, vp);
        d += `${i === 0 ? "M" : "L"}${round1(x)} ${round1(y)}`;
        depthSum += projected.depth;
      }
      arcs.push({
        kind: "orbit",
        key: `orbit-${planet.id}-${k}`,
        planetId: planet.id,
        expected: planet.expected,
        from,
        to: from + span,
        depth: depthSum / (samplesPerArc + 1),
        d,
      });
    }
  }
  return arcs;
}

/**
 * 某一时刻的绘制表，按深度从远到近排好（画家算法）。
 * 行星压在自己的轨道线上：与它相邻的三段自家轨道弧的排序深度不小于行星，先画；否则一段「更近」的弧会从行星中间划过去。
 * 等你的行星放大一档并固定画在主星前面（再被主星挡住就等于看不见最要紧的那件事）。
 */
export function drawClassicFrame(layout: GalaxyLayout, camera: Camera, vp: Viewport, arcs: readonly OrbitArc[], t: number): ClassicItem[] {
  const starP = project({ x: 0, y: 0, z: 0 }, camera);
  const starS = toScreen(starP, vp);
  const items: ClassicItem[] = [
    { kind: "star", key: "star", depth: starP.depth, x: starS.x, y: starS.y, r: (vp.focal * layout.starRadius) / starP.depth },
  ];
  const planetAngle = new Map<string, { theta: number; depth: number }>();
  for (const planet of layout.planets) {
    const theta = planet.phase + planet.omega * t;
    const world = orbitPoint(planet.orbitRadius, planet.inclination, planet.node, theta);
    const p = project(world, camera);
    const s = toScreen(p, vp);
    // 受光：主星在原点。屏幕上亮面朝主星；从相机看到多少亮面 = 「指向主星」与「指向相机」的夹角
    const toStar = { x: -world.x, y: -world.y, z: -world.z };
    const toCam = { x: camera.position.x - world.x, y: camera.position.y - world.y, z: camera.position.z - world.z };
    const ls = Math.hypot(toStar.x, toStar.y, toStar.z) || 1;
    const lc = Math.hypot(toCam.x, toCam.y, toCam.z) || 1;
    const cosPhase = (toStar.x * toCam.x + toStar.y * toCam.y + toStar.z * toCam.z) / (ls * lc);
    const dx = starS.x - s.x;
    const dy = starS.y - s.y;
    const dl = Math.hypot(dx, dy) || 1;
    const waiting = planet.state === "waiting";
    const depth = waiting ? Math.min(p.depth, starP.depth - 1e-3) : p.depth;
    items.push({
      kind: "planet",
      key: `planet-${planet.id}`,
      planetId: planet.id,
      composition: planet.composition,
      state: planet.state,
      label: planet.label,
      depth,
      x: s.x,
      y: s.y,
      r: Math.max((vp.focal * planet.radius) / p.depth, 0) * (waiting ? WAITING_SCALE : 1),
      fx: 0.5 + (0.32 * dx) / dl,
      fy: 0.5 + (0.32 * dy) / dl,
      lit: (1 + cosPhase) / 2,
    });
    planetAngle.set(planet.id, { theta: normalizeAngle(theta), depth });
  }
  const span = (Math.PI * 2) / ARCS_PER_ORBIT;
  for (const arc of arcs) {
    const owner = planetAngle.get(arc.planetId);
    let depth = arc.depth;
    if (owner !== undefined) {
      const home = Math.floor(owner.theta / span);
      const k = Math.round(arc.from / span);
      const near = k === home || (k + 1) % ARCS_PER_ORBIT === home || (home + 1) % ARCS_PER_ORBIT === k;
      if (near) depth = Math.max(depth, owner.depth + 1e-6);
    }
    items.push(depth === arc.depth ? arc : { ...arc, depth });
  }
  if (layout.belt !== null) {
    const back: { x: number; y: number; r: number }[] = [];
    const front: { x: number; y: number; r: number }[] = [];
    let backDepth = 0;
    let frontDepth = 0;
    for (const particle of layout.belt.particles) {
      const theta = particle.theta0 + particle.omega * t;
      const p = project({ x: particle.r * Math.cos(theta), y: particle.r * Math.sin(theta), z: particle.z }, camera);
      const s = toScreen(p, vp);
      // 星屑随画布放大而变清楚（每单位像素 × 0.22，夹在 0.6–2.2px 之间），近大远小
      const point = { x: s.x, y: s.y, r: clamp((vp.focal * 0.22 * DUST_PX[1]) / (2.2 * p.depth), DUST_PX[0], DUST_PX[1]) };
      if (p.depth > starP.depth) {
        back.push(point);
        backDepth += p.depth;
      } else {
        front.push(point);
        frontDepth += p.depth;
      }
    }
    if (back.length > 0) {
      items.push({ kind: "dust", key: "dust-back", depth: backDepth / back.length, d: dustPath(back), alpha: layout.belt.alpha });
    }
    if (front.length > 0) {
      items.push({ kind: "dust", key: "dust-front", depth: frontDepth / front.length, d: dustPath(front), alpha: layout.belt.alpha });
    }
  }
  return items.sort((a, b) => b.depth - a.depth);
}

/** 两次重绘之间至少隔这么久（约 30 帧/秒）：天体走得很慢，60 帧只是多一倍重合成 */
export const FRAME_MS = 33;
/** 一帧最多推进这么多：卡顿或后台节流后恢复时不跳一大截 */
export const MAX_STEP_MS = 100;

/** 只在跑的时候走表：暂停期间不计时，恢复后第一帧（last 为 null）不推进 */
export function advanceClock(elapsedMs: number, lastMs: number | null, nowMs: number): number {
  if (lastMs === null) return elapsedMs;
  return elapsedMs + clamp(nowMs - lastMs, 0, MAX_STEP_MS);
}
