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
import { ORBIT_ECC_MAX, type OrbitSpec } from "./orbit-physics.ts";
import { PLANET_AGENTS_MAX } from "./planet-design.ts";

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

// ── 物理层与画面层：每个天体各带两个数 ─────────────────────────────────
//
// 画面层就是上面那一套（界面质量单位、画面半径、PLANET_ZONE）：只管画，保持卡通的样子——主星 30–100 M⊕、
// 行星 0.1–4 M⊕，质量比 1/15–1/1000，比真实宇宙夸张上万倍。拿这套数直接算希尔半径，相邻轨道要差 2.4–4.2 倍，
// 52 的行星区只放得下一两颗（2026-11-26）。
// 物理层只管规则（稳不稳、放不放得下、默认轨道）：主星按太阳质量 M☉、行星按 M⊕、轨道半长轴按 AU，希尔半径按真实比例算。
// 盘上格式不变（插件 planet-forge 读写同一份 design.json）：主星仍写 M⊕ 数 30–100，这里读作 0.3–1.0 M☉；
// 轨道仍写画面半径（19、45.5……），物理轨道由下面的对数映射现算，不落盘。偏心率两层共用一个数。

/** 界面质量单位 → M☉：主星 300–1000（盘上 30–100 M⊕）读作 0.3–1.0 M☉ */
export const STAR_UI_PER_SOLAR = 1000;
/** 1 M☉ = 333000 M⊕（算希尔半径时把主星换成 M⊕，与行星同一单位） */
export const EARTH_MASSES_PER_SOLAR = 333000;
/** 默认轨道相邻两条的半长轴之比（真实紧凑多行星系统相邻轨道约 1.3–1.8 倍，取紧的一端） */
export const ORBIT_LADDER_RATIO = 1.3;
/**
 * 1 M☉ 主星最内一条安全轨道（AU）：取水星（0.39 AU）的量级。其它主星按「同样受照」缩放：a ∝ √L，主序星 L ∝ M⁴，
 * 所以 a_in = 0.4 × M☉²（0.3 M☉ → 0.036 AU，与 TRAPPIST-1 这类红矮星系统的内行星同量级）。
 * 希尔判据只看轨道之比，与 a_in 的绝对值无关——这个数只决定面板上写的 AU。
 */
export const INNER_ORBIT_AU_AT_SOLAR = 0.4;
/** 物理行星区外缘 = 最后一条默认轨道再外推一档（留给面板往外拖、给偏心率留余量） */
export const ORBIT_LADDER_HEADROOM = 1;

/** 主星的物理质量（M☉）：界面质量单位夹进 STAR_MASS 后 ÷ 1000 */
export function starSolarMass(starUiMass: number): number {
  return clamp(Number.isFinite(starUiMass) ? starUiMass : STAR_MASS.min, STAR_MASS.min, STAR_MASS.max) / STAR_UI_PER_SOLAR;
}

/** 主星的物理质量换成 M⊕（与行星同单位，算希尔半径用） */
export function starPhysicalEarth(starUiMass: number): number {
  return starSolarMass(starUiMass) * EARTH_MASSES_PER_SOLAR;
}

/**
 * 主星越重带得越多：n = round(3 + 5 × (M☉ − 0.3) / 0.7)，0.3 → 3 颗、1.0 → 8 颗（= PLANET_AGENTS_MAX）。
 * 用整数的界面质量算，免得 0.65 这种正好在半档上的值被浮点误差舍错。
 */
export function starPlanetCapacity(starUiMass: number): number {
  const ui = starSolarMass(starUiMass) * STAR_UI_PER_SOLAR;
  const n = Math.round(3 + (5 * (Math.round(ui) - STAR_MASS.min)) / (STAR_MASS.max - STAR_MASS.min));
  return clamp(n, 3, PLANET_AGENTS_MAX);
}

/** 这颗主星的物理行星区（AU）：[a_in, a_in × 1.3^(n + HEADROOM − 1)]，n 条默认轨道正好铺在里面 */
export function physicalZone(starUiMass: number): { aIn: number; aOut: number; steps: number } {
  const solar = starSolarMass(starUiMass);
  const aIn = INNER_ORBIT_AU_AT_SOLAR * solar * solar;
  const steps = starPlanetCapacity(starUiMass) - 1 + ORBIT_LADDER_HEADROOM;
  return { aIn, aOut: aIn * ORBIT_LADDER_RATIO ** steps, steps };
}

