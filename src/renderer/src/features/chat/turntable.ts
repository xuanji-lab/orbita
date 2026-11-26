import {
  beltFrame,
  FRAME_EXTENT,
  farWindow,
  makeCamera,
  orbitArcs,
  orbitFrame,
  project,
  type Camera,
  type GalaxyLayout,
  type OrbitArc,
  type OrbitFrame,
  type Viewport,
} from "./galaxy.ts";
import { FAR_MARGIN } from "./galaxy-motion.ts";

/**
 * 拖动中的「只重新投影」（纯计算，可被 node --test 直接加载）。
 *
 * 屏幕安全布局（screen-safe.fitScreenSafe）一次 30–50ms，每帧跑就掉到十几帧。所以拖动时**冻结布局**：轨道半径、哪些天体显示、
 * 偏心率、行星屏幕半径都用按下那一刻的；每帧只换相机（俯角、方位角）重新投影——视口不动（比例尺与视角无关，主星钉在原处）、
 * 每圈轨道的仿射矩阵、碎石带的矩阵与远近分界、主星的位置与大小、轨道弧的远近分段。这里不 import screen-safe：拖动中不可能调到它。
 * 松手后才按新角度跑一次屏幕安全布局，再用短过渡落到合规的位置（HomeGalaxy）。
 *
 * 拖动中允许暂时不完全合规（轨道间距按按下时的角度排的），但远近分层每帧按新相机算：主星永远画在它挡住的天体前面。
 */
export interface FrozenScene {
  camera: Camera;
  viewport: Viewport;
  layout: GalaxyLayout;
  width: number;
  height: number;
  box: { width: number; height: number };
}

export interface LiveProjection {
  camera: Camera;
  viewport: Viewport;
  /** 行星 id → 轨道矩阵（与 moversOf 同一个 orbitFrame） */
  planets: Map<string, OrbitFrame>;
  /** 碎石块那一圈（没有就 null） */
  rock: OrbitFrame | null;
  /** 每颗行星的远近分界可以不同（e、ω 不同）；rocks 共用这一份 */
  far: { lo: number; hi: number };
  /** 行星 id → 它自己的远近分界 */
  planetFar: Map<string, { lo: number; hi: number }>;
  /** 碎石带：矩阵与远近分界（转动层坐标里的半平面：先转 chi 度，再在 v < −offset 那边是远侧） */
  belt: { frame: OrbitFrame; chiDeg: number; offset: number } | null;
  /** 主星此刻在屏幕上的中心与半径 */
  star: { x: number; y: number; r: number; depth: number };
  arcs: OrbitArc[];
}

/** 碎石带远近分界（转动层坐标）：与 farWindow 同一个式子 sin(E + χ) > k，k 按带子中间那一圈换成像素（R0 = 1000） */
export function beltSplit(ecc: number, azimuth: number): { chiDeg: number; offset: number } {
  const A = Math.sin(azimuth);
  const B = Math.cos(azimuth) * Math.sqrt(1 - ecc * ecc);
  const R = Math.max(Math.hypot(A, B), 1e-9);
  const chi = Math.atan2(A, B);
  const k = Math.max(-1, Math.min(1, (ecc * Math.sin(azimuth)) / R));
  return { chiDeg: (chi * 180) / Math.PI, offset: k * 1000 };
}

/**
 * viewport：比例尺与主星位置。转台拖动时就是按下时那一份（比例尺与视角无关，2026-11-24）；滚轮缩放时调用方按新的缩放与平移给。
 */
export function liveProjection(frozen: FrozenScene, tiltDeg: number, azimuthDeg: number, viewport: Viewport = frozen.viewport): LiveProjection {
  const { layout } = frozen;
  const ecc = layout.ecc;
  const camera = makeCamera(FRAME_EXTENT, tiltDeg, undefined, azimuthDeg);
  const planets = new Map<string, OrbitFrame>();
  const planetFar = new Map<string, { lo: number; hi: number }>();
  for (const planet of layout.planets) {
    planets.set(planet.id, orbitFrame(planet.orbitRadius, planet.inclination, planet.node, camera, viewport, planet.ecc, planet.periapsis));
    planetFar.set(planet.id, farWindow(planet.ecc, camera.azimuth + planet.periapsis, FAR_MARGIN));
  }
  const rock = layout.rockOrbit === null ? null : orbitFrame(layout.rockOrbit, 0, 0, camera, viewport, ecc);
  const belt = layout.belt === null ? null : { frame: beltFrame(layout.belt, camera, viewport), ...beltSplit(layout.belt.ecc, camera.azimuth) };
  const p = project({ x: 0, y: 0, z: 0 }, camera);
  const star = { x: viewport.cx + viewport.focal * p.sx, y: viewport.cy + viewport.focal * p.sy, r: (viewport.focal * layout.starRadius) / p.depth, depth: p.depth };
  return { camera, viewport, planets, planetFar, rock, far: farWindow(ecc, camera.azimuth, FAR_MARGIN), belt, star, arcs: orbitArcs(layout, camera, viewport) };
}
