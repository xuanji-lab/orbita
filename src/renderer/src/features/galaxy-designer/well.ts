import { STAR_MASS, farWindow, inFarWindow, makeCamera, project, type Camera, type Vec3 } from "../chat/galaxy.ts";
import { minOrbit, maxOrbit, ORBIT_RANGE, orbitEccentricityOf, periapsisOf, radiusOf, type GalaxyDesign } from "./design.ts";
import { PLANET_DRAW_SCALE } from "../../../../shared/galaxy-scale.ts";

/**
 * 星系设计面板的「引力井」网格：科普里常见的「重物压在橡胶膜上」画法——一张网格布，主星压在中央，
 * 布往下沉成一个圆坑，质量越大坑越深。**这是引力的视觉隐喻，不是广义相对论的数值解**：
 * 深度只随主星质量单调变大，形状取一个温和的钟形 z = −D / (1 + (r/s)²)，远处回到平面，不随机抖动。
 *
 * 几何是真 3D 坐标 + 透视投影（相机与投影直接用首页星系的 galaxy.ts：makeCamera / project），画成 SVG 路径；
 * 不引 Three.js——一张网格几十条线、一条轨道一百来个点，SVG 足够。
 */

/** 世界单位与首页星系相同（轨道半径 4–52 那一套） */
export const WELL = {
  /** 网格「标称半径」：相机距离、取景都按它定 */
  extent: 64,
  /** 钟形的宽度 s：坑的半宽大约在这里 */
  softening: 26,
  /** 主星质量 300 → 坑深 depthMin，1000 → depthMax（世界单位） */
  depthMin: 8,
  depthMax: 34,
  /** 网格线间距与每条线的采样点数（采样够密，弯处不成折线） */
  step: 9,
  samples: 72,
  /** 网格铺多大（× extent）：比画框大，四周被裁掉，看不到网格的边 */
  spanX: [-2.2, 2.2] as const,
  spanY: [-1.4, 3.2] as const,
  distanceFactor: 2.8,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 坑深：主星质量在区间里线性映射，越界夹住、非数字按最轻算（质量出错时面板另有报错） */
export function wellDepth(starMass: number): number {
  const t = Number.isFinite(starMass) ? clamp((starMass - STAR_MASS.min) / (STAR_MASS.max - STAR_MASS.min), 0, 1) : 0;
  return WELL.depthMin + (WELL.depthMax - WELL.depthMin) * t;
}

/** 网格布在离中心 r 处的高度（≤ 0）：中心最深 = −depth，随 r 单调回到 0 */
export function wellZ(r: number, depth: number): number {
  return -depth / (1 + (r / WELL.softening) ** 2);
}

export interface WellBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WellScene {
  camera: Camera;
  focal: number;
  /** 平面原点 (0,0,0) 在画布上的位置 */
  ox: number;
  oy: number;
}

export interface ScenePoint {
  x: number;
  y: number;
  /** 沿视线的距离：越大越远 */
  depth: number;
}

/**
 * 取景：相机俯角 elevationDeg；把平面上半径 fitRadius 的一圈装进 box 的 fitW × fitH，平面原点放在 box 的 (0.5, originY)。
 * 取景只看平面，不看坑多深——所以质量变了画面不跟着缩放，坑变深就是直接往下沉，一眼看得出。
 */
export function wellScene(
  box: WellBox,
  options: { elevationDeg: number; fitRadius: number; fitW: number; fitH: number; originY: number },
): WellScene {
  const camera = makeCamera(WELL.extent, options.elevationDeg, WELL.distanceFactor);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const p = project({ x: options.fitRadius * Math.cos(t), y: options.fitRadius * Math.sin(t), z: 0 }, camera);
    minX = Math.min(minX, p.sx);
    maxX = Math.max(maxX, p.sx);
    minY = Math.min(minY, p.sy);
    maxY = Math.max(maxY, p.sy);
  }
  const focal = Math.min((box.w * options.fitW) / (maxX - minX), (box.h * options.fitH) / (maxY - minY));
  return { camera, focal, ox: box.x + box.w / 2, oy: box.y + box.h * options.originY };
}

export function toScreen(scene: WellScene, p: Vec3): ScenePoint {
  const q = project(p, scene.camera);
  return { x: scene.ox + scene.focal * q.sx, y: scene.oy + scene.focal * q.sy, depth: q.depth };
}

/** 世界里 1 个单位在某处画出来是多少像素（透视：近大远小） */
export function pixelsPerUnit(scene: WellScene, at: ScenePoint): number {
  return scene.focal / at.depth;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pathOf(points: readonly ScenePoint[]): string {
  let d = "";
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p === undefined) continue;
    d += `${i === 0 ? "M" : "L"}${round1(p.x)} ${round1(p.y)}`;
  }
  return d;
}

export interface GridLine {
  key: string;
  /** 沿 x 走的线（横线）还是沿 y 走的线（纵线） */
  along: "x" | "y";
  /** 这条线最低（最沉）的那一点下沉了多少（世界单位，≥ 0）：测试与取证用 */
  sag: number;
  points: ScenePoint[];
  d: string;
}

