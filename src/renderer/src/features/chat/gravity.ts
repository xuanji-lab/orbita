import { FRAME_EXTENT, STAR_MASS, project, type Camera, type Vec3, type Viewport } from "./galaxy.ts";
// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { EARTH_MASS_KG, EARTH_RADIUS_KM } from "../../../../shared/planet-design.ts";

/**
 * 星系里「高低以质量为准」的两样东西（璇玑星系规则）：
 * - 质量卡：点主星 / 行星，看它的质量、半径、密度，以及相对主星的质量比；
 * - 引力扫描：在轨道平面上叠一张透视网格，每个天体压出一个坑，坑深只随质量变（与半径无关）——
 *   看起来更大的行星坑更浅，一眼看出它的引力更弱。
 *
 * 和设计面板的引力井（galaxy-designer/well.ts）同一个口径：「重物压在橡胶膜上」的视觉隐喻，不是广义相对论的数值解；
 * 坑形同一个钟形 z = −D / (1 + (r/s)²)，多个天体的坑直接相加。相机与投影直接用星系的 galaxy.ts（makeCamera / project），
 * 所以网格跟着转台视角、缩放走。
 *
 * 单位：界面质量 = M⊕ × 10（STAR_MASS 300–1000 ↔ 30–100 M⊕，与 planet-design 同一个换算）；
 * 密度 g/cm³；半径按「同质量同密度的球」换成 R⊕ / km（地球：1 M⊕、5.514 g/cm³ → 1 R⊕ = 6371 km）。
 * 星系里的世界半径 (质量 / 密度)^(1/3) 与这里的 R⊕ 只差一个常数倍，相对大小一致。
 */

/** 界面质量单位 = M⊕ × 10（同 design.ts 的 MASS_UNIT_PER_EARTH；这里不 import design.ts，免得把面板依赖带进纯计算） */
export const UI_PER_EARTH = 10;
/** 地球平均密度（g/cm³） */
export const EARTH_DENSITY = 5.514;

export interface BodyPhysics {
  /** 质量（M⊕） */
  massEarth: number;
  /** 质量（kg） */
  massKg: number;
  /** 半径（R⊕） */
  radiusEarth: number;
  /** 半径（km） */
  radiusKm: number;
  /** 密度（g/cm³） */
  density: number;
}

/** 一颗天体的物理量：界面质量 + 密度 → 真实单位。质量或密度不是正数时返回 null（卡上不编数） */
export function bodyPhysics(massUi: number, density: number): BodyPhysics | null {
  if (!(massUi > 0) || !(density > 0) || !Number.isFinite(massUi) || !Number.isFinite(density)) return null;
  const massEarth = massUi / UI_PER_EARTH;
  const radiusEarth = Math.cbrt((massEarth * EARTH_DENSITY) / density);
  return { massEarth, massKg: massEarth * EARTH_MASS_KG, radiusEarth, radiusKm: radiusEarth * EARTH_RADIUS_KM, density };
}

/** 相对主星的质量比（行星 / 主星）；主星自己是 1 */
export function massRatio(massUi: number, starMassUi: number): number {
  return starMassUi > 0 ? massUi / starMassUi : Number.NaN;
}

/** 科学计数（5.97×10²⁴）：kg 那一行用 */
export function sci(value: number, digits = 2): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const [mantissa, exponent] = value.toExponential(digits).split("e");
  const sup = String(Number(exponent)).replace(/[-0-9]/g, (ch) => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(ch)] ?? ch);
  return `${mantissa}×10${sup}`;
}

/** 卡上的普通数：≥ 100 取整，否则最多两位有效小数，去尾零 */
export function shortNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString("en-US");
  const fixed = Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
  return String(Number(fixed));
}

/** 质量比写成「1/12.5」：行星比主星轻时写几分之一，读得出「轻了多少倍」 */
export function ratioText(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "—";
  if (ratio >= 1) return `${shortNumber(ratio)}×`;
  return `1/${shortNumber(1 / ratio)}`;
}

// ── 引力扫描：坑深与网格 ─────────────────────────────────────────────

export const SCAN = {
  /**
   * 最重的主星（STAR_MASS.max）压出的坑深（世界单位）：比设计面板的井（34）浅得多——这里的天体不能坐进坑里
   * （它们由合成器在轨道平面上转），坑底落在天体正下方；坑太深，俯看时整片网格沉到天体下面一大截，读成「天体浮在半空」
   */
  depthMax: 9,
  /** 坑深 ∝ 质量^γ：γ < 1 让最轻的行星（主星的几百分之一）也压得出一个看得见的浅坑，单调不变 */
  gamma: 0.5,
  /** 坑的半宽 s = 天体画出来的半径（世界单位）× spread + pad：坑口比天体宽一圈——天体压在坑上方，坑太窄会整个藏在天体背后；大的天体坑更宽、但不更深 */
  spread: 2.6,
  pad: 3,
  /** 网格铺多大（× FRAME_EXTENT）与线距（世界单位）；每条线的采样点数 */
  span: 1.2,
  step: 4.5,
  samples: 64,
} as const;

/** 坑深只看质量（界面单位），与半径无关：同质量的天体坑一样深；质量越大坑越深（严格单调） */
export function pitDepth(massUi: number): number {
  if (!(massUi > 0) || !Number.isFinite(massUi)) return 0;
  return SCAN.depthMax * Math.pow(massUi / STAR_MASS.max, SCAN.gamma);
}

