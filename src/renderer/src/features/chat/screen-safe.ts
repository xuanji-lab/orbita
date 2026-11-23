import {
  CAMERA_ELEVATION_DEG,
  FRAME_EXTENT,
  PLANET_ZONE,
  WAITING_SCALE,
  angularSpeed,
  frameViewport,
  layoutGalaxy,
  makeCamera,
  orbitPoint,
  planetRadius,
  project,
  readablePlanetPx,
  starRadius,
  type Camera,
  type GalaxyLayout,
  type GalaxySpec,
  type Viewport,
} from "./galaxy.ts";
import { ORBIT_STEP } from "./galaxy-data.ts";

/**
 * 屏幕安全的星系布局（工作区页与右栏星系图；纯计算，可被 node --test 直接加载）。
 *
 * 星系规则：「轨道之间不得交叉，天体之间不得相撞，并要留出能够辨认彼此的间距。」三维里轨道互不相交还不够——
 * 透视俯看时轨道被压成扁椭圆，内圈近侧的行星会压到主星上，相邻两圈的行星在短轴附近会叠在一起；
 * 行星放大到「表情可读」之后更明显（2026-11-24 主会话在截图里量到：等你的那颗压在主星上）。
 *
 * 做法：在**屏幕坐标**里排轨道半径——
 * - 近侧（朝镜头那半圈，画在主星前面）：行星中心到主星中心 ≥ 主星屏幕半径 + 行星屏幕半径 + SCREEN_GAP；
 *   近侧短轴端点离主星最近（离心角越偏，横向越远），所以只要短轴端点让开，整个前半圈都让开；
 *   远侧（主星背后）允许被主星挡住，但画家算法保证它在主星**后面**画，绝不画在主星上面；
 * - 相邻两圈：近侧与远侧短轴端点的竖向间距都 ≥ 两颗行星屏幕半径之和 + SCREEN_GAP（同心椭圆之间最窄的地方就在短轴上）；
 * - 轨道面一律放平（倾角 0）：倾斜的两圈投影后会交叉，这里要的是画面上一圈套一圈；
 * - 排不下（行星区外沿装不下）就把俯角抬高一档再排（椭圆变圆、短轴变长），到 SAFE_ELEVATION_MAX 还装不下，
 *   就少画最外一圈（那颗计进 hidden，与 6 圈上限同一种退场），不缩小行星到看不清表情。
 */

/** 两个天体轮廓之间至少留的屏幕间距（px）：能分辨是两颗 */
export const SCREEN_GAP = 4;
/** 俯角上限：再高就成了俯视的靶心，读不出「绕着转」 */
export const SAFE_ELEVATION_MAX = 66;
/** 抬俯角的步长 */
const ELEVATION_STEP = 2;
/** 推轨道半径的步长（世界单位） */
const ORBIT_NUDGE = 0.2;

export interface SafeScene {
  camera: Camera;
  viewport: Viewport;
  layout: GalaxyLayout;
  elevationDeg: number;
  /** 行星的最小可读屏幕半径（px，drawFrame 的 minPlanetPx） */
  minPlanetPx: number;
  /** 因为装不下而少画的行星数（已计进 layout.hidden） */
  dropped: number;
}

interface Body {
  radius: number;
  waiting: boolean;
}

function screenOf(camera: Camera, vp: Viewport, a: number, theta: number): { x: number; y: number; depth: number } {
  const p = project(orbitPoint(a, 0, 0, theta), camera);
  return { x: vp.cx + vp.focal * p.sx, y: vp.cy + vp.focal * p.sy, depth: p.depth };
}

/** 某颗行星在轨道 a 的 theta 处的屏幕半径（与 drawFrame 同一个算法：物理半径透视、下限、等你放大） */
function bodyPx(body: Body, depth: number, vp: Viewport, minPx: number): number {
  return Math.max((vp.focal * body.radius) / depth, minPx) * (body.waiting ? WAITING_SCALE : 1);
}

const NEAR = -Math.PI / 2;
const FAR = Math.PI / 2;

/**
 * 在给定相机下按屏幕约束排出每颗行星的轨道半径；装不下返回 null。
 * bodies 按轨道次序（由内到外，= 要紧程度），lower 是每颗原来的轨道半径（只往外推，不往里收）。
 */
