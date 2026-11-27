/**
 * 共面开普勒轨道的纯计算：相邻轨道的相互希尔半径间距、滑块允许区间、周期与容量估算。
 * 主进程（新建子智能体找空轨）与 renderer（设计面板、公转）共用，单位只需各自一致。
 * 判据：2√3 R_H 以下禁止；2√3–10 R_H 允许但拥挤；10 R_H 以上舒适。
 */

export const ORBIT_HARD_RH = 2 * Math.sqrt(3);
export const ORBIT_SOFT_RH = 10;
export const ORBIT_ECC_MAX = 0.6;
/** 旧稿没有每轨偏心率时，沿用原型全局共用值与 +x 近日点方向 */
export const LEGACY_ORBIT_E = 0.3;
export const LEGACY_ORBIT_OMEGA_DEG = 0;

export interface OrbitSpec {
  mass: number;
  a: number;
  e: number;
  omegaDeg: number;
}

export interface StarSpec {
  mass: number;
}

export type OrbitLevel = "red" | "yellow" | "green";

export interface PairWarning {
  kind: "pair-gap";
  innerIndex: number;
  outerIndex: number;
  gapInRH: number;
  level: Exclude<OrbitLevel, "green">;
  crossed: boolean;
  /** 固定外圈 e 时，外圈 a 的硬 / 舒适下界 */
  minA: number;
  comfortA: number;
  /** 固定外圈 a 时，外圈 e 的硬上界；e=0 也不合法时为 NaN */
  maxE: number;
}

export interface SystemCheck {
  ok: boolean;
  warnings: PairWarning[];
}

export function mutualHillRadius(m1: number, m2: number, starMass: number, a1: number, a2: number): number {
  return Math.cbrt((m1 + m2) / (3 * starMass)) * ((a1 + a2) / 2);
}

export function pairGapInRH(inner: OrbitSpec, outer: OrbitSpec, starMass: number): number {
  const qOuter = outer.a * (1 - outer.e);
  const qInner = inner.a * (1 + inner.e);
  return (qOuter - qInner) / mutualHillRadius(inner.mass, outer.mass, starMass, inner.a, outer.a);
}

export function orbitLevel(gapInRH: number): OrbitLevel {
  if (!Number.isFinite(gapInRH) || gapInRH < ORBIT_HARD_RH) return "red";
  return gapInRH < ORBIT_SOFT_RH ? "yellow" : "green";
}