/** 一个压在网格上的天体：平面上的位置（世界坐标）、坑深、坑宽 */
export interface Well {
  id: string;
  x: number;
  y: number;
  depth: number;
  /** 钟形半宽 s（世界单位） */
  soft: number;
}

/** 坑宽：按天体画出来的半径（世界单位）定 */
export function pitSoftening(drawnRadius: number): number {
  return Math.max(0, drawnRadius) * SCAN.spread + SCAN.pad;
}

/** 网格在 (x, y) 处的高度（≤ 0）：各个坑直接相加 */
export function sheetZ(x: number, y: number, wells: readonly Well[]): number {
  let z = 0;
  for (const well of wells) {
    const d2 = (x - well.x) ** 2 + (y - well.y) ** 2;
    z -= well.depth / (1 + d2 / (well.soft * well.soft));
  }
  return z;
}

function screenOf(p: Vec3, camera: Camera, vp: Viewport): { x: number; y: number } {
  const q = project(p, camera);
  return { x: vp.cx + vp.focal * q.sx, y: vp.cy + vp.focal * q.sy };
}

/**
 * 屏幕上的一点落回轨道平面（z = 0）上的世界坐标：从相机打一条射线，与平面相交。
 * 星系里的行星、伴星是按「轨道矩阵」的仿射模型画的（合成器只会做矩阵，galaxy.ts 的 orbitFrame），离主星远时与精确透视差几十像素；
 * 坑的位置从「天体画在哪」反推回平面，坑底就正好在画出来的天体下面。射线与平面平行（俯角 0）时返回 null
 */
export function unprojectToPlane(px: number, py: number, camera: Camera, vp: Viewport): { x: number; y: number } | null {
  const sx = (px - vp.cx) / vp.focal;
  const sy = (py - vp.cy) / vp.focal;
  // project：sx = right·r / depth，sy = −up·r / depth ⇒ 方向 = forward + sx·right − sy·up
  const dx = camera.forward.x + sx * camera.right.x - sy * camera.up.x;
  const dy = camera.forward.y + sx * camera.right.y - sy * camera.up.y;
  const dz = camera.forward.z + sx * camera.right.z - sy * camera.up.z;
  if (Math.abs(dz) < 1e-9) return null;
  const t = -camera.position.z / dz;
  if (!(t > 0)) return null;
  return { x: camera.position.x + t * dx, y: camera.position.y + t * dy };
}

/**
 * 整张网格画成一条 path（一次 DOM 写入）：横线、纵线，各按 SCAN.samples 采样，高度取 sheetZ。
 * 网格以主星为中心（origin：主星在世界坐标里的位置，联星时主星绕质心走）。
 */
export function scanPath(camera: Camera, vp: Viewport, wells: readonly Well[], origin: { x: number; y: number } = { x: 0, y: 0 }, reach = 0): string {
  // 网格至少铺到画框的 SCAN.span 倍；有更远的天体（联星的伴星）就铺到它外面一圈
  const half = Math.max(FRAME_EXTENT * SCAN.span, reach);
  const lines = Math.floor(half / SCAN.step);
  let d = "";
  const line = (along: "x" | "y", fixed: number): void => {
    for (let i = 0; i <= SCAN.samples; i++) {
      const t = -half + (2 * half * i) / SCAN.samples;
      const x = origin.x + (along === "x" ? t : fixed);
      const y = origin.y + (along === "y" ? t : fixed);
      const s = screenOf({ x, y, z: sheetZ(x, y, wells) }, camera, vp);
      d += `${i === 0 ? "M" : "L"}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    }
  };
  for (let k = -lines; k <= lines; k++) {
    line("x", k * SCAN.step);
    line("y", k * SCAN.step);
  }
  return d;
}

/**
 * 「测深线」：每个天体从中心（轨道平面上）垂直落到它压出的坑底，底下一道短横——线越长坑越深、引力越强。
 * 天体比自己的坑宽时，坑会整个藏在天体背后（小红矮星旁的气态巨行星就是这样），这条线画在天体上面，把深度直接量出来。
 */
export function probePath(camera: Camera, vp: Viewport, wells: readonly Well[]): string {
  let d = "";
  for (const well of wells) {
    const top = screenOf({ x: well.x, y: well.y, z: 0 }, camera, vp);
    const bottom = screenOf({ x: well.x, y: well.y, z: sheetZ(well.x, well.y, wells) }, camera, vp);
    d += `M${top.x.toFixed(1)} ${top.y.toFixed(1)}L${bottom.x.toFixed(1)} ${bottom.y.toFixed(1)}`;
    d += `M${(bottom.x - 5).toFixed(1)} ${bottom.y.toFixed(1)}H${(bottom.x + 5).toFixed(1)}`;
  }
  return d;
}

/** 坑底在屏幕上的位置（截图取证、测试用：同一个天体，坑深大的坑底在屏幕上更低） */
export function pitBottom(camera: Camera, vp: Viewport, well: Well, wells: readonly Well[]): { x: number; y: number; z: number } {
  const z = sheetZ(well.x, well.y, wells);
  return { ...screenOf({ x: well.x, y: well.y, z }, camera, vp), z };
}