/** 整张网格：横线与纵线，每条按 WELL.samples 采样，高度取 wellZ。depth = 0 就是一张平的布 */
export function gridLines(scene: WellScene, depth: number): GridLine[] {
  const lines: GridLine[] = [];
  const e = WELL.extent;
  const [x0, x1] = [WELL.spanX[0] * e, WELL.spanX[1] * e];
  const [y0, y1] = [WELL.spanY[0] * e, WELL.spanY[1] * e];
  const build = (along: "x" | "y", fixed: number): GridLine => {
    const points: ScenePoint[] = [];
    let sag = 0;
    for (let i = 0; i <= WELL.samples; i++) {
      const t = i / WELL.samples;
      const x = along === "x" ? x0 + (x1 - x0) * t : fixed;
      const y = along === "y" ? y0 + (y1 - y0) * t : fixed;
      const z = wellZ(Math.hypot(x, y), depth);
      sag = Math.max(sag, -z);
      points.push(toScreen(scene, { x, y, z }));
    }
    return { key: `${along}${round1(fixed)}`, along, sag, points, d: pathOf(points) };
  };
  // 线对齐到原点：中心那条横线、纵线正好穿过坑底
  for (let y = Math.ceil(y0 / WELL.step) * WELL.step; y <= y1; y += WELL.step) lines.push(build("x", y));
  for (let x = Math.ceil(x0 / WELL.step) * WELL.step; x <= x1; x += WELL.step) lines.push(build("y", x));
  return lines;
}

/** 坑底（主星压着的那一点）在画布上的位置 */
export function wellBottom(scene: WellScene, depth: number): ScenePoint {
  return toScreen(scene, { x: 0, y: 0, z: wellZ(0, depth) });
}

/** 轨道上偏近点角 theta 处的点：椭圆在面内先转 ω，z 取实际矢径处的下沉 */
export function orbitPointOnWell(scene: WellScene, radius: number, depth: number, theta: number, ecc = 0, periapsis = 0): ScenePoint {
  const c = Math.cos(theta) - ecc;
  const s = Math.sin(theta) * Math.sqrt(1 - ecc * ecc);
  const x0 = radius * (c * Math.cos(periapsis) - s * Math.sin(periapsis));
  const y0 = radius * (c * Math.sin(periapsis) + s * Math.cos(periapsis));
  return toScreen(scene, { x: x0, y: y0, z: wellZ(Math.hypot(x0, y0), depth) });
}

/** 一条椭圆轨道按实际远侧区间拆成主星后 / 前两组路径；朝向不同时不再固定从 0 / π 切 */
export function orbitOnWell(scene: WellScene, radius: number, depth: number, samples = 96, ecc = 0, periapsis = 0): { back: string; front: string; points: ScenePoint[] } {
  const all: ScenePoint[] = [];
  for (let i = 0; i <= samples; i++) all.push(orbitPointOnWell(scene, radius, depth, (i / samples) * Math.PI * 2, ecc, periapsis));
  const far = farWindow(ecc, periapsis);
  let back = "";
  let front = "";
  let current: "back" | "front" | null = null;
  for (let i = 0; i < samples; i++) {
    const a = all[i];
    const b = all[i + 1];
    if (a === undefined || b === undefined) continue;
    const side = inFarWindow((i / samples) * Math.PI * 2, far) ? "back" : "front";
    if (side !== current) {
      if (side === "back") back += `M${round1(a.x)} ${round1(a.y)}`;
      else front += `M${round1(a.x)} ${round1(a.y)}`;
      current = side;
    }
    const segment = `L${round1(b.x)} ${round1(b.y)}`;
    if (side === "back") back += segment;
    else front += segment;
  }
  return { back, front, points: all };
}

/** 面板里行星在轨道场景中的固定位置：右前方（近侧），从主星前面看得见，不被主星挡 */
export const PLANET_THETA = (-40 * Math.PI) / 180;

// ── 两种预览的版式（纯函数，组件只画） ─────────────────────────────────

/** 天体压在布上：中心比坑底高出这么多个（画出来的）半径——球陷进坑里一截，不是浮在上面 */
export const SIT = 0.7;

/**
 * 预览画哪几块（测试与组件共用一份判断）：
 * - 主星页、有主星：网格 + 压在坑里的主星；
 * - 行星页、有行星：行星大头像 + 轨道小场景（主星与这颗行星的轨道），两样同时在；
 * - 行星页、有主星没行星：只有轨道小场景里的主星；
 * - 没有主星（任一页）：一张平的网格，什么都没压着。
 */
export type PreviewPart = "well" | "star" | "avatar" | "orbit-scene" | "orbit" | "flat-well";

export function previewPlan(design: GalaxyDesign): PreviewPart[] {
  if (design.star === null) return ["flat-well"];
  if (design.editing === "star") return ["well", "star"];
  if (design.planet === null) return ["orbit-scene"];
  return ["avatar", "orbit-scene", "orbit"];
}

