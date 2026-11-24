import {
  VIEW_REF_ELEVATION,
  FRAME_EXTENT,
  PLANET_ZONE,
  PLANET_READABLE_MAX,
  PLANET_READABLE_GAP,
  PLANET_READABLE_MIN,
  AGENT_READABLE_GAP,
  ROCK_PX,
  STAR_OVER_PLANET,
  WAITING_SCALE,
  angularSpeed,
  baseViewport,
  frameViewport,
  withUserView,
  USER_VIEW_DEFAULT,
  type UserView,
  layoutGalaxy,
  makeCamera,
  orbitPoint,
  planetRadius,
  project,
  readablePlanetPx,
  planetPx,
  dustLookOf,
  beltOuterOf,
  BELT_OVERSHOOT,
  framePoint,
  farWindow,
  inFarWindow,
  orbitFrame,
  eccOf,
  starRadius,
  type Camera,
  type GalaxyLayout,
  type GalaxySpec,
  type OrbitFrame,
  type Viewport,
} from "./galaxy.ts";
import { ORBIT_STEP } from "./galaxy-data.ts";
import { FAR_MARGIN } from "./galaxy-motion.ts";
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
 * - 俯角是用户在设置里选的（星系倾角，10°–60°），这里不改它；排不下（行星区外沿装不下）就少画最外一圈
 *   （那颗计进 hidden，与 6 圈上限同一种退场），不缩小行星到看不清表情。2026-11-24 之前是先自动抬俯角再少画，
 *   俯角成了用户可调的设置之后，抬俯角会让设置看上去不生效，所以去掉了。
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
/** placeOrbits 每颗行星最多试多少次、轨道半长轴最多推到多远（世界单位） */
const PLACE_ITER_MAX = 400;
const PLACE_A_MAX = FRAME_EXTENT * 3;
/** 允许出画时，轨道最远推到画框的几倍 */
const OVERFLOW_ZONE = 1.3;
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
  /** 这块画布在这个视角下装不下，允许了出画（比例尺不变） */
  overflow?: boolean;
  /** 这块画布上行星本该画多大（px，可读半径）：minPlanetPx 比它小 = 走了「行星缩到可读下限」那一步 */
  preferredPx: number;
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
 * 开普勒椭圆（偏心率 > 0）：主星在焦点上，同心椭圆「最窄在短轴」那条捷径不成立——位似椭圆最挤在近日点一侧，
 * 而且最窄处不在任何一个固定的参数角上。所以沿两条曲线各取 CURVE_SAMPLES 个点，量 A 上每个点到 B 的折线的最短距离。
 * 两圈是以主星为中心的位似椭圆，最近点的参数角相差不大，只在 ±CURVE_WINDOW 个点里找。
 */
const CURVE_SAMPLES = 96;
const CURVE_WINDOW = 6;

function samples(frame: OrbitFrame, scale: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < CURVE_SAMPLES; i++) out.push(framePoint(frame, (i / CURVE_SAMPLES) * Math.PI * 2, scale));
  return out;
}

function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
}

export function curveGap(a: OrbitFrame, aScale: number, b: OrbitFrame, bScale: number): number {
  const pa = samples(a, aScale);
  const pb = samples(b, bScale);
  let best = Infinity;
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const p = pa[i] as { x: number; y: number };
    for (let k = -CURVE_WINDOW; k < CURVE_WINDOW; k++) {
      const j = (i + k + CURVE_SAMPLES) % CURVE_SAMPLES;
      best = Math.min(best, segmentDistance(p, pb[j] as { x: number; y: number }, pb[(j + 1) % CURVE_SAMPLES] as { x: number; y: number }));
    }
  }
  return best;
}

/** 两圈之间的屏幕间距：正圆轨道照旧量短轴两端（与改前逐位相同），开普勒椭圆沿整条曲线量 */
function orbitGap(ecc: number, a: OrbitFrame, aScale: number, b: OrbitFrame, bScale: number): number {
  return ecc === 0 ? shortAxisGap(a, aScale, b, bScale) : curveGap(a, aScale, b, bScale);
}

/**
 * 画在主星前面的那一段（不在远层：偏近点角不在 (FAR_MARGIN, π − FAR_MARGIN) 里）离主星中心最近多远。
 * 正圆轨道就是近侧短轴端点；开普勒椭圆上最近的一点偏向近日点那一侧，取样量。
 */
