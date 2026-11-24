import {
  CAMERA_ELEVATION_DEG,
  FRAME_EXTENT,
  PLANET_ZONE,
  PLANET_READABLE_MAX,
  PLANET_READABLE_GAP,
  AGENT_READABLE_GAP,
  ROCK_PX,
  STAR_OVER_PLANET,
  WAITING_SCALE,
  angularSpeed,
  frameViewport,
  layoutGalaxy,
  makeCamera,
  orbitPoint,
  planetRadius,
  project,
  readablePlanetPx,
  planetPx,
  dustLookOf,
  beltOuterOf,
  framePoint,
  orbitFrame,
  starRadius,
  type Camera,
  type GalaxyLayout,
  type GalaxySpec,
  type OrbitFrame,
  type Viewport,
} from "./galaxy.ts";
import { ORBIT_STEP } from "./galaxy-data.ts";
import { LOCK_GAP } from "./callouts.ts";

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
/**
 * 子智能体行星的屏幕半径下限（px）：再小两只竖胶囊眼睛就挤成一个点（2026-11-24 设计审查 R3 / R8：窄窗里行星只剩 6px）。
 * 画布小到主星放不下这么大的行星时，宁可把画面放大、让外圈行星与碎石块出画（少画外圈），也不把行星缩到看不清。
 */
export const AGENT_READABLE_FLOOR = 10;
/** 碎石块那一圈让开别的天体时按锁定框算：框比石头大一圈（LOCK_GAP），框压在行星上也是「压在别人身上」 */
export const ROCK_CLEAR_PX = ROCK_PX + LOCK_GAP;
/** 放大后的画面里，天体（连锁定框）离画布边至少留这么多 */
const EDGE_PX = 6;
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

/** 某颗行星的屏幕半径（与 drawFrame 同一个 planetPx：公转时不变，合成器只平移它） */
function bodyPx(body: Body, camera: Camera, vp: Viewport, minPx: number): number {
  return planetPx(body.radius, body.waiting, camera, vp, minPx);
}

const NEAR = -Math.PI / 2;
const FAR = Math.PI / 2;

/** 两圈轨道（仿射模型 framePoint，与合成器转出来的同一个）在远 / 近两个短轴端点上的竖向间距，取小的那个 */
function shortAxisGap(a: OrbitFrame, aScale: number, b: OrbitFrame, bScale: number): number {
  const near = Math.abs(framePoint(a, NEAR, aScale).y - framePoint(b, NEAR, bScale).y);
  const far = Math.abs(framePoint(a, FAR, aScale).y - framePoint(b, FAR, bScale).y);
  return Math.min(near, far);
}

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
  /** 放大过的画面：行星整颗要落在画布里，落不下就算装不下（外圈退场） */
  inside = false,
  /** 两颗天体轮廓之间至少留多少（px）：子智能体星系按行星半径的一半给（bodyGapOf） */
  gap = SCREEN_GAP,
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
      const rNear = bodyPx(body, camera, vp, minPx);
      const rFar = bodyPx(body, camera, vp, minPx);
      if (inside && !orbitInside(camera, vp, a, Math.max(rNear, rFar))) return null;
      let ok = Math.hypot(near.x - star.x, near.y - star.y) >= starPx + rNear + gap;
      if (ok && prevA !== undefined && prevBody !== undefined) {
        ok = shortAxisGap(orbitFrame(prevA, 0, 0, camera, vp), 1, orbitFrame(a, 0, 0, camera, vp), 1) >= Math.max(rNear, rFar) + bodyPx(prevBody, camera, vp, minPx) + gap;
      }
      if (ok) break;
      a += ORBIT_NUDGE;
    }
    orbits.push(a);
  }
  return orbits;
}

/**
 * 子智能体星系里两颗天体之间的间距：行星半径的一半（不少于 SCREEN_GAP）。4px 在数值上分得开，
 * 眼睛看上去仍是「贴着」（设计审查 R8：琉璃与主星下缘只隔 2–4px）
 */
export function bodyGapOf(minPx: number): number {
  return Math.max(SCREEN_GAP, minPx * 0.5);
}

