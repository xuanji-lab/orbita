import { isWindowInactive } from "../../shell/window-activity.ts";

/**
 * 首页星系（原型，proto/home-galaxy）的纯内核：天体、轨道、透视投影、按深度排序、动效闸门。
 * HomeGalaxy.tsx 只把这里算出的绘制表画成 SVG；所有可测的东西都在这里。
 *
 * 规则来源：用户逐句确认的「璇玑星系规则」（orbita-notes/orbita-universe-rules.md）——
 *   - 一个工作区一座星系，主星唯一、最大；行星（子智能体）的体积与质量必须明显小于主星。
 *   - 「类型」「成分」「质量」「轨道半径」分开：质量 + 成分（密度）定天体半径；轨道半径独立指定。
 *   - 主星与行星的质量区间互不重叠；轨道不交叉、天体不相撞，并留出能辨认彼此的间距。
 *
 * 为什么是「真 3D 坐标 + 透视投影 + SVG」而不是 Three.js：画的东西只有一颗星、≤12 颗行星、
 * 两条星屑路径和一百来段轨道弧，每帧算这些点是几十微秒的事；引入 WebGL 要多一个依赖、
 * 一块常驻 GPU 上下文，和设计系统「不让持续动效拖着整窗重合成」的纪律相冲。
 */

/** 成分只影响密度（同质量下的半径）与配色深浅，不决定智能体的性格或职责 */
export type Composition = "rock" | "ice" | "gas";

export interface PlanetSpec {
  id: string;
  /** 质量，夹进 PLANET_MASS 区间 */
  mass: number;
  composition: Composition;
  /** 轨道半径：用户独立指定（与天体半径同一单位）。违反间距规则时向外推，记进 adjusted */
  orbitRadius: number;
  /** 轨道面相对主星赤道面的小倾角（度）：让轨道不是一叠共面的同心椭圆 */
  inclinationDeg: number;
  /** 升交点经度（度）：倾斜朝哪个方向 */
  nodeDeg: number;
  /** t = 0 时在轨道上的相位（度） */
  phaseDeg: number;
  /**
   * 这颗行星背后那件活眼下的状态（真实数据：runStateOf）。只给「等你」画一圈细环——要你动手的那颗
   * 在一片墨色里认得出来；其它状态不加记号（状态优先图标与文字，那在侧栏行和页头胶囊里说）。缺席 = 没有状态
   */
  state?: PlanetState;
}

export type PlanetState = "waiting" | "running" | "done" | "failed" | null;

export interface GalaxySpec {
  starMass: number;
  planets: readonly PlanetSpec[];
  /** 这座星系里的会话数：只决定星屑的颗粒数（封顶）与浓淡，不逐条画 */
  sessions: number;
}

/** 主星与行星的质量区间互不重叠，且行星上限远低于主星下限 */
export const STAR_MASS = { min: 300, max: 1000 } as const;
export const PLANET_MASS = { min: 1, max: 40 } as const;
/** 主星的密度：主星成分固定（等离子），只有质量能调。星系设计面板也用它算主星半径 */
export const STAR_DENSITY = 1.4;
export const DENSITY: Readonly<Record<Composition, number>> = { rock: 5.5, ice: 2, gas: 1.3 };
/**
 * 一座星系最多画几圈轨道（几颗行星）。超出的计进 hidden，不画、不滚动、不缩放：9 圈以上的
 * 发丝线在 900×240 的带子里会叠成一个靶心（2026-11-23 视觉审查），6 圈还读得出「一圈一颗」。
 */
export const VISIBLE_ORBIT_CAP = 6;
/** 星屑颗粒上限：2000 条会话也只画这么多粒，多出来的量只让碎石带更浓（240 粒时与轨道一起成了靶心） */
export const DUST_CAP = 60;
/**
 * 统一画框（天体单位）：所有星系都装进这个半径里，相机与视口只按它定，不按某座星系自己的外缘——
 * 这样空 / 平常 / 满载三档的主星同大、同位，满载不会因为外缘变大把主星缩小。
 */
