import { checkSystem, orbitLimits, ORBIT_ECC_MAX, type OrbitLevel, type OrbitSpec } from "../../../../shared/orbit-physics.ts";
import { commitPlanet, maxOrbit, minOrbit, normalizeDesign, orbitEccentricityOf, orbitSpecOf, periapsisOf, type GalaxyDesign, type PlanetDesign } from "./design.ts";

export type OrbitField = "a" | "e" | "omega";

export interface OrbitUiStatus {
  level: OrbitLevel;
  minA: number;
  maxA: number;
  comfortMinA: number;
  comfortMaxA: number;
  maxE: number;
  comfortMaxE: number;
  /** 与最挤邻居的间距；没有邻居为 Infinity */
  closestGap: number;
}

export function designPlanets(design: GalaxyDesign): readonly PlanetDesign[] {
  return design.planets ?? (design.planet === null ? [] : [design.planet]);
}

export function designOrbitSpecs(design: GalaxyDesign): OrbitSpec[] {
  return designPlanets(design).map(orbitSpecOf);
}

function currentIndex(design: GalaxyDesign): number {
  return Math.max(0, Math.min(design.planetIndex ?? 0, Math.max(0, designPlanets(design).length - 1)));
}

/** 增大 e 时近日点更近、远日点更远：主星碰撞与出行星区共同给一个物理上限 */
function maxEForBody(design: GalaxyDesign): number {
  if (design.planet === null) return Number.NaN;
  const a = design.planet.orbitRadius;
  const e0 = orbitEccentricityOf(design.planet);
  const innerClearance = minOrbit(design) * (1 - e0);
  const outerClearance = maxOrbit(design) * (1 + e0);
  const safe = (e: number): boolean => Number.isFinite(a) && a * (1 - e) >= innerClearance && a * (1 + e) <= outerClearance;
  if (!safe(0)) return Number.NaN;
  if (safe(ORBIT_ECC_MAX)) return ORBIT_ECC_MAX;
  let lo = 0;
  let hi = ORBIT_ECC_MAX;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (safe(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function orbitUiStatus(design: GalaxyDesign): OrbitUiStatus {
  const planets = designPlanets(design);
  const specs = designOrbitSpecs(design);
  const index = currentIndex(design);
  const self = specs[index];
  const limits = orbitLimits({ mass: design.star?.mass ?? 1 }, specs, index);
  const single = planets.length <= 1;
  const minA = Math.max(limits.minA, minOrbit(design));
  const maxA = Math.min(limits.maxA, maxOrbit(design));
  const comfortMinA = Math.max(limits.comfortMinA, minOrbit(design));
  const comfortMaxA = Math.min(limits.comfortMaxA, maxOrbit(design));
  const a = self?.a ?? Number.NaN;
  const level = single && Number.isFinite(a) && a >= minOrbit(design) && a <= maxOrbit(design)
    ? "green"
    : !Number.isFinite(a) || a < minA || a > maxA
      ? "red"
      : a < comfortMinA || a > comfortMaxA
        ? "yellow"
        : "green";
  const bodyMaxE = maxEForBody(design);
  const maxE = Math.min(limits.maxE, bodyMaxE);
  const comfortMaxE = Math.min(limits.comfortMaxE, bodyMaxE);
  const warnings = self === undefined ? [] : checkSystem({ mass: design.star?.mass ?? 1 }, specs).warnings.filter((warning) => warning.innerIndex === index || warning.outerIndex === index);
  return {
    level,
    minA,
    maxA,
    comfortMinA,
    comfortMaxA,
    maxE,
    comfortMaxE,
    closestGap: warnings.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...warnings.map((warning) => warning.gapInRH)),
  };
}

export function eccentricityLevel(status: OrbitUiStatus, e: number, single: boolean): OrbitLevel {
  if (!Number.isFinite(e) || e < 0 || e > status.maxE) return "red";
  if (single) return "green";
  return e > status.comfortMaxE ? "yellow" : "green";
}

export function withOrbitValue(design: GalaxyDesign, field: OrbitField, value: number): GalaxyDesign {
  if (design.planet === null) return design;
  const planet = field === "a" ? { ...design.planet, orbitRadius: value } : field === "e" ? { ...design.planet, eccentricity: value } : { ...design.planet, periapsisDeg: value };
  return normalizeDesign(commitPlanet({ ...design, planet }));
}

export type BounceResult =
  | { kind: "kept" | "omega"; design: GalaxyDesign }
  | { kind: "a-min" | "a-max" | "e-max"; design: GalaxyDesign; value: number }
  | { kind: "no-room"; design: GalaxyDesign };

function outward(value: number, digits: number, direction: "up" | "down"): number {
  const k = 10 ** digits;
  return (direction === "up" ? Math.ceil(value * k - 1e-9) : Math.floor(value * k + 1e-9)) / k;
}

/** 松手时取最近的硬合法值；当前 e 下根本没有合法 a 时回之前那份，并交给面板提示怎么腾位置 */
export function bounceOrbit(current: GalaxyDesign, previous: GalaxyDesign, field: OrbitField): BounceResult {
  if (field === "omega") return { kind: "omega", design: current };
  const status = orbitUiStatus(current);
  if (status.level !== "red") return { kind: "kept", design: current };
  if (field === "a") {
    if (current.planet !== null && current.planet.orbitRadius < status.minA && Number.isFinite(status.minA)) {
      const value = outward(status.minA, 2, "up");
      const next = withOrbitValue(current, "a", value);
      if (orbitUiStatus(next).level !== "red") return { kind: "a-min", design: next, value };
    }
    if (current.planet !== null && current.planet.orbitRadius > status.maxA && Number.isFinite(status.maxA)) {
      const value = outward(status.maxA, 2, "down");
      const next = withOrbitValue(current, "a", value);
      if (orbitUiStatus(next).level !== "red") return { kind: "a-max", design: next, value };
    }
  } else if (current.planet !== null && Number.isFinite(status.maxE)) {
    const value = outward(Math.min(current.planet.eccentricity ?? ORBIT_ECC_MAX, status.maxE), 2, "down");
    const next = withOrbitValue(current, "e", value);
    if (eccentricityLevel(orbitUiStatus(next), value, designPlanets(next).length <= 1) !== "red") return { kind: "e-max", design: next, value };
  }
  return { kind: "no-room", design: previous };
}

/** a 滑块的五段轨道：红 / 黄 / 绿 / 黄 / 红；返回值是 CSS linear-gradient 的 stops */
export function orbitTrackStops(status: OrbitUiStatus, min: number, max: number): { color: OrbitLevel; at: number }[] {
  const clampAt = (value: number): number => Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const hardLo = clampAt(status.minA);
  const hardHi = clampAt(status.maxA);
  if (Number.isNaN(hardLo) || Number.isNaN(hardHi) || hardLo > hardHi) return [{ color: "red", at: 0 }, { color: "red", at: 100 }];
  let softLo = clampAt(status.comfortMinA);
  let softHi = clampAt(status.comfortMaxA);
  // 没有绿区：绿段宽度收成 0，不能把渐变 stop 写倒
  if (softLo > softHi) {
    softLo = hardLo;
    softHi = hardLo;
  }
  softLo = Math.max(hardLo, Math.min(hardHi, softLo));
  softHi = Math.max(softLo, Math.min(hardHi, softHi));
  return [
    { color: "red", at: 0 },
    { color: "red", at: hardLo },
    { color: "yellow", at: hardLo },
    { color: "yellow", at: softLo },
    { color: "green", at: softLo },
    { color: "green", at: softHi },
    { color: "yellow", at: softHi },
    { color: "yellow", at: hardHi },
    { color: "red", at: hardHi },
    { color: "red", at: 100 },
  ];
}

export function omegaOf(design: GalaxyDesign): number {
  return design.planet === null ? 0 : periapsisOf(design.planet);
}
