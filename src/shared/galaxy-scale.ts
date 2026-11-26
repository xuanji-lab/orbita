/**
 * 星系的比例：质量单位、密度、天体半径、行星区与间距，以及「行星不落进主星」的判据。
 *
 * 画星系的（renderer：galaxy.ts、设计面板 design.ts）与新建子智能体找空轨的（主进程：sub-agent.ts）共用这一份——
 * 同一颗星在两边必须一样大，同一条轨道在两边必须同样合法。以前这些数码只在 renderer 的 galaxy.ts 里，主进程
 * 够不着，只好自己写一个「最轻主星 30 M⊕」去算轨道：设计稿缺失时以为主星很小，界面却按工作区播种了一颗
 * 30–100 M⊕ 的，新行星落进了主星里（2026-11-25）。
 *
 * 单位：质量用「界面质量单位」（= M⊕ × MASS_UNIT_PER_EARTH，盘上一律 M⊕）；半径与轨道半长轴同一个单位。
 * 这里不碰画法，只有纯计算。
 */
import { ORBIT_ECC_MAX } from "./orbit-physics.ts";

/** 界面质量单位 = M⊕ × 10（galaxy.ts 的 STAR_MASS 300–1000 ↔ 30–100 M⊕） */
export const MASS_UNIT_PER_EARTH = 10;

/** 主星与行星的质量区间互不重叠，且行星上限远低于主星下限 */
export const STAR_MASS = { min: 300, max: 1000 } as const;
export const PLANET_MASS = { min: 1, max: 40 } as const;

/** 主星的密度：主星成分固定（等离子），只有质量能调。设计面板也用它算主星半径 */
export const STAR_DENSITY = 1.4;

export type BodyComposition = "rock" | "ice" | "gas";

/** 行星按成分类别的密度（g/cm³） */
export const DENSITY: Readonly<Record<BodyComposition, number>> = { rock: 5.5, ice: 2, gas: 1.3 };

/** 行星区：轨道远日距连同行星半径要留在这个半径里 */
export const PLANET_ZONE = 52;

/** 相邻两个天体表面之间至少留的距离（与半径同单位）：主星与行星之间、行星与行星之间都是它 */
export const MIN_CLEARANCE = 2.5;

/** 默认主星质量：没在面板里设计过的工作区的底稿、全局首页都用它（与原型三档 fixture 同一个数） */
export const STAR_MASS_DEFAULT = 620;

/** 球体半径 ∝ (质量 / 密度)^(1/3) */
export function bodyRadius(mass: number, density: number): number {
  return Math.cbrt(mass / density);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 主星半径。density 缺席 = STAR_DENSITY（现有星系逐位不变）；给了（如红矮星：小而致密，真实的比邻星约 50 g/cm³）
 * 就按它算——小主星可以比自己的气态巨行星还小（璇玑星系规则：体积不受质量高低约束，高低以质量为准）。
 */
export function starRadius(mass: number, density: number = STAR_DENSITY): number {
  return bodyRadius(clamp(mass, STAR_MASS.min, STAR_MASS.max), density > 0 && Number.isFinite(density) ? density : STAR_DENSITY);
}

export function planetRadius(planet: { mass: number; composition: BodyComposition; density?: number }): number {
  const density = planet.density !== undefined && planet.density > 0 ? planet.density : DENSITY[planet.composition];
  return bodyRadius(clamp(planet.mass, PLANET_MASS.min, PLANET_MASS.max), density);
}

// ── 没设计过的工作区：主星多重 ───────────────────────────────────────────

/** 主星质量的档数：STAR_MASS.min–max 之间每 100 一档 */
export const STAR_MASS_STEPS = 8;

/**
 * 没设计过的工作区（planet/ 里还没有主星质量）画出来的那颗主星（界面质量单位）：以工作区 id 为种子，在
 * STAR_MASS_STEPS 档里取一档。界面的种子稿（设计面板、首页星系、侧栏头像）与主进程新建子智能体时找空轨、
 * 算行星质量上限，用的都是这一个函数——两边对同一颗星说同一个质量，新行星才不会落进界面画出的主星里。
 */
export function seededStarMass(workspaceId: string): number {
  // FNV-1a 32 位，与设计面板其余的种子（星环、日冕、行星预设）同一个哈希
  let hash = 2166136261;
  for (const ch of `${workspaceId}:star`) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const bits = hash >>> 0;
  return clamp(STAR_MASS.min + 100 * ((bits >>> 3) % STAR_MASS_STEPS), STAR_MASS.min, STAR_MASS.max);
}

// ── 行星不落进主星、不出行星区 ───────────────────────────────────────────

export interface OrbitClearanceInput {
  star: { mass: number; density?: number };
  planet: { mass: number; composition?: BodyComposition; density?: number; a: number; e: number };
}

export type OrbitClearance =
  | { ok: true }
  /** 近日距放不下两颗天体加间距（或偏心率不是数）；min = 合法的最小半长轴 */
  | { ok: false; kind: "collision"; min: number }
  /** 远日距连同行星半径出了行星区；max = 合法的最大半长轴 */
  | { ok: false; kind: "far"; max: number };

/** 一对天体（主星与行星）在给定偏心率下，半长轴的合法区间 */
export function orbitRange(input: {
  star: OrbitClearanceInput["star"];
  planet: Omit<OrbitClearanceInput["planet"], "a" | "e">;
  e: number;
}): { min: number; max: number } {
  const starR = starRadius(input.star.mass, input.star.density);
  const planetR = planetRadius({ mass: input.planet.mass, composition: input.planet.composition ?? "rock", density: input.planet.density });
  return {
    // 近日距 a(1−e) 至少放下两颗天体与间距
    min: (starR + planetR + MIN_CLEARANCE) / Math.max(1 - input.e, 1e-9),
    // 远日距 a(1+e) 连同行星半径留在行星区里
    max: (PLANET_ZONE - planetR) / (1 + input.e),
  };
}

/**
 * 一条轨道此刻合不合法：近日距 a(1−e) ≥ 主星半径 + 行星半径 + MIN_CLEARANCE，远日距 a(1+e) + 行星半径 ≤ PLANET_ZONE。
 * 设计面板逐条报错用它，新建子智能体挑空轨也用它——同一份数码，面板里合法的轨道主进程一定认，反过来也是。
 */
export function orbitClearance(input: OrbitClearanceInput): OrbitClearance {
  const e = input.planet.e;
  const a = input.planet.a;
  const { min, max } = orbitRange({ star: input.star, planet: input.planet, e });
  if (!Number.isFinite(a) || !Number.isFinite(e) || e < 0 || e > ORBIT_ECC_MAX || a < min) return { ok: false, kind: "collision", min };
  if (a > max) return { ok: false, kind: "far", max };
  return { ok: true };
}