export const FRAME_EXTENT = 64;
/** 行星区外沿：再往外留给碎石带。用户给的轨道半径整体超出时按比例收进来（天体半径不缩） */
export const PLANET_ZONE = 52;
/** 空星系画一圈极淡的「预期落位轨道」：第一颗行星会落在这一带，空星系不至于读成一个 loading 球 */
export const EXPECTED_ORBIT = 22;
/** 相邻两个天体表面之间至少留的距离（与半径同单位） */
export const MIN_CLEARANCE = 2.5;
/** 开普勒第三定律的参考点：轨道半径 KEPLER_REF_RADIUS 处转一圈 KEPLER_REF_PERIOD_S 秒 */
export const KEPLER_REF_RADIUS = 20;
export const KEPLER_REF_PERIOD_S = 56;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DEG = Math.PI / 180;

/** 相机俯角与距离（距离 = 星系外缘半径的倍数）：俯角小一点显得安静，距离近一点透视才看得出 */
export const CAMERA_ELEVATION_DEG = 20;
export const CAMERA_DISTANCE_FACTOR = 3.2;

/** 球体半径 ∝ (质量 / 密度)^(1/3) */
export function bodyRadius(mass: number, density: number): number {
  return Math.cbrt(mass / density);
}

export function starRadius(mass: number): number {
  return bodyRadius(clamp(mass, STAR_MASS.min, STAR_MASS.max), STAR_DENSITY);
}

export function planetRadius(planet: Pick<PlanetSpec, "mass" | "composition">): number {
  return bodyRadius(clamp(planet.mass, PLANET_MASS.min, PLANET_MASS.max), DENSITY[planet.composition]);
}

/** 开普勒：ω ∝ a^(-3/2)。内圈快、外圈慢；整体很慢（最内圈一圈半分钟以上） */
export function angularSpeed(orbitRadius: number): number {
  return ((2 * Math.PI) / KEPLER_REF_PERIOD_S) * Math.pow(orbitRadius / KEPLER_REF_RADIUS, -1.5);
}

export interface OrbitBody {
  id: string;
  composition: Composition;
  state: PlanetState;
  radius: number;
  orbitRadius: number;
  inclination: number;
  node: number;
  phase: number;
  omega: number;
}

export interface DustParticle {
  r: number;
  theta0: number;
  z: number;
  omega: number;
}

export interface Belt {
  inner: number;
  outer: number;
  /** 真实会话数（可能远大于 particles.length） */
  count: number;
  particles: DustParticle[];
  /** 碎石带浓淡：随会话数取对数，有上限——量再大也只是「更浓」，不会更多对象 */
  alpha: number;
}

export interface GalaxyLayout {
  starRadius: number;
  planets: OrbitBody[];
  /** 超过 VISIBLE_ORBIT_CAP 没画的行星数 */
  hidden: number;
  /** 没有行星时的预期落位轨道半径；有行星时为 null */
  expectedOrbit: number | null;
  /** 用户给的轨道半径整体乘了多少才装进行星区（1 = 原样） */
  orbitScale: number;
  belt: Belt | null;
  /** 最外缘（碎石带外沿或最外轨道 + 行星半径） */
  extent: number;
  /** 轨道半径被向外推过的行星 id（用户给的半径违反了间距规则） */
  adjusted: string[];
}

/** 确定性的伪随机（mulberry32）：同一个会话数每次排出同一条碎石带，截图可复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function beltAlpha(count: number): number {
  if (count <= 0) return 0;
  return clamp(0.3 + 0.13 * Math.log10(count), 0.3, 0.72);
}

/**
 * 摆星系：按轨道半径排序，取最内的 VISIBLE_ORBIT_CAP 颗；轨道半径整体超出行星区时按同一比例收进来
 * （比例不变，用户指定的相对远近保留）；再逐圈检查「不相撞、留间距」，违反的向外推。
 * 两条圆轨道半径差 ≥ 两颗行星半径之和 + 间距时，无论倾角如何都不会相交（任一点到原点的距离
 * 分别恒为 a1、a2，两点距离 ≥ a2 − a1），所以只需管半径差。
 */