/** 主星页的取景：俯角 24°，平面原点在画框 42% 高处，坑往下沉（最重的主星沉到画框下部、最轻的仍整颗在框里，见测试） */
export const STAR_VIEW = { elevationDeg: 24, fitRadius: WELL.extent, fitW: 1, fitH: 100, originY: 0.42 } as const;

export interface StarStage {
  scene: WellScene;
  depth: number;
  bottom: ScenePoint;
  grid: GridLine[];
  /** 主星（已乘预览缩放）的圆心与半径 */
  star: { x: number; y: number; r: number };
}

/** 主星页：box 是预览画框；displayR 是主星的显示半径（100% 时），zoom 是预览缩放（百分比） */
export function starStage(box: WellBox, starMass: number, displayR: number, zoom: number): StarStage {
  const scene = wellScene(box, STAR_VIEW);
  const depth = wellDepth(starMass);
  const bottom = wellBottom(scene, depth);
  const r = displayR * (zoom / 100);
  return { scene, depth, bottom, grid: gridLines(scene, depth), star: { x: bottom.x, y: bottom.y - SIT * r, r } };
}

/** 没有主星时的平网格（同一个取景，坑深 0） */
export function flatStage(box: WellBox): { scene: WellScene; grid: GridLine[]; center: ScenePoint } {
  const scene = wellScene(box, STAR_VIEW);
  return { scene, grid: gridLines(scene, 0), center: wellBottom(scene, 0) };
}

/** 行星页的轨道小场景：固定画布 260 × 140，取景装得下最大的合法轨道 */
export const ORBIT_BOX: WellBox = { x: 0, y: 0, w: 260, h: 140 };
export const ORBIT_VIEW = { elevationDeg: 34, fitRadius: ORBIT_RANGE.max, fitW: 0.96, fitH: 0.74, originY: 0.4 } as const;
/** 小场景里天体太小会只剩一个点：主星至少画这么大、行星至少这么大（px） */
export const SCENE_STAR_MIN = 10;
export const SCENE_PLANET_MIN = 5;

export interface OrbitStage {
  scene: WellScene;
  depth: number;
  grid: GridLine[];
  star: { x: number; y: number; r: number };
  planet: {
    /** 半长轴、偏心率、近日点方向（rad） */
    a: number;
    ecc: number;
    periapsis: number;
    orbit: { back: string; front: string; points: ScenePoint[] };
    /** 最近的合法轨道（虚线）：比它近就会撞上主星 */
    nearest: { back: string; front: string };
    x: number;
    y: number;
    r: number;
    collide: boolean;
  } | null;
}

/**
 * 轨道场景：真比例（主星、行星半径与轨道同一单位，同一张布），太小时按最小像素画。
 * elevationDeg = 设置里的星系倾角（与页面星系同一个值）；缺席按 ORBIT_VIEW 的 34°。
 * frame：画在哪一块、怎么取景（行星页局部放大版式的左半 / 上半，loupe.ts）；缺席按固定的 ORBIT_BOX。
 */
export function orbitStage(
  design: GalaxyDesign,
  elevationDeg: number = ORBIT_VIEW.elevationDeg,
  frame: { box: WellBox; fitW: number; fitH: number; originY: number } = { box: ORBIT_BOX, fitW: ORBIT_VIEW.fitW, fitH: ORBIT_VIEW.fitH, originY: ORBIT_VIEW.originY },
): OrbitStage | null {
  if (design.star === null) return null;
  const { box, ...fit } = frame;
  const scene = wellScene(box, { ...ORBIT_VIEW, ...fit, elevationDeg });
  const depth = wellDepth(design.star.mass);
  const bottom = wellBottom(scene, depth);
  const starR = Math.max(radiusOf(design, "star") * pixelsPerUnit(scene, bottom), SCENE_STAR_MIN);
  const star = { x: bottom.x, y: bottom.y - SIT * starR, r: starR };
  let planet: OrbitStage["planet"] = null;
  if (design.planet !== null) {
    const raw = design.planet.orbitRadius;
    const a = Number.isFinite(raw) ? Math.max(raw, 0) : 0;
    const ecc = orbitEccentricityOf(design.planet);
    const periapsis = (periapsisOf(design.planet) * Math.PI) / 180;
    const near = minOrbit(design);
    const far = maxOrbit(design);
    const at = orbitPointOnWell(scene, a, depth, PLANET_THETA, ecc, periapsis);
    // 行星按画面大小画（× PLANET_DRAW_SCALE，与星系页、不落进主星的判据同一个数）；主星不缩
    const r = Math.max(radiusOf(design, "planet") * PLANET_DRAW_SCALE * pixelsPerUnit(scene, at), SCENE_PLANET_MIN * PLANET_DRAW_SCALE);
    planet = {
      a,
      ecc,
      periapsis,
      orbit: orbitOnWell(scene, a, depth, 96, ecc, periapsis),
      nearest: orbitOnWell(scene, Number.isFinite(near) ? near : 0, depth, 96, ecc, periapsis),
      x: at.x,
      y: at.y - SIT * r,
      r,
      collide: !(raw >= near && raw <= far),
    };
  }
  return { scene, depth, grid: gridLines(scene, depth), star, planet };
}