function frontDistance(frame: OrbitFrame, star: { x: number; y: number }, camera: Camera, ecc: number): number {
  // 远侧区间随方位角转（方位角 0 时就是 (FAR_MARGIN, π − FAR_MARGIN)）
  const far = farWindow(ecc, camera.azimuth, FAR_MARGIN);
  let best = Infinity;
  for (let i = 0; i < 144; i++) {
    const theta = (i / 144) * Math.PI * 2;
    if (inFarWindow(theta, far)) continue;
    const p = framePoint(frame, theta);
    best = Math.min(best, Math.hypot(p.x - star.x, p.y - star.y));
  }
  return best;
}

/** 碎石带（以中间那一圈的 frame 按比例缩放）画在主星前面那一段到主星的最近距离 */
function frontDistanceScaled(frame: OrbitFrame, scale: number, star: { x: number; y: number }, camera: Camera, ecc: number): number {
  const far = farWindow(ecc, camera.azimuth);
  let best = Infinity;
  for (let i = 0; i < 144; i++) {
    const theta = (i / 144) * Math.PI * 2;
    if (camera.azimuth === 0 ? Math.sin(theta) > 0 : inFarWindow(theta, far)) continue;
    const p = framePoint(frame, theta, scale);
    best = Math.min(best, Math.hypot(p.x - star.x, p.y - star.y));
  }
  return best;
}