function bisect(lo: number, hi: number, keep: (value: number) => boolean): number {
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (keep(mid)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** lo 不安全、hi 安全：找最小的安全值 */
function bisectUnsafeLow(lo: number, hi: number, safe: (value: number) => boolean): number {
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (safe(mid)) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** 当前轨道作外圈：固定 e，满足 gap=k 的最小 a */
export function solveOuterA(inner: OrbitSpec, outer: OrbitSpec, starMass: number, k = ORBIT_HARD_RH): number {
  const cross = (inner.a * (1 + inner.e)) / Math.max(1 - outer.e, 1e-9);
  const safe = (a: number): boolean => pairGapInRH(inner, { ...outer, a }, starMass) >= k;
  if (safe(cross)) return cross;
  let hi = Math.max(cross * 2, inner.a * 4, cross + 1);
  for (let i = 0; i < 32 && !safe(hi); i++) hi *= 2;
  if (!safe(hi)) return Number.NaN;
  return bisectUnsafeLow(cross, hi, safe);
}

/** 当前轨道作内圈：固定 e，满足 gap=k 的最大 a */
export function solveInnerA(inner: OrbitSpec, outer: OrbitSpec, starMass: number, k = ORBIT_HARD_RH): number {
  const cross = (outer.a * (1 - outer.e)) / Math.max(1 + inner.e, 1e-9);
  if (cross <= 0) return Number.NaN;
  const safe = (a: number): boolean => pairGapInRH({ ...inner, a }, outer, starMass) >= k;
  if (!safe(0)) return Number.NaN;
  if (safe(cross)) return cross;
  return bisect(0, cross, safe);
}

/** 当前轨道作外圈：固定 a，满足硬间距的最大 e */
export function solveOuterE(inner: OrbitSpec, outer: OrbitSpec, starMass: number, k = ORBIT_HARD_RH): number {
  const safe = (e: number): boolean => pairGapInRH(inner, { ...outer, e }, starMass) >= k;
  if (!safe(0)) return Number.NaN;
  if (safe(ORBIT_ECC_MAX)) return ORBIT_ECC_MAX;
  return bisect(0, ORBIT_ECC_MAX, safe);
}

/** 当前轨道作内圈：固定 a，满足硬间距的最大 e */
export function solveInnerE(inner: OrbitSpec, outer: OrbitSpec, starMass: number, k = ORBIT_HARD_RH): number {
  const safe = (e: number): boolean => pairGapInRH({ ...inner, e }, outer, starMass) >= k;
  if (!safe(0)) return Number.NaN;
  if (safe(ORBIT_ECC_MAX)) return ORBIT_ECC_MAX;
  return bisect(0, ORBIT_ECC_MAX, safe);
}

export function checkSystem(star: StarSpec, planets: readonly OrbitSpec[]): SystemCheck {
  const order = planets.map((planet, index) => ({ planet, index })).sort((a, b) => a.planet.a - b.planet.a || a.index - b.index);
  const warnings: PairWarning[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const inner = order[i];
    const outer = order[i + 1];
    if (inner === undefined || outer === undefined) continue;
    const gap = pairGapInRH(inner.planet, outer.planet, star.mass);
    const level = orbitLevel(gap);
    if (level === "green") continue;
    warnings.push({
      kind: "pair-gap",
      innerIndex: inner.index,
      outerIndex: outer.index,
      gapInRH: gap,
      level,
      crossed: gap < 0,
      minA: solveOuterA(inner.planet, outer.planet, star.mass),
      comfortA: solveOuterA(inner.planet, outer.planet, star.mass, ORBIT_SOFT_RH),
      maxE: solveOuterE(inner.planet, outer.planet, star.mass),
    });
  }
  return { ok: warnings.every((warning) => warning.level !== "red"), warnings };
}

export interface OrbitLimits {
  /** 保持当前内外相邻关系时，a 的硬合法区间；无邻居的一侧为 ±Infinity */
  minA: number;
  maxA: number;
  /** a 的舒适区间；minA/maxA 之外、硬区间之内是黄区 */
  comfortMinA: number;
  comfortMaxA: number;
  /** e 越大越危险：硬 / 舒适上界；e=0 也排不下时为 NaN */
  maxE: number;
  comfortMaxE: number;
}

function neighbors(planets: readonly OrbitSpec[], index: number): { inner: OrbitSpec | null; outer: OrbitSpec | null } {
  const self = planets[index];
  if (self === undefined) return { inner: null, outer: null };
  const others = planets.map((planet, i) => ({ planet, i })).filter((item) => item.i !== index).sort((a, b) => a.planet.a - b.planet.a || a.i - b.i);
  let inner: OrbitSpec | null = null;
  let outer: OrbitSpec | null = null;
  for (const item of others) {
    if (item.planet.a <= self.a) inner = item.planet;
    else {
      outer = item.planet;
      break;
    }
  }
  return { inner, outer };
}

export function orbitLimits(star: StarSpec, planets: readonly OrbitSpec[], index: number): OrbitLimits {
  const self = planets[index];
  const { inner, outer } = neighbors(planets, index);
  if (self === undefined) {
    const nan = Number.NaN;
    return { minA: nan, maxA: nan, comfortMinA: nan, comfortMaxA: nan, maxE: nan, comfortMaxE: nan };
  }
  const minValues: number[] = [];
  const maxValues: number[] = [];
  const comfortMinValues: number[] = [];
  const comfortMaxValues: number[] = [];
  const eValues: number[] = [];
  const comfortEValues: number[] = [];
  if (inner !== null) {
    minValues.push(solveOuterA(inner, self, star.mass));
    comfortMinValues.push(solveOuterA(inner, self, star.mass, ORBIT_SOFT_RH));
    eValues.push(solveOuterE(inner, self, star.mass));
    comfortEValues.push(solveOuterE(inner, self, star.mass, ORBIT_SOFT_RH));
  } else minValues.push(Number.NEGATIVE_INFINITY);
  if (outer !== null) {
    maxValues.push(solveInnerA(self, outer, star.mass));
    comfortMaxValues.push(solveInnerA(self, outer, star.mass, ORBIT_SOFT_RH));
    eValues.push(solveInnerE(self, outer, star.mass));
    comfortEValues.push(solveInnerE(self, outer, star.mass, ORBIT_SOFT_RH));
  } else maxValues.push(Number.POSITIVE_INFINITY);
  return {
    minA: Math.max(...minValues),
    maxA: Math.min(...maxValues),
    comfortMinA: comfortMinValues.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...comfortMinValues),
    comfortMaxA: comfortMaxValues.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...comfortMaxValues),
    maxE: eValues.length === 0 ? ORBIT_ECC_MAX : Math.min(...eValues),
    comfortMaxE: comfortEValues.length === 0 ? ORBIT_ECC_MAX : Math.min(...comfortEValues),
  };
}

/** 单行星永远绿；多行星按 a 的硬 / 舒适区间给滑块当前值分档 */
export function levelForA(limits: OrbitLimits, a: number, single: boolean): OrbitLevel {
  if (single) return "green";
  if (!Number.isFinite(a) || a < limits.minA || a > limits.maxA) return "red";
  if (a < limits.comfortMinA || a > limits.comfortMaxA) return "yellow";
  return "green";
}

export function levelForE(limits: OrbitLimits, e: number, single: boolean): OrbitLevel {
  if (single) return "green";
  if (!Number.isFinite(e) || e < 0 || e > limits.maxE) return "red";
  return e > limits.comfortMaxE ? "yellow" : "green";
}

/** 开普勒第三定律的相对周期；a 用 AU、质量用太阳质量时单位就是年 */
export function orbitalPeriod(star: StarSpec, planet: Pick<OrbitSpec, "a" | "mass">): number {
  return Math.sqrt(planet.a ** 3 / (star.mass + planet.mass));
}

/** e=0、相邻行星等质量的简化容量估算（可选提示，不是硬上限） */
export function capacityEstimate(star: StarSpec, planetMass: number, aIn: number, aOut: number, k = ORBIT_SOFT_RH): number {
  const s = Math.cbrt((2 * planetMass) / (3 * star.mass));
  const rho = (1 + (k * s) / 2) / (1 - (k * s) / 2);
  if (!(rho > 1) || !(aOut > aIn) || aIn <= 0) return 0;
  return Math.max(0, Math.floor(Math.log(aOut / aIn) / Math.log(rho) + 1e-9));
}