export function layoutGalaxy(spec: GalaxySpec): GalaxyLayout {
  const star = starRadius(spec.starMass);
  const sorted = [...spec.planets].sort((a, b) => a.orbitRadius - b.orbitRadius);
  const shown = sorted.slice(0, VISIBLE_ORBIT_CAP);
  const outermost = shown[shown.length - 1];
  const orbitScale =
    outermost === undefined ? 1 : Math.min(1, (PLANET_ZONE - planetRadius(outermost)) / outermost.orbitRadius);
  const planets: OrbitBody[] = [];
  const adjusted: string[] = [];
  let prevOrbit = 0;
  let prevRadius = star;
  for (const planet of shown) {
    const radius = planetRadius(planet);
    const minOrbit = prevOrbit + prevRadius + radius + MIN_CLEARANCE;
    const given = planet.orbitRadius * orbitScale;
    const orbitRadius = Math.max(given, minOrbit);
    if (orbitRadius !== given) adjusted.push(planet.id);
    planets.push({
      id: planet.id,
      composition: planet.composition,
      state: planet.state ?? null,
      radius,
      orbitRadius,
      inclination: clamp(planet.inclinationDeg, -8, 8) * DEG,
      node: planet.nodeDeg * DEG,
      phase: planet.phaseDeg * DEG,
      omega: angularSpeed(orbitRadius),
    });
    prevOrbit = orbitRadius;
    prevRadius = radius;
  }
  limitInclinations(planets);
  const expectedOrbit = planets.length === 0 ? EXPECTED_ORBIT : null;
  const lastEdge = expectedOrbit ?? prevOrbit + prevRadius;
  let belt: Belt | null = null;
  const sessions = Math.max(0, Math.floor(spec.sessions));
  if (sessions > 0) {
    const inner = lastEdge + MIN_CLEARANCE * 2;
    const outer = Math.max(FRAME_EXTENT, inner + 6);
    const rand = seeded(9173);
    const particles: DustParticle[] = [];
    const n = Math.min(sessions, DUST_CAP);
    for (let i = 0; i < n; i++) {
      const r = inner + rand() * (outer - inner);
      particles.push({
        r,
        theta0: rand() * Math.PI * 2,
        z: (rand() - 0.5) * (outer - inner) * 0.14,
        omega: angularSpeed(r),
      });
    }
    belt = { inner, outer, count: sessions, particles, alpha: beltAlpha(sessions) };
  }
  return {
    starRadius: star,
    planets,
    hidden: Math.max(0, sorted.length - VISIBLE_ORBIT_CAP),
    expectedOrbit,
    orbitScale,
    belt,
    extent: belt === null ? lastEdge : belt.outer,
    adjusted,
  };
}

/**
 * 倾角上限：三维里两条轨道只要半径差够就不会相交，但投到画面上，倾得太多的两圈会在近侧 / 远侧
 * 「交叉」——用户的规则是「轨道之间不得交叉」，看的人只看画面。所以按相机俯角收住每颗行星的倾角：
 * 相邻两圈在近侧 / 远侧的竖向间隔约 Δa·sin(e)，倾角带来的竖向偏移约 a·sin(i)·cos(e)，
 * 两颗各占不到 40%，画面上就永远是一圈套一圈（透视让它们不同心，倾角让它们不共面）。
 */
function limitInclinations(planets: OrbitBody[]): void {
  const tanE = Math.tan(CAMERA_ELEVATION_DEG * DEG);
  for (let i = 0; i < planets.length; i++) {
    const self = planets[i];
    if (self === undefined) continue;
    let limit = Infinity;
    for (const other of [planets[i - 1], planets[i + 1]]) {
      if (other === undefined) continue;
      const gap = Math.abs(other.orbitRadius - self.orbitRadius);
      const outer = Math.max(other.orbitRadius, self.orbitRadius);
      limit = Math.min(limit, Math.asin(Math.min(1, (0.4 * gap * tanE) / outer)));
    }
    if (Math.abs(self.inclination) > limit) self.inclination = Math.sign(self.inclination) * limit;
  }
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 轨道面内角度 theta 处的点：先在平面内，再绕升交点线倾斜 inclination */
export function orbitPoint(a: number, inclination: number, node: number, theta: number): Vec3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  const ci = Math.cos(inclination);
  return {
    x: a * (cn * c - sn * s * ci),
    y: a * (sn * c + cn * s * ci),
    z: a * s * Math.sin(inclination),
  };
}