/** 某圈轨道上「画在主星前面」那一段到主星的最近距离 */
function starDistance(camera: Camera, vp: Viewport, a: number, ecc: number, star: { x: number; y: number }): number {
  if (ecc === 0) {
    const near = screenOf(camera, vp, a, NEAR);
    return Math.hypot(near.x - star.x, near.y - star.y);
  }
  return frontDistance(orbitFrame(a, 0, 0, camera, vp, ecc), star, camera, ecc);
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
  ecc = 0,
  /** 行星区外沿（世界单位）：平时 PLANET_ZONE（再往外是碎石带）；碎石先收的排法给到画框边 */
  zone = PLANET_ZONE,
): number[] | null {
  const star = screenOf(camera, vp, 0, 0);
  const orbits: number[] = [];
  // 轨道往外推一个单位，屏幕上的间距最多长 pxPerUnit：按差多少一次推够（不越过最小解），比逐 0.2 单位地试快一个量级
  const pxPerUnit = vp.focal / project({ x: 0, y: 0, z: 0 }, camera).depth;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i] as Body;
    const prevA = orbits[i - 1];
    const prevBody = bodies[i - 1];
    let a = Math.max(lower[i] ?? 0, prevA === undefined ? 0 : prevA + ORBIT_NUDGE);
    // 硬上限：偏心时轨道间距不随 a 单调变大、主星距离会饱和，差额可能永远为正——任何输入都不许无界循环
    for (let iter = 0; ; iter++) {
      if (iter >= PLACE_ITER_MAX || a > PLACE_A_MAX) {
        if (Number.isFinite(zone)) return null;
        break; // 最后一搏（zone = ∞）：不再找，就放在这里
      }
      // 行星整颗要在行星区里（外沿之外是碎石带）
      if (a > zone - body.radius) return null;
      const rNear = bodyPx(body, camera, vp, minPx);
      const rFar = bodyPx(body, camera, vp, minPx);
      if (inside && !orbitInside(camera, vp, a, Math.max(rNear, rFar), ecc)) return null;
      let deficit = starPx + rNear + gap - starDistance(camera, vp, a, ecc, star);
      if (deficit <= 0 && prevA !== undefined && prevBody !== undefined) {
        deficit = Math.max(rNear, rFar) + bodyPx(prevBody, camera, vp, minPx) + gap - orbitGap(ecc, orbitFrame(prevA, 0, 0, camera, vp, ecc), 1, orbitFrame(a, 0, 0, camera, vp, ecc), 1);
      }
      if (deficit <= 0) break;
      a += Math.max(ORBIT_NUDGE, deficit / pxPerUnit);
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

/** 半径 a 的轨道（放平）连同上面半径 r 的天体，整圈都在画布里（留 EDGE_PX）。椭圆的四个极点仍在参数角 0 / π / ±π/2 上 */
function orbitInside(camera: Camera, vp: Viewport, a: number, r: number, ecc = 0): boolean {
  if (camera.azimuth !== 0 && ecc !== 0) {
    // 转过方位角的椭圆：屏幕上的极点不再在参数角 0 / π / ±π/2 上，取样量
    const frame = orbitFrame(a, 0, 0, camera, vp, ecc);
    for (let i = 0; i < 72; i++) {
      const p = framePoint(frame, (i / 72) * Math.PI * 2);
      if (p.x - r < EDGE_PX || p.x + r > vp.width - EDGE_PX || p.y - r < EDGE_PX || p.y + r > vp.height - EDGE_PX) return false;
    }
    return true;
  }
  const at = (theta: number) => (ecc === 0 ? screenOf(camera, vp, a, theta) : framePoint(orbitFrame(a, 0, 0, camera, vp, ecc), theta));
  const near = at(NEAR);
  const far = at(FAR);
  const right = at(0);
  const left = at(Math.PI);
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
function placeRockOrbit(camera: Camera, vp: Viewport, layout: GalaxyLayout, minPx: number, starPx: number, inside = false): { orbit: number | null; cramped: boolean } {
  // cramped = 让得开主星、但到画框边上还让不开最外一颗行星（少画一圈行星能解决）；
  // 连主星都让不开（很低的俯角下近侧几乎贴着主星横过）就整圈不画碎石块（orbit = null），不为它少画行星
  const ecc = layout.ecc;
  if (layout.rockOrbit === null) return { orbit: null, cramped: false };
  const star = screenOf(camera, vp, 0, 0);
  const last = layout.planets[layout.planets.length - 1];
  const lastBody: Body | null = last === undefined ? null : { radius: last.radius, waiting: last.state === "waiting" };
  // 开普勒椭圆：近日点一侧两圈只隔半长轴差的 (1 − e) 倍，碎石块那一圈允许伸进画框四周的边距（与碎石带外沿同一个上限）
  const cap = ecc === 0 ? FRAME_EXTENT : FRAME_EXTENT * BELT_OVERSHOOT;
  let a = layout.rockOrbit;
  let ok = false;
  let clearOfStar = false;
  for (; a < cap; a += ORBIT_NUDGE) {
    ok = starDistance(camera, vp, a, ecc, star) >= starPx + ROCK_CLEAR_PX + SCREEN_GAP;
    clearOfStar = clearOfStar || ok;
    if (ok && last !== undefined && lastBody !== null) {
      ok = orbitGap(ecc, orbitFrame(last.orbitRadius, 0, 0, camera, vp, ecc), 1, orbitFrame(a, 0, 0, camera, vp, ecc), 1) >= ROCK_CLEAR_PX + bodyPx(lastBody, camera, vp, minPx) + SCREEN_GAP;
    }
    if (ok) break;
  }
  const placed = Math.min(a, cap);
  // 放大过的窄画面：碎石块那一圈出画就整圈不画（它们仍是碎石带里的碎石，键盘从「全部 N 条会话」去树状图）
  if (inside && !orbitInside(camera, vp, placed, ROCK_CLEAR_PX, ecc)) return { orbit: null, cramped: false };
  if (!clearOfStar) return { orbit: null, cramped: false };
  return { orbit: placed, cramped: !ok };
}

/**
 * 碎石带的内沿（世界单位）：按屏幕约束往外让——碎石带共用中间那一圈的 frame（与合成器转的同一个模型），
 * 内沿的碎石在近侧 / 远侧短轴端点上与最外一颗行星竖向留出「行星半径 + 碎石半径 + 间距」。
 * 几百颗碎石铺满带宽之后，内沿那几颗不再贴着最外的行星（2026-11-24：每条会话都是一颗碎石）。
 */
function placeBeltInner(camera: Camera, vp: Viewport, layout: GalaxyLayout, lastOrbit: number | null, lastPx: number, gap: number, starPx: number): number | undefined {
  const belt = layout.belt;
  if (belt === null) return undefined;
  const dustPx = dustLookOf(belt.count).px;
  const ecc = layout.ecc;
  const star = screenOf(camera, vp, 0, 0);
  const planetFrame = lastOrbit === null ? null : orbitFrame(lastOrbit, 0, 0, camera, vp, ecc);
  let inner = belt.inner;
  for (let i = 0; i < 400; i++) {
    const mid = (inner + beltOuterOf(inner, belt.count)) / 2;
    const midFrame = orbitFrame(mid, 0, 0, camera, vp, ecc);
    // 低俯角时碎石带近侧会横过主星：内沿画在主星前面的那一段也要让开主星
    const clearStar = frontDistanceScaled(midFrame, inner / mid, star, camera, ecc) >= starPx + dustPx + SCREEN_GAP;
    if (clearStar && (planetFrame === null || orbitGap(ecc, planetFrame, 1, midFrame, inner / mid) >= lastPx + dustPx + gap)) break;
    inner += ORBIT_NUDGE;
  }
  return inner;
}

/**
 * 屏幕安全布局（对外入口）。子智能体行星是有名字、有身份的持久智能体，**永远全部画出**（2026-11-24 用户定）；
 * 装不下时按这个顺序退：
 * 1. 碎石与尘埃先收（碎石块那一圈让不开就整圈不画；碎石带往外挪、出画的被裁掉）；
 * 2. 轨道不再守设计稿给的半径，压到屏幕安全的最小间距（pack = tight）；
 * 3. 行星缩到最小可读半径（pack = small：AGENT_READABLE_FLOOR）；
 * 4. 还装不下，就只对这一块画布把俯角抬到刚好装得下的最小值（elevationDeg > 设置值，设置页说明一句）。
 * 偏心率：先按 spec 给的排；在设置的俯角上装不下时，偏心率按 2/3、1/3、0 往下退，取第一档在设置俯角上装得下的；
 * 都要抬俯角时取抬得最少的那档。只看画布与设计稿，不看公转相位，同一块画布上结果稳定。
 */
export function fitScreenSafe(
  spec: GalaxySpec,
  width: number,
  height: number,
  box: { width: number; height: number },
  /** 相机俯角（度）：设置 › 外观 › 星系倾角 */
  baseElevationDeg: number,
  readableMax: number = PLANET_READABLE_MAX,
  /** 方位角（度，转台）：星系绕 z 轴转多少 */
  azimuthDeg = 0,
  /** 用户缩放与平移：只改比例尺与主星位置，布局在这个比例尺上排 */
  view: UserView = USER_VIEW_DEFAULT,
): SafeScene {
  // 比例尺与视角无关（2026-11-24）：先在默认视角（VIEW_REF_ELEVATION、方位 0、不缩放）上按改前的整套规则排一次——
  // 那里的视口（比例尺 + 主星位置，含窄画布的自动放大）就是这块画布的比例尺，各视角共用；默认视角直接返回它，与改前逐位相同。
  const ref = fitCore(spec, width, height, box, VIEW_REF_ELEVATION, readableMax, 0, { mode: "legacy" });
  const isRef = baseElevationDeg === VIEW_REF_ELEVATION && azimuthDeg === 0 && view.zoom === 1 && view.panX === 0 && view.panY === 0;
  if (isRef) return ref;
  const zoomed = ref.viewport.focal > baseViewport(width, height, box, eccOf(spec.eccentricity)).focal * (1 + 1e-9);
  return fitCore(spec, width, height, box, baseElevationDeg, readableMax, azimuthDeg, {
    mode: "fixed",
    viewport: withUserView(ref.viewport, view),
    zoomed,
    userZoomed: view.zoom > 1,
  });
}

function fitCore(
  spec: GalaxySpec,
  width: number,
  height: number,
  box: { width: number; height: number },
  baseElevationDeg: number,
  readableMax: number,
  azimuthDeg: number,
  frame: ScaleFrame,
): SafeScene {
  const ecc = eccOf(spec.eccentricity);
  const candidates = ecc === 0 ? [0] : [ecc, (ecc * 2) / 3, ecc / 3, 0];
  // 好坏：少画了行星最差，其次是行星缩到可读下限以下，再其次是行星被缩小（比这块画布上本该画的小），再其次是俯角抬得多。
  // 「被缩小」排在偏心率之前（2026-11-24 转台：近日点朝向镜头时近侧挤，原来会把行星从 20px 缩到 10px；
  // 现在先把椭圆放圆一档，表情照旧看得清，近日点的朝向照样跟着转）
  const floor = readableMax > PLANET_READABLE_MAX ? AGENT_READABLE_FLOOR : PLANET_READABLE_MIN;
  const cost = (scene: SafeScene) =>
    scene.dropped * 10_000 + (scene.minPlanetPx < floor - 1e-6 ? 1_000 : 0) + (scene.minPlanetPx < scene.preferredPx - 1e-6 ? 100 : 0) + (scene.elevationDeg - baseElevationDeg);
  let best: SafeScene | null = null;
  for (const e of candidates) {
    const scene = fitAll({ ...spec, eccentricity: e }, width, height, box, baseElevationDeg, readableMax, azimuthDeg, frame);
    if (cost(scene) === 0) return scene;
    if (best === null || cost(scene) < cost(best)) best = scene;
  }
  return best as SafeScene;
}

/** 抬俯角的上限：再高就是正俯视，仍装不下才走最后的退路（只在测试都覆盖不到的极小画布上） */
const ELEVATION_LIMIT = 85;
const PACKS = ["given", "tight", "small"] as const;
type Pack = (typeof PACKS)[number];

/**
 * 比例尺怎么来：legacy = 改前的规则（每个俯角重新把画框装进画布、窄画布按排法自动放大），只在默认视角上用来定比例尺；
 * fixed = 用定好的视口（比例尺 + 主星位置），不随俯角、方位、排法变。
 */
type ScaleFrame =
  | { mode: "legacy" }
  | {
      mode: "fixed";
      viewport: Viewport;
      /** 定比例尺时窄画布自动放大过：行星要整颗留在画布里（装不下才出画） */
      zoomed: boolean;
      /** 用户放大了：允许出画 */
      userZoomed: boolean;
      /** 允许出画：转到某些视角整座装不进画布，宁可出画也不缩比例尺、不把行星缩到看不清 */
      overflow?: boolean;
    };

function fitAll(spec: GalaxySpec, width: number, height: number, box: { width: number; height: number }, tilt: number, readableMax: number, azimuthDeg: number, frame: ScaleFrame): SafeScene {
  const flat: GalaxySpec = { ...spec, planets: spec.planets.map((planet) => ({ ...planet, inclinationDeg: 0 })) };
  const base = layoutGalaxy(flat);
  const tryAt = (e: number, overflow = false): SafeScene | null => {
    for (const pack of PACKS) {
      const scene = placeAt(flat, base, width, height, box, e, readableMax, pack, base.planets, undefined, false, azimuthDeg, overflow && frame.mode === "fixed" ? { ...frame, overflow: true } : frame);
      if (scene !== null) return overflow ? { ...scene, overflow: true } : scene;
    }
    return null;
  };
  const atTilt = tryAt(tilt);
  if (atTilt !== null) return atTilt;
  // 比例尺与视角无关之后（2026-11-24），原来「抬俯角」那一步之所以管用，一半是因为抬了俯角重算视口时整座悄悄缩小了。
  // 现在先在用户选的俯角上允许出画（行星照旧可读、不相撞，只是有一部分在画布外，Blender 视口也是这样），不改用户的视角；
  // 出画也排不下（行星区里挤不开）才抬俯角
  if (frame.mode === "fixed") {
    const spill = tryAt(tilt, true);
    if (spill !== null) return spill;
  }
  // 粗找（每 5°）再细找（每 1°）：抬到刚好装得下的最小俯角
  let lo = tilt;
  for (let e = tilt + 5; e <= ELEVATION_LIMIT; e += 5) {
    const coarse = tryAt(e);
    if (coarse !== null) {
      for (let f = lo + 1; f < e; f++) {
        const fine = tryAt(f);
        if (fine !== null) return fine;
      }
      return coarse;
    }
    lo = e;
  }
  // 最后的退路（抬到 ELEVATION_LIMIT 都装不下：子智能体多、画布又小）：就在这个俯角上把行星缩到可读下限以下
  // （每次 ×0.85，最小 2.5px）。子智能体永远不藏——小一点总比没有好；「表情可读」只保证到这之前（见测试）
  for (let px = AGENT_READABLE_FLOOR * 0.85; px >= 2.5; px *= 0.85) {
    const scene = placeAt(flat, base, width, height, box, ELEVATION_LIMIT, readableMax, "small", base.planets, px, false, azimuthDeg, frame);
    if (scene !== null) return scene;
  }
  // 正圆轨道上间距随半径单调变大，最后一搏一定排得开（偏心时不一定）
  const round: GalaxySpec = { ...flat, eccentricity: 0 };
  const scene = placeAt(round, layoutGalaxy(round), width, height, box, ELEVATION_LIMIT, readableMax, "small", base.planets, 4, true, azimuthDeg, frame);
  return scene as SafeScene;
}

/** 在一个俯角、一种排法上把 shown 这几颗行星全部排进去；排不下返回 null（不少画） */
export function placeAt(
  flat: GalaxySpec,
  base: GalaxyLayout,
  width: number,
  height: number,
  box: { width: number; height: number },
  e: number,
  readableMax: number,
  pack: Pack,
  shown: GalaxyLayout["planets"],
  /** 最后的退路：行星屏幕半径直接给定（低于可读下限） */
  forcedPx?: number,
  /** 最后一搏：不管装不装得下都给一个结果（轨道按最小间距、越出画框也画） */
  force = false,
  /** 方位角（度）。正圆轨道绕 z 轴转是对称的：排布用方位角 0 的相机算（正圆的量法按短轴两端，只在 0 时成立），结果相机再转过去 */
  azimuthDeg = 0,
  /** 比例尺：缺省按改前的规则 */
  frame: ScaleFrame = { mode: "legacy" },
): SafeScene | null {
  const ecc = eccOf(flat.eccentricity);
  const starExtent = Math.max(starRadius(flat.starMass), flat.starExtent ?? 0);
  const bodies: Body[] = shown.map((planet) => ({ radius: planet.radius, waiting: planet.state === "waiting" }));
  const camera = makeCamera(FRAME_EXTENT, e, undefined, ecc === 0 ? 0 : azimuthDeg);
  let viewport = frame.mode === "fixed" ? frame.viewport : frameViewport(camera, width, height, box, ecc);
  const starDepth = project({ x: 0, y: 0, z: 0 }, camera).depth;
  let starPx = (viewport.focal * starExtent) / starDepth;
  let starBodyPx = (viewport.focal * starRadius(flat.starMass)) / starDepth;
  // 行星再大也要比主星明显小（等你放大一档之后也是）
  const agentMode = readableMax > PLANET_READABLE_MAX;
  // 窄画布：主星小到容不下一颗看得清的行星（AGENT_READABLE_FLOOR × 主星倍数）就把画面放大，主星与行星一起变大
  const needStar = AGENT_READABLE_FLOOR * STAR_OVER_PLANET * WAITING_SCALE;
  // 这一步只看画布与主星质量（starBodyPx 与视角无关），所以各视角、各排法同一个放大倍数——不再「换个角度整座忽大忽小」。
  // 原来 small 排法与最后的退路不放大，结果某些视角掉进 small 时整座突然缩小；现在一律放大，装不下就交给后面几步
  // （行星缩小、抬俯角），比例尺不动
  // fixed：比例尺已定（默认视角上定的，含窄画布的放大），这里不再放大
  const autoZoom = frame.mode === "legacy" && agentMode && bodies.length > 0 && starBodyPx < needStar && forcedPx === undefined && pack !== "small";
  const k = autoZoom ? needStar / starBodyPx : 1;
  const zoomed = frame.mode === "fixed" ? frame.zoomed : autoZoom;
  if (autoZoom) {
    // 开普勒椭圆：主星偏在近日点一侧，绕主星放大会把远日点那一侧推出画——横向改成绕画布中线放大（正圆时 cx 就在中线上，不变）
    viewport = { ...viewport, focal: viewport.focal * k, cx: ecc === 0 ? viewport.cx : width / 2 + (viewport.cx - width / 2) * k };
    starPx *= k;
    starBodyPx *= k;
  }
  // 用户放大了就允许出画（是他要看细节）；允许出画那一步（overflow）也不要求整颗在画布里
  const userZoomed = frame.mode === "fixed" && (frame.userZoomed || frame.overflow === true);
  const floor = agentMode ? AGENT_READABLE_FLOOR : PLANET_READABLE_MIN;
  const readable = readablePlanetPx(camera, viewport, ORBIT_STEP, readableMax, agentMode ? AGENT_READABLE_GAP : PLANET_READABLE_GAP);
  const starCap = starBodyPx / (STAR_OVER_PLANET * WAITING_SCALE);
  const preferred = agentMode ? Math.min(Math.max(readable, AGENT_READABLE_FLOOR), starCap) : readable;
  // fixed：比例尺不再为「主星小到容不下可读行星」放大，given / tight 排法下行星会被主星倍数夹到可读下限以下——这时直接交给 small
  // （行星按可读下限画、主星可以比行星小：质量高低才是铁律，画面大小不是），不画看不清的行星
  if (frame.mode === "fixed" && agentMode && pack !== "small" && forcedPx === undefined && preferred < floor - 1e-6) return null;
  const minPx = forcedPx ?? (pack === "small" ? floor : preferred);
  const lower = pack === "given" ? shown.map((planet) => planet.orbitRadius) : shown.map(() => 0);
  // small：行星区不再以碎石带为界（碎石先收），只以画布为界（下面 inside 检查整颗在画布里）
  // 允许出画那一步也有边：轨道推到画框 1.3 倍以外，相机离得太近、透视的仿射近似就不准了（测试里 6 颗在 20° 推到 168 单位、相邻两颗相交）。
  // 再排不下才抬俯角
  const zone = pack === "small" ? (frame.mode === "fixed" && frame.overflow === true ? FRAME_EXTENT * OVERFLOW_ZONE : PLACE_A_MAX) : PLANET_ZONE;
  // small 排法把行星推进碎石带那一圈（可能越过画框边距）：整颗要在画布里
  const orbits = placeOrbits(camera, viewport, bodies, lower, starPx, minPx, (zoomed || pack === "small") && !force && !userZoomed, agentMode ? bodyGapOf(minPx) : SCREEN_GAP, ecc, force ? Number.POSITIVE_INFINITY : zone);
  if (orbits === null) return null;
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
  const beltInner = placeBeltInner(
    camera,
    viewport,
    firstPass,
    lastPlaced === undefined ? null : lastPlaced.orbitRadius,
    lastPlaced === undefined ? 0 : bodyPx({ radius: lastPlaced.radius, waiting: lastPlaced.state === "waiting" }, camera, viewport, minPx),
    agentMode ? bodyGapOf(minPx) : SCREEN_GAP,
    starPx,
  );
  // 碎石先收：行星排进了碎石带那一圈（只在 small 排法下会发生），碎石带整条不画
  const spilled = planets.some((planet) => planet.orbitRadius > PLANET_ZONE - planet.radius);
  const relaidFull = beltInner === undefined ? firstPass : layoutGalaxy({ ...placedSpec, beltInner });
  const relaid = spilled ? { ...relaidFull, belt: null, rockOrbit: null } : relaidFull;
  const layout: GalaxyLayout = {
    ...relaid,
    planets: relaid.planets.map((planet) => {
      const fixed = planets.find((p) => p.id === planet.id);
      // 放平的轨道上升交点只是相位：并进 phase、node 归零——orbitFrame 的远近两点才正好是短轴两端（合成器模型按它们拉椭圆）
      return fixed === undefined ? planet : { ...planet, orbitRadius: fixed.orbitRadius, inclination: 0, node: 0, omega: fixed.omega, phase: fixed.phase + fixed.node };
    }),
    hidden: base.hidden,
    expectedOrbit: base.expectedOrbit,
  };
  // 碎石块那一圈让不开（最外一颗行星或主星）就整圈不画：碎石先收，不为它少画行星
  const rock = placeRockOrbit(camera, viewport, layout, minPx, starPx, zoomed && !userZoomed);
  // 正圆：排布在方位角 0 上算完，换成转过去的相机（画框是圆，视口不变）
  const viewCamera = ecc === 0 && azimuthDeg !== 0 ? makeCamera(FRAME_EXTENT, e, undefined, azimuthDeg) : camera;
  return { camera: viewCamera, viewport, layout: { ...layout, rockOrbit: rock.cramped ? null : rock.orbit }, elevationDeg: e, minPlanetPx: minPx, dropped: 0, preferredPx: preferred };
}