/** 最大那种行星（PLANET_MASS.max 的气态）的画面半径：画面行星区的内缘要连它都放得下 */
const LARGEST_PLANET_RADIUS = bodyRadius(PLANET_MASS.max, DENSITY.gas);

/**
 * 画面行星区内缘按「画出来的大小」留的倍数（× 主星半径）。星系里的行星不按世界半径画，而是画成可读的卡通大小，
 * 最大到主星屏幕半径的 1 / (1.6 × 1.35)（galaxy.ts 的 STAR_OVER_PLANET × WAITING_SCALE，等你时放大的那颗）；
 * 默认俯角 40° 时近侧短轴被压到 sin 40° ≈ 0.64。近侧那颗不压到主星上要 a ≥ (1 + 1/2.16) / 0.64 ≈ 2.3 倍主星半径，
 * 再留一点透视与间距的余量取 2.5（1.0 M☉ → 22.4，与旧默认第一档 19 时「刚好贴着主星」的截图对得上）。
 */
export const DRAWN_INNER_PER_STAR_RADIUS = 2.5;

/**
 * 这颗主星的画面行星区：内缘 = max(默认密度的主星半径 + 间距 + 最大行星半径（世界半径不相撞），2.5 × 主星半径（画出来不压主星））；
 * 外缘 = PLANET_ZONE（保底 52，旧数据不被判出界）。只看质量不看密度：主进程读不到面板里改的密度，
 * 两边必须对同一条画面轨道说同一个 AU。
 */
export function displayZone(starUiMass: number): { dIn: number; dOut: number } {
  const star = starRadius(starUiMass);
  return { dIn: Math.max(star + MIN_CLEARANCE + LARGEST_PLANET_RADIUS, DRAWN_INNER_PER_STAR_RADIUS * star), dOut: PLANET_ZONE };
}

/**
 * 画面轨道半径 → 物理半长轴（AU）。对数映射：物理上等比的轨道在画面上等距，每 1.3 倍占画面区的 1/steps。
 * 在 (0, ∞) 与全体实数之间是单调双射，所以画面上的内外顺序永远等于物理顺序；区外的旧值（如落进主星的 4.5）照样有对应。
 */
export function displayToAu(starUiMass: number, display: number): number {
  const { aIn, steps } = physicalZone(starUiMass);
  const { dIn, dOut } = displayZone(starUiMass);
  return aIn * ORBIT_LADDER_RATIO ** (((display - dIn) / (dOut - dIn)) * steps);
}

/** 物理半长轴（AU）→ 画面轨道半径：displayToAu 的逆 */
export function auToDisplay(starUiMass: number, au: number): number {
  const { aIn, steps } = physicalZone(starUiMass);
  const { dIn, dOut } = displayZone(starUiMass);
  if (!(au > 0)) return au === 0 ? Number.NEGATIVE_INFINITY : Number.NaN;
  return dIn + ((dOut - dIn) * (Math.log(au / aIn) / Math.log(ORBIT_LADDER_RATIO))) / steps;
}

/** 第 k 条默认轨道（0 起）：物理 a_in × 1.3^k，画面直接按等距算（不经 log/exp，免得往返多出浮点尾数） */
export function ladderOrbit(starUiMass: number, k: number): { au: number; display: number } {
  const { aIn, steps } = physicalZone(starUiMass);
  const { dIn, dOut } = displayZone(starUiMass);
  return { au: aIn * ORBIT_LADDER_RATIO ** k, display: dIn + ((dOut - dIn) * k) / steps };
}

/**
 * 画面层的一条轨道（质量用界面质量单位、a 用画面半径）→ 物理层（质量 M⊕、a 用 AU）；e、ω 两层共用。
 * 设计面板判红黄绿与主进程找空轨都先过它，再交给 orbit-physics 的希尔判据，主星质量用 starPhysicalEarth。
 */
export function physicalOrbitOf(starUiMass: number, orbit: OrbitSpec): OrbitSpec {
  return { mass: orbit.mass / MASS_UNIT_PER_EARTH, a: displayToAu(starUiMass, orbit.a), e: orbit.e, omegaDeg: orbit.omegaDeg };
}