/**
 * 相机：在 y 轴负方向、抬高 elevation 俯看原点。世界坐标 z 朝上、y 朝远处。
 * 近处（y < 0）的轨道段投在下方且更大——这就是透视，不是把圆压扁成椭圆。
 */
export interface Camera {
  elevation: number;
  distance: number;
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

export function makeCamera(extent: number, elevationDeg = CAMERA_ELEVATION_DEG, distanceFactor = CAMERA_DISTANCE_FACTOR): Camera {
  const e = elevationDeg * DEG;
  const distance = Math.max(extent, 1) * distanceFactor;
  return {
    elevation: e,
    distance,
    position: { x: 0, y: -distance * Math.cos(e), z: distance * Math.sin(e) },
    forward: { x: 0, y: Math.cos(e), z: -Math.sin(e) },
    up: { x: 0, y: Math.sin(e), z: Math.cos(e) },
  };
}

export interface Projected {
  /** 归一化屏幕坐标（乘焦距再平移才是像素）；sy 向下为正 */
  sx: number;
  sy: number;
  /** 沿视线的距离：越大越远 */
  depth: number;
}

export function project(p: Vec3, camera: Camera): Projected {
  const rx = p.x - camera.position.x;
  const ry = p.y - camera.position.y;
  const rz = p.z - camera.position.z;
  const depth = rx * camera.forward.x + ry * camera.forward.y + rz * camera.forward.z;
  const up = rx * camera.up.x + ry * camera.up.y + rz * camera.up.z;
  return { sx: rx / depth, sy: -up / depth, depth };
}

export interface Viewport {
  width: number;
  height: number;
  focal: number;
  cx: number;
  cy: number;
}

/**
 * 整座星系（统一画框）在画布上占多大：由**容器的真实尺寸**决定（ResizeObserver 量出来），
 * 四周各留 GALAXY_MARGIN，并封顶 GALAXY_MAX——大屏上不至于把一颗球放到半个屏幕。
 * 只看容器、不看星系里有几颗行星，所以空 / 平常 / 满载在同一块地方主星一样大、圆心一样。
 */
export const GALAXY_MARGIN = 24;
export const GALAXY_MAX = { width: 1280, height: 460 } as const;
/** 工作区页（星系占输入框上方整块）的封顶：高度放宽，窗口一高星系跟着长，不留大块死白；宽度同上 */
export const GALAXY_MAX_FILL = { width: 1280, height: 720 } as const;

/**
 * 相机俯角随画框形状变（工作区页：星系占输入框上方整块，窗口一高，20° 的扁椭圆上下各留一大块白）：
 * 画框越「方」俯角越大，椭圆越圆、越能填满竖向；扁的画框（全局首页那条带子）保持 20°。
 * 夹在 [CAMERA_ELEVATION_DEG, ELEVATION_MAX]：再高就成了俯视的靶心，读不出「绕着转」。
 * 只抬俯角、不压：limitInclinations 按 20° 收的倾角在更高的俯角下竖向间隔只会更大，轨道照样不交叉。
 */
export const ELEVATION_MAX = 38;

export function elevationFor(box: { width: number; height: number }): number {
  const ratio = box.height / Math.max(box.width, 1);
  const fit = (Math.asin(clamp(ratio * 0.92, 0, 1)) * 180) / Math.PI;
  return clamp(fit, CAMERA_ELEVATION_DEG, ELEVATION_MAX);
}

export function galaxyBox(
  width: number,
  height: number,
  max: { width: number; height: number } = GALAXY_MAX,
): { width: number; height: number } {
  return {
    width: clamp(width - GALAXY_MARGIN * 2, 1, max.width),
    height: clamp(height - GALAXY_MARGIN * 2, 1, max.height),
  };
}

/**
 * 统一视口：只按统一画框（FRAME_EXTENT 一圈）定焦距与中心，不看某座星系自己的外缘。
 * 于是同一块画布上三档的主星同一个像素半径、同一个中心；星系本身再大也装在 box 里（layoutGalaxy 保证
 * 外缘不超过画框）。框在画布里水平、垂直都居中。画布变大，整座星系（主星、行星、轨道）等比变大。
 */
export function frameViewport(
  camera: Camera,
  width: number,
  height: number,
  box: { width: number; height: number } = galaxyBox(width, height),
): Viewport {
  const pts: Projected[] = [];
  for (let i = 0; i < 144; i++) pts.push(project(orbitPoint(FRAME_EXTENT, 0, 0, (i / 144) * Math.PI * 2), camera));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.sx);
    maxX = Math.max(maxX, p.sx);
    minY = Math.min(minY, p.sy);
    maxY = Math.max(maxY, p.sy);
  }
  const focal = Math.min(box.width / Math.max(maxX - minX, 1e-6), box.height / Math.max(maxY - minY, 1e-6));
  return {
    width,
    height,
    focal,
    cx: width / 2 - (focal * (minX + maxX)) / 2,
    cy: height / 2 - (focal * (minY + maxY)) / 2,
  };
}