/** 半径 a 的轨道（放平）连同上面半径 r 的天体，整圈都在画布里（留 EDGE_PX） */
function orbitInside(camera: Camera, vp: Viewport, a: number, r: number): boolean {
  const near = screenOf(camera, vp, a, NEAR);
  const far = screenOf(camera, vp, a, FAR);
  const right = screenOf(camera, vp, a, 0);
  const left = screenOf(camera, vp, a, Math.PI);
  return (
    Math.min(left.x, right.x) - r >= EDGE_PX &&
    Math.max(left.x, right.x) + r <= vp.width - EDGE_PX &&
    Math.min(near.y, far.y) - r >= EDGE_PX &&
    Math.max(near.y, far.y) + r <= vp.height - EDGE_PX
  );
}

/**
 * 碎石块那一圈：在碎石带里取 ROCK_ORBIT_AT 处，再按屏幕约束往外让——近侧 / 远侧短轴端点与最外一颗行星竖向留出
 * 两者屏幕半径之和 + SCREEN_GAP，近侧离主星同理。最多推到画框外沿。碎石块彼此同一圈等角排开，永远不相撞。
 */
function placeRockOrbit(camera: Camera, vp: Viewport, layout: GalaxyLayout, minPx: number, starPx: number, inside = false): number | null {
  if (layout.rockOrbit === null) return null;
  const star = screenOf(camera, vp, 0, 0);
  const last = layout.planets[layout.planets.length - 1];
  const lastBody: Body | null = last === undefined ? null : { radius: last.radius, waiting: last.state === "waiting" };
  let a = layout.rockOrbit;
  for (; a < FRAME_EXTENT; a += ORBIT_NUDGE) {
    const near = screenOf(camera, vp, a, NEAR);
    const far = screenOf(camera, vp, a, FAR);
    let ok = Math.hypot(near.x - star.x, near.y - star.y) >= starPx + ROCK_CLEAR_PX + SCREEN_GAP;
    if (ok && last !== undefined && lastBody !== null) {
      ok = shortAxisGap(orbitFrame(last.orbitRadius, 0, 0, camera, vp), 1, orbitFrame(a, 0, 0, camera, vp), 1) >= ROCK_CLEAR_PX + bodyPx(lastBody, camera, vp, minPx) + SCREEN_GAP;
    }
    if (ok) break;
  }
  const placed = Math.min(a, FRAME_EXTENT);
  // 放大过的窄画面：碎石块那一圈出画就整圈不画——它们归进角上那一行「另有 N 条会话」（HomeGalaxy）
  if (inside && !orbitInside(camera, vp, placed, ROCK_CLEAR_PX)) return null;
  return placed;
}

/**
 * 碎石带的内沿（世界单位）：按屏幕约束往外让——碎石带共用中间那一圈的 frame（与合成器转的同一个模型），
 * 内沿的碎石在近侧 / 远侧短轴端点上与最外一颗行星竖向留出「行星半径 + 碎石半径 + 间距」。
 * 几百颗碎石铺满带宽之后，内沿那几颗不再贴着最外的行星（2026-11-24：每条会话都是一颗碎石）。
 */
function placeBeltInner(camera: Camera, vp: Viewport, layout: GalaxyLayout, lastOrbit: number, lastPx: number, gap: number): number | undefined {
  const belt = layout.belt;
  if (belt === null) return undefined;
  const dustPx = dustLookOf(belt.count).px;
  const planetFrame = orbitFrame(lastOrbit, 0, 0, camera, vp);
  let inner = belt.inner;
  for (let i = 0; i < 400; i++) {
    const mid = (inner + beltOuterOf(inner, belt.count)) / 2;
    if (shortAxisGap(planetFrame, 1, orbitFrame(mid, 0, 0, camera, vp), inner / mid) >= lastPx + dustPx + gap) break;
    inner += ORBIT_NUDGE;
  }
  return inner;
}