function placeOrbits(
  camera: Camera,
  vp: Viewport,
  bodies: readonly Body[],
  lower: readonly number[],
  starPx: number,
  minPx: number,
): number[] | null {
  const star = screenOf(camera, vp, 0, 0);
  const orbits: number[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i] as Body;
    const prevA = orbits[i - 1];
    const prevBody = bodies[i - 1];
    let a = Math.max(lower[i] ?? 0, prevA === undefined ? 0 : prevA + ORBIT_NUDGE);
    for (;;) {
      // 行星整颗要在行星区里（外沿之外是碎石带）
      if (a > PLANET_ZONE - body.radius) return null;
      const near = screenOf(camera, vp, a, NEAR);
      const far = screenOf(camera, vp, a, FAR);
      const rNear = bodyPx(body, near.depth, vp, minPx);
      const rFar = bodyPx(body, far.depth, vp, minPx);
      let ok = Math.hypot(near.x - star.x, near.y - star.y) >= starPx + rNear + SCREEN_GAP;
      if (ok && prevA !== undefined && prevBody !== undefined) {
        const pNear = screenOf(camera, vp, prevA, NEAR);
        const pFar = screenOf(camera, vp, prevA, FAR);
        ok =
          Math.abs(near.y - pNear.y) >= rNear + bodyPx(prevBody, pNear.depth, vp, minPx) + SCREEN_GAP &&
          Math.abs(far.y - pFar.y) >= rFar + bodyPx(prevBody, pFar.depth, vp, minPx) + SCREEN_GAP;
      }
      if (ok) break;
      a += ORBIT_NUDGE;
    }
    orbits.push(a);
  }
  return orbits;
}

export function fitScreenSafe(
  spec: GalaxySpec,
  width: number,
  height: number,
  box: { width: number; height: number },
  baseElevationDeg: number = CAMERA_ELEVATION_DEG,
): SafeScene {
  const flat: GalaxySpec = { ...spec, planets: spec.planets.map((planet) => ({ ...planet, inclinationDeg: 0 })) };
  const base = layoutGalaxy(flat);
  const starExtent = Math.max(starRadius(spec.starMass), spec.starExtent ?? 0);
  let shown = base.planets;
  let dropped = 0;
  for (;;) {
    const bodies: Body[] = shown.map((planet) => ({ radius: planet.radius, waiting: planet.state === "waiting" }));
    for (let e = Math.max(baseElevationDeg, CAMERA_ELEVATION_DEG); e <= SAFE_ELEVATION_MAX; e += ELEVATION_STEP) {
      const camera = makeCamera(FRAME_EXTENT, e);
      const viewport = frameViewport(camera, width, height, box);
      const minPx = readablePlanetPx(camera, viewport, ORBIT_STEP);
      const starDepth = project({ x: 0, y: 0, z: 0 }, camera).depth;
      const starPx = (viewport.focal * starExtent) / starDepth;
      const orbits = placeOrbits(camera, viewport, bodies, shown.map((planet) => planet.orbitRadius), starPx, minPx);
      if (orbits === null) continue;
      const planets = shown.map((planet, i) => {
        const a = orbits[i] ?? planet.orbitRadius;
        return { ...planet, orbitRadius: a, inclination: 0, omega: angularSpeed(a) };
      });
      // 碎石带跟着最外圈往外挪：重排之后带子的内沿仍在最外一颗行星之外
      const relaid = layoutGalaxy({
        ...flat,
        planets: flat.planets.filter((planet) => planets.some((p) => p.id === planet.id)).map((planet) => ({
          ...planet,
          orbitRadius: planets.find((p) => p.id === planet.id)?.orbitRadius ?? planet.orbitRadius,
        })),
      });
      const layout: GalaxyLayout = {
        ...relaid,
        planets: relaid.planets.map((planet) => {
          const fixed = planets.find((p) => p.id === planet.id);
          return fixed === undefined ? planet : { ...planet, orbitRadius: fixed.orbitRadius, inclination: 0, omega: fixed.omega, phase: fixed.phase };
        }),
        hidden: base.hidden + dropped,
        expectedOrbit: base.expectedOrbit,
      };
      return { camera, viewport, layout, elevationDeg: e, minPlanetPx: minPx, dropped };
    }
    if (shown.length === 0) {
      const camera = makeCamera(FRAME_EXTENT, baseElevationDeg);
      const viewport = frameViewport(camera, width, height, box);
      return { camera, viewport, layout: base, elevationDeg: baseElevationDeg, minPlanetPx: readablePlanetPx(camera, viewport, ORBIT_STEP), dropped };
    }
    shown = shown.slice(0, -1);
    dropped += 1;
  }
}