function toScreen(p: Projected, vp: Viewport): { x: number; y: number } {
  return { x: vp.cx + vp.focal * p.sx, y: vp.cy + vp.focal * p.sy };
}

function round1(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

/** 预期落位轨道的 planetId（它没有行星） */
export const EXPECTED_ID = "expected";

export interface OrbitArc {
  kind: "orbit";
  key: string;
  planetId: string;
  /** 空星系的预期落位轨道：画得极淡 */
  expected: boolean;
  /** 这段弧在轨道面里的角度区间 [from, to) */
  from: number;
  to: number;
  depth: number;
  d: string;
}

export interface StarItem {
  kind: "star";
  key: string;
  depth: number;
  x: number;
  y: number;
  r: number;
}

export interface PlanetItem {
  kind: "planet";
  key: string;
  planetId: string;
  composition: Composition;
  state: PlanetState;
  depth: number;
  x: number;
  y: number;
  r: number;
  /** 受光面朝向（径向渐变焦点，0..1） */
  fx: number;
  fy: number;
  /** 从相机看到的受光比例（位相）：1 = 在主星远侧、整面亮；0 = 挡在主星前、只看到背光面 */
  lit: number;
}

export interface DustItem {
  kind: "dust";
  key: "dust-back" | "dust-front";
  depth: number;
  d: string;
  alpha: number;
}

export type DrawItem = OrbitArc | StarItem | PlanetItem | DustItem;

export const ARCS_PER_ORBIT = 16;

/**
 * 轨道是静止的几何：每条拆成 ARCS_PER_ORBIT 段，各带自己的平均深度。分段是为了遮挡——
 * 远半圈画在主星后面、近半圈画在前面；不分段的话整条轨道只能整体在前或在后。
 */
export function orbitArcs(layout: GalaxyLayout, camera: Camera, vp: Viewport, samplesPerArc = 6): OrbitArc[] {
  const arcs: OrbitArc[] = [];
  const span = (Math.PI * 2) / ARCS_PER_ORBIT;
  const rings = layout.planets.map((p) => ({ id: p.id, a: p.orbitRadius, inclination: p.inclination, node: p.node, expected: false }));
  if (layout.expectedOrbit !== null) {
    rings.push({ id: EXPECTED_ID, a: layout.expectedOrbit, inclination: 0, node: 0, expected: true });
  }
  for (const planet of rings) {
    for (let k = 0; k < ARCS_PER_ORBIT; k++) {
      const from = k * span;
      let d = "";
      let depthSum = 0;
      for (let i = 0; i <= samplesPerArc; i++) {
        const theta = from + (span * i) / samplesPerArc;
        const projected = project(orbitPoint(planet.a, planet.inclination, planet.node, theta), camera);
        const { x, y } = toScreen(projected, vp);
        d += `${i === 0 ? "M" : "L"}${round1(x)} ${round1(y)}`;
        depthSum += projected.depth;
      }
      arcs.push({
        kind: "orbit",
        key: `orbit-${planet.id}-${k}`,
        planetId: planet.id,
        expected: planet.expected,
        from,
        to: from + span,
        depth: depthSum / (samplesPerArc + 1),
        d,
      });
    }
  }
  return arcs;
}

function normalizeAngle(theta: number): number {
  const twoPi = Math.PI * 2;
  return ((theta % twoPi) + twoPi) % twoPi;
}

function dustPath(points: { x: number; y: number; r: number }[]): string {
  let d = "";
  for (const p of points) {
    const r = round1(p.r);
    d += `M${round1(p.x - p.r)} ${round1(p.y)}a${r} ${r} 0 1 0 ${round1(p.r * 2)} 0a${r} ${r} 0 1 0 ${round1(-p.r * 2)} 0`;
  }
  return d;
}

/**
 * 某一时刻的绘制表，按深度从远到近排好（画家算法）。
 * 行星压在自己的轨道线上：与它相邻的三段自家轨道弧的排序深度不小于行星，先画；
 * 否则一段「更近」的弧会从行星中间划过去。
 */
export function drawFrame(layout: GalaxyLayout, camera: Camera, vp: Viewport, arcs: readonly OrbitArc[], t: number): DrawItem[] {
  const starP = project({ x: 0, y: 0, z: 0 }, camera);
  const starS = toScreen(starP, vp);
  const items: DrawItem[] = [
    { kind: "star", key: "star", depth: starP.depth, x: starS.x, y: starS.y, r: (vp.focal * layout.starRadius) / starP.depth },
  ];
  const planetAngle = new Map<string, { theta: number; depth: number }>();
  for (const planet of layout.planets) {
    const theta = planet.phase + planet.omega * t;
    const world = orbitPoint(planet.orbitRadius, planet.inclination, planet.node, theta);
    const p = project(world, camera);
    const s = toScreen(p, vp);
    // 受光：主星在原点。屏幕上亮面朝主星；从相机看到多少亮面 = 「指向主星」与「指向相机」的夹角
    const toStar = { x: -world.x, y: -world.y, z: -world.z };
    const toCam = { x: camera.position.x - world.x, y: camera.position.y - world.y, z: camera.position.z - world.z };
    const ls = Math.hypot(toStar.x, toStar.y, toStar.z) || 1;
    const lc = Math.hypot(toCam.x, toCam.y, toCam.z) || 1;
    const cosPhase = (toStar.x * toCam.x + toStar.y * toCam.y + toStar.z * toCam.z) / (ls * lc);
    const dx = starS.x - s.x;
    const dy = starS.y - s.y;
    const dl = Math.hypot(dx, dy) || 1;
    items.push({
      kind: "planet",
      key: `planet-${planet.id}`,
      planetId: planet.id,
      composition: planet.composition,
      state: planet.state,
      depth: p.depth,
      x: s.x,
      y: s.y,
      r: (vp.focal * planet.radius) / p.depth,
      fx: 0.5 + (0.32 * dx) / dl,
      fy: 0.5 + (0.32 * dy) / dl,
      lit: (1 + cosPhase) / 2,
    });
    planetAngle.set(planet.id, { theta: normalizeAngle(theta), depth: p.depth });
  }
  const span = (Math.PI * 2) / ARCS_PER_ORBIT;
  for (const arc of arcs) {
    const owner = planetAngle.get(arc.planetId);
    let depth = arc.depth;
    if (owner !== undefined) {
      const home = Math.floor(owner.theta / span);
      const k = Math.round(arc.from / span);
      const near = k === home || (k + 1) % ARCS_PER_ORBIT === home || (home + 1) % ARCS_PER_ORBIT === k;
      if (near) depth = Math.max(depth, owner.depth + 1e-6);
    }
    items.push(depth === arc.depth ? arc : { ...arc, depth });
  }
  if (layout.belt !== null) {
    const back: { x: number; y: number; r: number }[] = [];
    const front: { x: number; y: number; r: number }[] = [];
    let backDepth = 0;
    let frontDepth = 0;
    for (const particle of layout.belt.particles) {
      const theta = particle.theta0 + particle.omega * t;
      const p = project({ x: particle.r * Math.cos(theta), y: particle.r * Math.sin(theta), z: particle.z }, camera);
      const s = toScreen(p, vp);
      // 星屑随画布放大而变清楚（每单位像素 × 0.22，夹在 0.6–2.2px 之间），近大远小
      const point = { x: s.x, y: s.y, r: clamp((vp.focal * 0.22) / p.depth, 0.6, 2.2) };
      if (p.depth > starP.depth) {
        back.push(point);
        backDepth += p.depth;
      } else {
        front.push(point);
        frontDepth += p.depth;
      }
    }
    if (back.length > 0) {
      items.push({ kind: "dust", key: "dust-back", depth: backDepth / back.length, d: dustPath(back), alpha: layout.belt.alpha });
    }
    if (front.length > 0) {
      items.push({ kind: "dust", key: "dust-front", depth: frontDepth / front.length, d: dustPath(front), alpha: layout.belt.alpha });
    }
  }
  return items.sort((a, b) => b.depth - a.depth);
}

/**
 * 动效闸门：只有「窗口在前台且可见 + 星系在视口里 + 没要求减少动效」才跑。
 * 设计系统 *Motion*：持续动效在窗口不在前台时暂停——没人看的转动照样吃 GPU。
 * 「窗口在不在前台」与全局的 .anim-continuous 暂停用同一个判定（shell/window-activity.ts）。
 */
export interface MotionInputs {
  hasFocus: boolean;
  visibilityState: DocumentVisibilityState;
  onScreen: boolean;
  reducedMotion: boolean;
}

export function motionAllowed(inputs: MotionInputs): boolean {
  return !isWindowInactive(inputs) && inputs.onScreen && !inputs.reducedMotion;
}

/** 两次重绘之间至少隔这么久（约 30 帧/秒）：天体走得很慢，60 帧只是多一倍重合成 */
export const FRAME_MS = 33;
/** 一帧最多推进这么多：卡顿或后台节流后恢复时不跳一大截 */
export const MAX_STEP_MS = 100;

/** 只在跑的时候走表：暂停期间不计时，恢复后第一帧（last 为 null）不推进 */
export function advanceClock(elapsedMs: number, lastMs: number | null, nowMs: number): number {
  if (lastMs === null) return elapsedMs;
  return elapsedMs + clamp(nowMs - lastMs, 0, MAX_STEP_MS);
}

/** 原型专用：`?galaxy=empty|typical|full` 切三档 fixture；不带参数时用 typical */
export type GalaxyFixture = "empty" | "typical" | "full";

export function galaxyFixtureOf(search: string): GalaxyFixture | null {
  const value = new URLSearchParams(search).get("galaxy");
  return value === "empty" || value === "typical" || value === "full" ? value : null;
}

const TYPICAL_PLANETS: PlanetSpec[] = [
  { id: "p1", mass: 2.4, composition: "rock", orbitRadius: 17, inclinationDeg: 4.5, nodeDeg: 20, phaseDeg: 200 },
  { id: "p2", mass: 14, composition: "gas", orbitRadius: 27, inclinationDeg: -3, nodeDeg: 140, phaseDeg: 320 },
  { id: "p3", mass: 4, composition: "ice", orbitRadius: 38, inclinationDeg: 6, nodeDeg: 260, phaseDeg: 70 },
  { id: "p4", mass: 7, composition: "rock", orbitRadius: 50, inclinationDeg: -4.5, nodeDeg: 80, phaseDeg: 150 },
];

const COMPOSITIONS: readonly Composition[] = ["rock", "gas", "ice"];

function fullPlanets(): PlanetSpec[] {
  const planets: PlanetSpec[] = [];
  for (let i = 0; i < 12; i++) {
    planets.push({
      id: `p${i + 1}`,
      mass: [2, 9, 3.5, 22, 5, 1.6, 30, 6, 12, 2.8, 18, 4][i] ?? 3,
      composition: COMPOSITIONS[(i * 7) % 3] ?? "rock",
      orbitRadius: 15 + i * 9.5 + i * i * 0.35,
      inclinationDeg: (((i * 37) % 13) - 6) * 0.9,
      nodeDeg: (i * 83) % 360,
      phaseDeg: (i * 137) % 360,
    });
  }
  return planets;
}

export function galaxySpecOf(fixture: GalaxyFixture): GalaxySpec {
  if (fixture === "empty") return { starMass: 620, planets: [], sessions: 0 };
  // 满载：12 颗行星（只画最内 6 圈，其余计 hidden）、2000 条会话。主星质量与平常档相同——
  // 主星大小只由质量定，不因为星系热闹就变大或变小
  if (fixture === "full") return { starMass: 620, planets: fullPlanets(), sessions: 2000 };
  return { starMass: 620, planets: TYPICAL_PLANETS, sessions: 14 };
}