export function fitScreenSafe(
  spec: GalaxySpec,
  width: number,
  height: number,
  box: { width: number; height: number },
  baseElevationDeg: number = CAMERA_ELEVATION_DEG,
  /** 行星可读半径的上限（px）：子智能体行星传 AGENT_READABLE_MAX */
  readableMax: number = PLANET_READABLE_MAX,
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
      let viewport = frameViewport(camera, width, height, box);
      const starDepth = project({ x: 0, y: 0, z: 0 }, camera).depth;
      let starPx = (viewport.focal * starExtent) / starDepth;
      let starBodyPx = (viewport.focal * starRadius(spec.starMass)) / starDepth;
      // 行星再大也要比主星明显小（等你放大一档之后也是）
      const agentMode = readableMax > PLANET_READABLE_MAX;
      // 窄画布：主星小到容不下一颗看得清的行星（AGENT_READABLE_FLOOR × 主星倍数）就把画面放大，
      // 主星与行星一起变大；放大后出画的外圈由 placeOrbits / placeRockOrbit 的 inside 约束退场
      const needStar = AGENT_READABLE_FLOOR * STAR_OVER_PLANET * WAITING_SCALE;
      const zoomed = agentMode && bodies.length > 0 && starBodyPx < needStar;
      if (zoomed) {
        const k = needStar / starBodyPx;
        viewport = { ...viewport, focal: viewport.focal * k };
        starPx *= k;
        starBodyPx *= k;
      }
      const readable = readablePlanetPx(camera, viewport, ORBIT_STEP, readableMax, agentMode ? AGENT_READABLE_GAP : PLANET_READABLE_GAP);
      const starCap = starBodyPx / (STAR_OVER_PLANET * WAITING_SCALE);
      const minPx = agentMode ? Math.min(Math.max(readable, AGENT_READABLE_FLOOR), starCap) : readable;
      const orbits = placeOrbits(camera, viewport, bodies, shown.map((planet) => planet.orbitRadius), starPx, minPx, zoomed, agentMode ? bodyGapOf(minPx) : SCREEN_GAP);
      if (orbits === null) continue;
      const planets = shown.map((planet, i) => {
        const a = orbits[i] ?? planet.orbitRadius;
        return { ...planet, orbitRadius: a, inclination: 0, omega: angularSpeed(a) };
      });
      // 碎石带跟着最外圈往外挪：重排之后带子的内沿仍在最外一颗行星之外
      const placedSpec: GalaxySpec = {
        ...flat,
        planets: flat.planets.filter((planet) => planets.some((p) => p.id === planet.id)).map((planet) => ({
          ...planet,
          orbitRadius: planets.find((p) => p.id === planet.id)?.orbitRadius ?? planet.orbitRadius,
        })),
      };
      const firstPass = layoutGalaxy(placedSpec);
      const lastPlaced = planets[planets.length - 1];
      const beltInner =
        lastPlaced === undefined ? undefined : placeBeltInner(camera, viewport, firstPass, lastPlaced.orbitRadius, bodyPx({ radius: lastPlaced.radius, waiting: lastPlaced.state === "waiting" }, camera, viewport, minPx), agentMode ? bodyGapOf(minPx) : SCREEN_GAP);
      const relaid = beltInner === undefined ? firstPass : layoutGalaxy({ ...placedSpec, beltInner });
      const layout: GalaxyLayout = {
        ...relaid,
        planets: relaid.planets.map((planet) => {
          const fixed = planets.find((p) => p.id === planet.id);
          // 放平的轨道上升交点只是相位：并进 phase、node 归零——orbitFrame 的远近两点才正好是短轴两端（合成器模型按它们拉椭圆）
          return fixed === undefined ? planet : { ...planet, orbitRadius: fixed.orbitRadius, inclination: 0, node: 0, omega: fixed.omega, phase: fixed.phase + fixed.node };
        }),
        hidden: base.hidden + dropped,
        expectedOrbit: base.expectedOrbit,
      };
      return { camera, viewport, layout: { ...layout, rockOrbit: placeRockOrbit(camera, viewport, layout, minPx, starPx, zoomed) }, elevationDeg: e, minPlanetPx: minPx, dropped };
    }
    if (shown.length === 0) {
      const camera = makeCamera(FRAME_EXTENT, baseElevationDeg);
      const viewport = frameViewport(camera, width, height, box);
      const minPx = readablePlanetPx(camera, viewport, ORBIT_STEP, readableMax);
      const starPx = (viewport.focal * starExtent) / project({ x: 0, y: 0, z: 0 }, camera).depth;
      return { camera, viewport, layout: { ...base, rockOrbit: placeRockOrbit(camera, viewport, base, minPx, starPx) }, elevationDeg: baseElevationDeg, minPlanetPx: minPx, dropped };
    }
    shown = shown.slice(0, -1);
    dropped += 1;
  }
}

