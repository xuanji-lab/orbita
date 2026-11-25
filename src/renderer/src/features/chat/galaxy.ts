import { isWindowInactive } from "../../shell/window-activity.ts";
// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { GALAXY_ZOOM } from "../../../../shared/settings.ts";
import { LEGACY_ORBIT_E, LEGACY_ORBIT_OMEGA_DEG, orbitalPeriod } from "../../../../shared/orbit-physics.ts";
import {
  DENSITY,
  MIN_CLEARANCE,
  PLANET_MASS,
  PLANET_ZONE,
  STAR_DENSITY,
  STAR_MASS,
  bodyRadius,
  planetRadius,
  starRadius,
  type BodyComposition,
} from "../../../../shared/galaxy-scale.ts";

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
export type Composition = BodyComposition;

export interface PlanetSpec {
  id: string;
  /** 质量，夹进 PLANET_MASS 区间 */
  mass: number;
  composition: Composition;
  /** 密度（g/cm³）：星系设计面板按元素构成推出来的；缺席按成分类别（DENSITY） */
  density?: number;
  /** 轨道半径：用户独立指定（与天体半径同一单位）。违反间距规则时向外推，记进 adjusted */
  orbitRadius: number;
  /** 每颗自己的偏心率与近日点方向；给了就走独立轨道布局，不再套全局轨道 */
  eccentricity?: number;
  periapsisDeg?: number;
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
  /** 这件活的名字（会话标题）：只给「等你」「在跑」的行星常显，其余悬停才显示（HomeGalaxy 决定）；缺席 = 没名字 */
  label?: string;
}

export type PlanetState = "waiting" | "running" | "done" | "failed" | null;

/**
 * 一块「在做事的碎石」：编排的星系里行星是子智能体，会话是碎石；在跑 / 等你的会话从碎石带里单独拎出来画一块，
 * 锁定框与引线标在它身上（其余会话仍是一整条不逐颗可点的星屑）。
 */
/**
 * 碎石块的三种：等你 / 在跑（在做事，实线角括号锁定框）、recent（最近的几条但没在做事：轻一档的虚线框、次级墨，
 * 2026-11-24 用户：「最近的 session 和工作的 session 可以被框中和伸出一根线标记 session 名字」）
 */
export type RockState = "waiting" | "running" | "recent";

export interface RockSpec {
  id: string;
  state: RockState;
  /** 会话标题（引线上写它） */
  label: string;
  /**
   * 子会话拎成的碎石块：它不在 spec.sessions（= 这座星系的根会话数，与右栏树主卡同源）里，
   * 所以不从碎石带的颗粒数里扣
   */
  child?: boolean;
}

/** 碎石带里的一条会话 */
export interface DustSeed {
  id: string;
  /** 会话标题（悬停提示与读屏用）；缺席 = 没有标题 */
  title?: string;
}

export interface GalaxySpec {
  starMass: number;
  /** 主星密度（g/cm³）：缺席 = STAR_DENSITY。红矮星式的小致密主星给一个大的数（引力扫描 / 「大行星浅坑」演示） */
  starDensity?: number;
  planets: readonly PlanetSpec[];
  /** 主星连星环 / 日冕的外缘（世界单位）；缺席 = 主星半径。第一圈轨道不得压进这个外缘 */
  starExtent?: number;
  /** 这座星系里的会话数：决定碎石带的宽窄（beltGrowthOf）、颗粒数与浓淡 */
  sessions: number;
  /**
   * 进碎石带的那些会话（新的在前）：一颗碎石 = 一条会话，同一条会话永远在同一个方位角（按 id 取），
   * 越老越靠外圈。缺席 = 只有数（原型 fixture），按序号造假 id
   */
  dust?: readonly DustSeed[];
  /** 在做事的会话（单独画成碎石块，带锁定框）；它们也计在 sessions 里 */
  rocks?: readonly RockSpec[];
  /** 碎石带内沿的下限（世界单位）：屏幕安全布局按屏幕间距算出来的；缺席 = 只按世界间距 */
  beltInner?: number;
  /**
   * 轨道偏心率（开普勒椭圆，编排页按 proto-variants 的 orbitE 传，默认 0.3）：主星在椭圆的一个焦点上，所有轨道（连碎石带）
   * 共用这个偏心率与同一个近日点方向（+x，画面右侧）——以主星为中心的位似椭圆，天然不相交；行星近主星快、远主星慢。
   * 缺席 = 0（正圆轨道）
   */
  eccentricity?: number;
  /**
   * 碎石带里实际画出来的比例（设置 › 外观 › 碎石密度：1 / 0.5 / 0.1 / 0）。只删减碎石带里的普通会话；在跑、等你、最近的是碎石块（rocks），
   * 永远画。按会话 id 确定性抽样（dustKept），同一条会话今天画、明天也画；带子宽窄、浓淡、「全部 N 条会话」的计数都按全部会话算。缺席 = 1
   */
  dustKeep?: number;
}

/**
 * 碎石密度的抽样：按会话 id 的哈希落在 [0, 1) 的哪儿，小于 keep 就画。同一个 id 永远同一个结果；
 * 十分之一画出的那些一定也在一半里（同一把尺子），密度调高调低时碎石只增不跳。
 * 哈希加了前缀，与方位角（theta0）用的哈希不相关，不会只留下某一扇面。
 */
export function dustKept(id: string, keep: number): boolean {
  if (keep >= 1) return true;
  if (keep <= 0) return false;
  return (hashText(`dust-keep:${id}`) % 10000) / 10000 < keep;
}

/**
 * 偏心率上限（编排页的三档候选 0.15 / 0.3 / 0.45 在 proto-variants.ts，2026-11-24 用户：「这个轨道不够椭圆。
 * 行星绕主星，一般是椭圆的吧」）：再扁，近日点那一侧行星要贴着主星过，屏幕安全布局只能把轨道整体推远、行星缩小
 */
export const ECC_MAX = 0.6;

export function eccOf(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : clamp(value, 0, ECC_MAX);
}

/**
 * 开普勒方程 M = E − e·sin E：由平近点角 M（随时间匀速走）解偏近点角 E（轨道上的位置参数）。
 * 牛顿迭代，e ≤ 0.6 时 6 步就到 1e-12。e = 0 时 E = M（正圆，匀速）
 */
export function eccentricAnomaly(meanAnomaly: number, e: number): number {
  if (e === 0) return meanAnomaly;
  let E = meanAnomaly + e * Math.sin(meanAnomaly);
  for (let i = 0; i < 8; i++) {
    const f = E - e * Math.sin(E) - meanAnomaly;
    E -= f / (1 - e * Math.cos(E));
    if (Math.abs(f) < 1e-13) break;
  }
  return E;
}

/** 反过来：偏近点角 E 对应的平近点角（算「几秒后走到哪」用） */
export function meanAnomalyOf(E: number, e: number): number {
  return E - e * Math.sin(E);
}

/*
 * 星系的比例（质量区间、密度、半径、行星区、间距）住在 shared/galaxy-scale.ts：新建子智能体找空轨的主进程也要它——
 * 以前只在 renderer 里，主进程够不着，只好自己写一个「最轻主星」去算轨道，新行星落进了界面画出的主星里（2026-11-25）。
 * 这里原样再导出，画星系的其余代码与别的消费者不用改。
 */
export { DENSITY, MIN_CLEARANCE, PLANET_MASS, PLANET_ZONE, STAR_DENSITY, STAR_MASS, bodyRadius, planetRadius, starRadius };
/**
 * 一座星系最多画几圈轨道（几颗行星）。超出的计进 hidden，不画、不滚动、不缩放：9 圈以上的
 * 发丝线在 900×240 的带子里会叠成一个靶心（2026-11-23 视觉审查），6 圈还读得出「一圈一颗」。
 */
export const VISIBLE_ORBIT_CAP = 6;
/**
 * 统一画框（天体单位）：所有星系都装进这个半径里，相机与视口只按它定，不按某座星系自己的外缘——
 * 这样空 / 平常 / 满载三档的主星同大、同位，满载不会因为外缘变大把主星缩小。
 */
export const FRAME_EXTENT = 64;
/** 行星区外沿：再往外留给碎石带。用户给的轨道半径整体超出时按比例收进来（天体半径不缩） */
/** 空星系画一圈极淡的「预期落位轨道」：第一颗行星会落在这一带，空星系不至于读成一个 loading 球 */
export const EXPECTED_ORBIT = 22;
/** 开普勒第三定律的参考点：轨道半径 KEPLER_REF_RADIUS 处转一圈 KEPLER_REF_PERIOD_S 秒 */
export const KEPLER_REF_RADIUS = 20;
/**
 * 2026-11-24 从 56 秒放慢到 112 秒（用户：「确实，现在转的我觉得偏快」）：正好慢一半，行星与碎石带一起慢（碎石带的角速度也按这一条算）。
 * 最内圈（半径 19）原来约 52 秒一圈、在 1040 宽的编排页上约 18px/s，现在约 104 秒、9px/s——看得出在转，不抢眼。
 * 没有顺手降帧：steps() 低帧率转实测 GPU 反而更高（见 perf 提交），合成器动画本来就不占主线程
 */
export const KEPLER_REF_PERIOD_S = 112;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DEG = Math.PI / 180;

/** 相机俯角与距离（距离 = 星系外缘半径的倍数）：俯角小一点显得安静，距离近一点透视才看得出 */
export const CAMERA_ELEVATION_DEG = 20;
export const CAMERA_DISTANCE_FACTOR = 3.2;


/** 开普勒：T² ∝ a³/(M+m)。相对视觉时钟以默认主星 620、a=20 时 112 秒一圈为参考 */
export function angularSpeed(orbitRadius: number, starMass = 620, planetMass = 0): number {
  const reference = orbitalPeriod({ mass: 620 }, { a: KEPLER_REF_RADIUS, mass: 0 });
  const period = orbitalPeriod({ mass: starMass }, { a: orbitRadius, mass: planetMass });
  return ((2 * Math.PI) / KEPLER_REF_PERIOD_S) * (reference / period);
}

export interface OrbitBody {
  id: string;
  composition: Composition;
  state: PlanetState;
  label: string | null;
  radius: number;
  orbitRadius: number;
  inclination: number;
  node: number;
  phase: number;
  omega: number;
  /** 这颗自己的偏心率与轨道面内近日点方向（rad） */
  ecc: number;
  periapsis: number;
}

export interface DustParticle {
  /** 会话 id */
  id: string;
  title: string | null;
  /** 离主星的距离（世界单位）：新的在内沿、老的在外沿 */
  r: number;
  /** t = 0 时的方位角：按 id 取，同一条会话永远在同一处 */
  theta0: number;
}

export interface Belt {
  inner: number;
  outer: number;
  /** 真实会话数（= particles.length + 根会话拎成的碎石块数） */
  count: number;
  particles: DustParticle[];
  /** 碎石带浓淡：随会话数取对数，有上限 */
  alpha: number;
  /** 碎石带整体转动的角速度（rad/s）：整条带子一起转（合成器转一个分组），不随会话数变，长大时不跳 */
  omega: number;
  /** 与行星轨道同一个偏心率（同一族椭圆） */
  ecc: number;
}

/** 碎石块在碎石带里的位置：同一圈、等角间隔（同一个角速度，永远不互相追上） */
export interface OrbitRock {
  id: string;
  state: RockState;
  label: string;
  child?: boolean;
  theta0: number;
}

export interface GalaxyLayout {
  starRadius: number;
  /** 在做事的碎石块；rockOrbit 是它们共用的轨道半径（碎石带里，屏幕安全布局会再往外让开最外一颗行星） */
  rocks: OrbitRock[];
  rockOrbit: number | null;
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
  /** 轨道偏心率（spec.eccentricity，0 = 正圆）；orbitRadius 是半长轴 */
  ecc: number;
}

/** 碎石块那一圈在碎石带里的位置（0 = 内沿，1 = 外沿） */
export const ROCK_ORBIT_AT = 0.3;

function hashText(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}


/**
 * 碎石带长多宽（0..1，乘 BELT_MAX_WIDTH）：随会话数取对数，几条时是窄窄一圈，BELT_FULL_AT 条时到最宽，
 * 再多也不再变宽（只变密）。单调不减、有上限。
 */
export const BELT_GROWTH_MIN = 0.16;
export const BELT_FULL_AT = 3000;
export function beltGrowthOf(sessions: number): number {
  if (sessions <= 0) return BELT_GROWTH_MIN;
  return clamp(BELT_GROWTH_MIN + ((1 - BELT_GROWTH_MIN) * Math.log10(1 + sessions)) / Math.log10(1 + BELT_FULL_AT), BELT_GROWTH_MIN, 1);
}

/**
 * 碎石带最宽多少（世界单位）。不按「内沿到画框外沿」剩多少给：屏幕安全布局把行星轨道往外推之后，
 * 那一段常只剩 5 个单位，450 条和 3 条看不出差别（2026-11-24 实测：满载 orbita 内沿被推到 58.5）。
 * 带子可以越过统一画框（FRAME_EXTENT）一点，最多到 BELT_OVERSHOOT 倍——那是画框四周留的边距，满载时尘埃铺到这里。
 */
export const BELT_MAX_WIDTH = 13;
export const BELT_OVERSHOOT = 1.06;

/** 碎石带外沿：内沿 + BELT_MAX_WIDTH × beltGrowthOf（至少 2 个单位宽），不超过 FRAME_EXTENT × BELT_OVERSHOOT */
export function beltOuterOf(inner: number, sessions: number): number {
  return Math.max(inner + 2, Math.min(inner + BELT_MAX_WIDTH * beltGrowthOf(sessions), FRAME_EXTENT * BELT_OVERSHOOT));
}

/** 碎石带整体的角速度：取轨道半径 BELT_SPIN_RADIUS 处的开普勒角速度（约 7 分 20 秒一圈） */
export const BELT_SPIN_RADIUS = 56;
export const BELT_OMEGA = angularSpeed(BELT_SPIN_RADIUS);

/**
 * 一颗碎石画多大、多浓（px、0..1）：量越大，单颗越小越淡——几条时是看得清、点得着的碎石，
 * 几百上千条时成了尘埃（整条带子靠数量变浓）。永远小于最小的行星（PLANET_READABLE_MIN）与在做事的碎石块（ROCK_PX）。
 * 星际空间（没有主星，碎石就是会话本身）大一档。
 */
export function dustLookOf(count: number, starless = false): { px: number; alpha: number } {
  const n = Math.max(1, count);
  // 几条时 ~2.8px、看得清；40 条 ~2px；450 条 ~1.2px 的尘埃；几千条封底 0.8px（盘面把它压扁一半，画出来是一粒横向的点）
  const base = clamp(3.2 - 0.75 * Math.log10(n), 0.8, 3.2);
  return {
    px: starless ? clamp(base * 1.4, DEBRIS_PX[0], DEBRIS_PX[1]) : base,
    alpha: clamp(0.95 - 0.17 * Math.log10(n), 0.38, 0.95),
  };
}

/** 碎石少到这个数以内，每颗都能点（打开那条会话）；再多就是尘埃，只有锁定框选中的那几块能点 */
export const DUST_CLICK_MAX = 150;

/**
 * 新会话「被捕获」：上一次见过的会话集合（null = 第一次画，什么都不算新）→ 这一次新出现的 id。
 * 只有新增的触发；从碎石块（在跑）落回碎石带、换顺序、删掉的都不触发。
 */
export function capturedIds(previous: ReadonlySet<string> | null, next: readonly string[]): string[] {
  if (previous === null) return [];
  return next.filter((id) => !previous.has(id));
}
/** 捕获动画的时长（ms） */
export const CAPTURE_MS = 1000;

export function beltAlpha(count: number): number {
  if (count <= 0) return 0;
  return clamp(0.3 + 0.13 * Math.log10(count), 0.3, 0.72);
}

/** 只要有一颗带自己的根数，这座星系就按独立轨道画；全局 eccentricity 只留给碎石带与旧数据 */
export function hasIndependentOrbits(spec: GalaxySpec): boolean {
  return spec.planets.some((planet) => planet.eccentricity !== undefined || planet.periapsisDeg !== undefined);
}

/**
 * 摆星系：按轨道半径排序，取最内的 VISIBLE_ORBIT_CAP 颗；轨道半径整体超出行星区时按同一比例收进来
 * （比例不变，用户指定的相对远近保留）；再逐圈检查「不相撞、留间距」，违反的向外推。
 * 两条圆轨道半径差 ≥ 两颗行星半径之和 + 间距时，无论倾角如何都不会相交（任一点到原点的距离
 * 分别恒为 a1、a2，两点距离 ≥ a2 − a1），所以只需管半径差。
 */
export function layoutGalaxy(spec: GalaxySpec): GalaxyLayout {
  const independent = hasIndependentOrbits(spec);
  const star = starRadius(spec.starMass, spec.starDensity);
  const sorted = [...spec.planets].sort((a, b) => a.orbitRadius - b.orbitRadius);
  const shown = independent ? sorted : sorted.slice(0, VISIBLE_ORBIT_CAP);
  const outermost = shown[shown.length - 1];
  const orbitScale = independent
    ? 1
    : outermost === undefined
      ? 1
      : Math.min(1, (PLANET_ZONE - planetRadius(outermost)) / outermost.orbitRadius);
  const planets: OrbitBody[] = [];
  const adjusted: string[] = [];
  let prevOrbit = 0;
  let prevApo = 0;
  let prevRadius = Math.max(star, spec.starExtent ?? 0);
  const ecc = eccOf(spec.eccentricity);
  for (const planet of shown) {
    const radius = planetRadius(planet);
    const ownEcc = eccOf(planet.eccentricity ?? (independent ? LEGACY_ORBIT_E : spec.eccentricity));
    // 旧的共用轨道仍按屏幕安全规则向外推；独立轨道的 a/e/ω 是用户设计，不在这里暗改
    const minOrbit = ecc === 0 ? prevOrbit + prevRadius + radius + MIN_CLEARANCE : prevOrbit + (prevRadius + radius + MIN_CLEARANCE) / (1 - ecc);
    const given = planet.orbitRadius * orbitScale;
    const orbitRadius = independent ? given : Math.max(given, minOrbit);
    if (orbitRadius !== given) adjusted.push(planet.id);
    planets.push({
      id: planet.id,
      composition: planet.composition,
      state: planet.state ?? null,
      label: planet.label ?? null,
      radius,
      orbitRadius,
      inclination: independent ? 0 : clamp(planet.inclinationDeg, -8, 8) * DEG,
      node: independent ? 0 : planet.nodeDeg * DEG,
      phase: planet.phaseDeg * DEG,
      omega: angularSpeed(orbitRadius, spec.starMass, planet.mass),
      ecc: ownEcc,
      periapsis: (independent ? (planet.periapsisDeg ?? LEGACY_ORBIT_OMEGA_DEG) : 0) * DEG,
    });
    prevOrbit = orbitRadius;
    prevApo = orbitRadius * (1 + ownEcc);
    prevRadius = radius;
  }
  limitInclinations(planets);
  const expectedOrbit = planets.length === 0 ? EXPECTED_ORBIT : null;
  const lastEdge = expectedOrbit ?? (independent ? prevApo : prevOrbit) + prevRadius;
  let belt: Belt | null = null;
  const rockSpecs = spec.rocks ?? [];
  // 根会话拎成的碎石块是 spec.sessions 里的；子会话的不是（见 RockSpec.child）
  const rootRocks = rockSpecs.filter((rock) => rock.child !== true).length;
  const sessions = Math.max(0, Math.floor(spec.sessions), rootRocks);
  if (sessions > 0 || rockSpecs.length > 0) {
    const beltFloor = independent ? lastEdge + MIN_CLEARANCE * 2 : ecc === 0 || planets.length === 0 ? lastEdge + MIN_CLEARANCE * 2 : prevOrbit + (prevRadius + MIN_CLEARANCE * 2) / (1 - ecc);
    const inner = Math.max(beltFloor, spec.beltInner ?? 0);
    // 碎石带随会话数长大：宽度按对数长（beltGrowthOf），几条和几千条都装得下
    const outer = beltOuterOf(inner, sessions);
    // 每条根会话都是一颗碎石（2026-11-24 用户：「这个星系它一直在捕捉新的东西，在长大」），不封顶
    const n = Math.max(0, sessions - rootRocks);
    const seeds = spec.dust ?? [];
    const particles: DustParticle[] = [];
    for (let i = 0; i < n; i++) {
      const seed = seeds[i];
      const id = seed?.id ?? `dust-${i}`;
      const hash = hashText(id);
      // 越老越靠外：按「新 → 老」的名次铺满带宽，再按 id 抖一点（不排成一条线）
      const rank = n <= 1 ? 0 : i / (n - 1);
      const jitter = ((hash >>> 8) & 1023) / 1023 - 0.5;
      const u = clamp(0.06 + 0.86 * rank + 0.12 * jitter, 0.02, 0.98);
      // 碎石密度：只是不画这一颗，它的位置（名次、方位）照旧按全部会话排——调密度时留下的那些不挪
      if (!dustKept(id, spec.dustKeep ?? 1)) continue;
      particles.push({ id, title: seed?.title ?? null, r: inner + (outer - inner) * u, theta0: ((hash % 3600) / 3600) * Math.PI * 2 });
    }
    belt = { inner, outer, count: sessions, particles, alpha: beltAlpha(sessions), omega: BELT_OMEGA, ecc };
  }
  // 碎石块：等角排开，起点按第一块的 id 取（同一组会话每次排成同一个样子）
  const rockBase = rockSpecs[0] === undefined ? 0 : (hashText(rockSpecs[0].id) % 360) * DEG;
  const rocks: OrbitRock[] = rockSpecs.map((rock, index) => ({
    id: rock.id,
    state: rock.state,
    label: rock.label,
    ...(rock.child === true ? { child: true } : {}),
    theta0: rockBase + (index * Math.PI * 2) / rockSpecs.length,
  }));
  return {
    starRadius: star,
    rocks,
    rockOrbit: belt === null || rocks.length === 0 ? null : belt.inner + (belt.outer - belt.inner) * ROCK_ORBIT_AT,
    planets,
    hidden: independent ? 0 : Math.max(0, sorted.length - VISIBLE_ORBIT_CAP),
    expectedOrbit,
    orbitScale,
    belt,
    extent: belt === null ? lastEdge : belt.outer,
    adjusted,
    ecc,
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

/**
 * 轨道面内参数 theta 处的点：先在平面内，再绕升交点线倾斜 inclination。
 * ecc > 0 时是开普勒椭圆，theta 是偏近点角 E：平面内 (a(cos E − e), b·sin E)，b = a√(1−e²)，
 * 主星（原点）在焦点上，近日点在 theta = 0（升交点方向）。ecc = 0 时就是半径 a 的圆，与原来逐位相同
 */
export function orbitPoint(a: number, inclination: number, node: number, theta: number, ecc = 0, periapsis = 0): Vec3 {
  const c = ecc === 0 ? Math.cos(theta) : Math.cos(theta) - ecc;
  const s = ecc === 0 ? Math.sin(theta) : Math.sin(theta) * Math.sqrt(1 - ecc * ecc);
  const cw = Math.cos(periapsis);
  const sw = Math.sin(periapsis);
  const turnedC = c * cw - s * sw;
  const turnedS = c * sw + s * cw;
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  const ci = Math.cos(inclination);
  return {
    x: a * (cn * turnedC - sn * turnedS * ci),
    y: a * (sn * turnedC + cn * turnedS * ci),
    z: a * s * Math.sin(inclination),
  };
}

/**
 * 相机：在 y 轴负方向、抬高 elevation 俯看原点。世界坐标 z 朝上、y 朝远处。
 * 近处（y < 0）的轨道段投在下方且更大——这就是透视，不是把圆压扁成椭圆。
 *
 * azimuth（方位角，转台 turntable）：相当于整座星系绕竖直的 z 轴（过主星）逆时针（从上往下看）转 azimuth——
 * 实现上是相机绕 z 轴反向转同样的角度；z 永远朝上，不翻滚（2026-11-24 用户：「blender or rhino 里那种 3d 视图的拖动，
 * 只不过是锁 z 轴的视角」）。azimuth = 0 时与原来逐位相同。
 */
export interface Camera {
  elevation: number;
  /** 方位角（rad）：星系绕 z 轴转了多少 */
  azimuth: number;
  distance: number;
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  /** 屏幕向右的方向（azimuth = 0 时就是世界 x） */
  right: Vec3;
}

export function makeCamera(extent: number, elevationDeg = CAMERA_ELEVATION_DEG, distanceFactor = CAMERA_DISTANCE_FACTOR, azimuthDeg = 0): Camera {
  const e = elevationDeg * DEG;
  const phi = azimuthDeg * DEG;
  const distance = Math.max(extent, 1) * distanceFactor;
  // 相机绕 z 轴转 −φ：(x, y) → (x cosφ + y sinφ, −x sinφ + y cosφ)
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const turn = (v: Vec3): Vec3 => ({ x: v.x * c + v.y * s, y: -v.x * s + v.y * c, z: v.z });
  return {
    elevation: e,
    azimuth: phi,
    distance,
    position: turn({ x: 0, y: -distance * Math.cos(e), z: distance * Math.sin(e) }),
    forward: turn({ x: 0, y: Math.cos(e), z: -Math.sin(e) }),
    up: turn({ x: 0, y: Math.sin(e), z: Math.cos(e) }),
    right: turn({ x: 1, y: 0, z: 0 }),
  };
}

/**
 * 平放的开普勒轨道上「画在主星背后」那一段（偏近点角 E 的区间，lo < hi，跨 2π 时 lo 可为负）：
 * 轨道上的点在相机水平朝向上的分量 > 0 就是远侧。方位角 φ 下：sinφ·(cosE − e) + cosφ·√(1−e²)·sinE > 0
 * ⇔ sin(E + χ) > k（χ、k 见下），两头各收 margin。φ = 0 时就是原来的 (margin, π − margin)。
 */
export function farWindow(ecc: number, azimuth: number, margin = 0): { lo: number; hi: number } {
  const A = Math.sin(azimuth);
  const B = Math.cos(azimuth) * Math.sqrt(1 - ecc * ecc);
  const R = Math.hypot(A, B);
  const chi = Math.atan2(A, B);
  const k = Math.max(-1, Math.min(1, (ecc * Math.sin(azimuth)) / Math.max(R, 1e-9)));
  const edge = Math.asin(k);
  return { lo: edge - chi + margin, hi: Math.PI - edge - chi - margin };
}

/** 偏近点角 E 在不在远侧区间里（区间按 2π 取模） */
export function inFarWindow(E: number, window: { lo: number; hi: number }): boolean {
  const twoPi = Math.PI * 2;
  const span = window.hi - window.lo;
  if (span <= 0) return false;
  const d = (((E - window.lo) % twoPi) + twoPi) % twoPi;
  return d < span;
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
  const right = rx * camera.right.x + ry * camera.right.y + rz * camera.right.z;
  return { sx: right / depth, sy: -up / depth, depth };
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
  /** 轨道偏心率：画框也是同一族椭圆（半长轴 FRAME_EXTENT），主星于是偏在画框中心的近日点一侧 */
  ecc = 0,
): Viewport {
  const pts: Projected[] = [];
  // 取样从「对着镜头」的参数角起（与 orbitFrame 同一个 s0）：正圆画框转方位角时取到的是同一组屏幕点，视口逐位不变
  for (let i = 0; i < 144; i++) pts.push(project(orbitPoint(FRAME_EXTENT, 0, 0, (i / 144) * Math.PI * 2 - camera.azimuth, ecc), camera));
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

/**
 * 比例尺与视角无关（2026-11-24 用户：「为什么我拖动，那个轨道会跟着变大变小呢？」）：
 * 原来每换一次相机就按投影后画框的外接矩形重算 focal，俯角、方位一变宽高比就变，比例尺跟着变。
 * 现在世界单位 → 像素的比例尺只由画布与用户缩放定：按「默认视角」（VIEW_REF_ELEVATION、方位 0）把画框装进 box 定一个基准，
 * 各角度共用；主星（转轴所在）钉在基准视角下它所在的屏幕位置，转台绕它转。为什么取默认视角而不取正俯视：
 * 正俯视时画框是一个整圆，宽而矮的画布（单智能体首页那条带子）只能按高度装，40° 下星系会缩到原来的一半多；
 * 取默认视角，默认时的样子与改前逐位相同，其他角度出画框或留白（Blender 视口也是这样），由用户缩放去调。
 */
export const VIEW_REF_ELEVATION = 40;

export function baseViewport(width: number, height: number, box: { width: number; height: number } = galaxyBox(width, height), ecc = 0): Viewport {
  return frameViewport(makeCamera(FRAME_EXTENT, VIEW_REF_ELEVATION), width, height, box, ecc);
}

/** 用户缩放与平移（滚轮 / 双指；以指针为中心）：zoom 绕主星放大，pan 是主星相对基准位置挪了多少像素 */
export interface UserView {
  zoom: number;
  panX: number;
  panY: number;
}

export const USER_VIEW_DEFAULT: Readonly<UserView> = { zoom: 1, panX: 0, panY: 0 };
/** 缩放夹在设置的区间里（GALAXY_ZOOM：0.5×–3×） */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return GALAXY_ZOOM.default;
  return Math.min(GALAXY_ZOOM.max, Math.max(GALAXY_ZOOM.min, zoom));
}

export function withUserView(vp: Viewport, view: UserView): Viewport {
  if (view.zoom === 1 && view.panX === 0 && view.panY === 0) return vp;
  return { ...vp, focal: vp.focal * view.zoom, cx: vp.cx + view.panX, cy: vp.cy + view.panY };
}

/**
 * 以指针 (px, py) 为中心缩放到 next：指针下的那一点不动（主星绕它按比例挪）。base = 用户缩放之前的视口（主星在 base.cx, base.cy）。
 * next 夹在 GALAXY_ZOOM 里；回到 1× 时平移照留（指针下那点不动），双击复位才清平移。
 */
export function zoomAt(view: UserView, base: Pick<Viewport, "cx" | "cy">, px: number, py: number, next: number): UserView {
  const zoom = clampZoom(next);
  const k = zoom / view.zoom;
  const sx = base.cx + view.panX;
  const sy = base.cy + view.panY;
  return { zoom, panX: px + (sx - px) * k - base.cx, panY: py + (sy - py) * k - base.cy };
}

function toScreen(p: Projected, vp: Viewport): { x: number; y: number } {
  return { x: vp.cx + vp.focal * p.sx, y: vp.cy + vp.focal * p.sy };
}

/**
 * 一圈轨道在屏幕上的样子（仿射近似）：屏幕点 = c + m1·cosθ + m2·sinθ。
 * 为什么不逐点透视：星系改由合成器转（HomeGalaxy：CSS transform 动画作用在分组上），合成器只会做矩阵——
 * 「矩阵 · 旋转 · 平移」能精确画出一个椭圆上匀速走的点，画不出透视下变速的点。所以轨道线、行星、碎石一律按这一个模型画，
 * 行星永远正好压在自己的轨道线上。c、m2 取远近两个短轴端点（精确的透视投影，屏幕安全布局就在这两点上量间距），
 * m1 取左右两点；透视带来的只是左右两点上下差几个像素。
 */
export interface OrbitFrame {
  cx: number;
  cy: number;
  m1x: number;
  m1y: number;
  m2x: number;
  m2y: number;
}

export function orbitFrame(a: number, inclination: number, node: number, camera: Camera, vp: Viewport, ecc = 0, periapsis = 0): OrbitFrame {
  // 椭圆按偏近点角参数化之后仍是「中心 + 两个半轴向量」，仿射模型照样精确（中心在 −a·e，主星在焦点）
  // 转过方位角时取「对着镜头」的四个参数角（s = −方位角）：远近两点仍是屏幕上的短轴两端（透视下最准、屏幕安全布局在这里量），
  // 再换回原参数的 cos / sin 基。正圆轨道因此与方位角 0 时是同一个屏幕椭圆（只差相位）。方位角 0 时 s = 0，与原来逐位相同。
  const s0 = -camera.azimuth;
  const at = (theta: number) => toScreen(project(orbitPoint(a, inclination, node, theta + s0, ecc, periapsis), camera), vp);
  const right = at(0);
  const left = at(Math.PI);
  const far = at(Math.PI / 2);
  const near = at(-Math.PI / 2);
  const M1x = (right.x - left.x) / 2;
  const M1y = (right.y - left.y) / 2;
  const M2x = (far.x - near.x) / 2;
  const M2y = (far.y - near.y) / 2;
  if (s0 === 0) return { cx: (far.x + near.x) / 2, cy: (far.y + near.y) / 2, m1x: M1x, m1y: M1y, m2x: M2x, m2y: M2y };
  // c + M1·cos(θ − s0) + M2·sin(θ − s0) = c + (M1 cos s0 − M2 sin s0)·cosθ + (M1 sin s0 + M2 cos s0)·sinθ
  const c = Math.cos(s0);
  const sn = Math.sin(s0);
  return {
    cx: (far.x + near.x) / 2,
    cy: (far.y + near.y) / 2,
    m1x: M1x * c - M2x * sn,
    m1y: M1y * c - M2y * sn,
    m2x: M1x * sn + M2x * c,
    m2y: M1y * sn + M2y * c,
  };
}

/** 轨道 frame 上 θ 处的屏幕点；scale = 离主星的距离 / 这圈轨道半径（碎石带里内外沿的碎石共用中间那一圈的 frame） */
export function framePoint(frame: OrbitFrame, theta: number, scale = 1): { x: number; y: number } {
  const c = Math.cos(theta) * scale;
  const s = Math.sin(theta) * scale;
  return { x: frame.cx + frame.m1x * c + frame.m2x * s, y: frame.cy + frame.m1y * c + frame.m2y * s };
}

/** 碎石带共用的那一圈（内外沿的正中）：整条带子按它转 */
export function beltFrame(belt: Belt, camera: Camera, vp: Viewport): OrbitFrame {
  return orbitFrame((belt.inner + belt.outer) / 2, 0, 0, camera, vp, belt.ecc);
}

/** 远半圈（θ ∈ (0, π)，主星背后）：画在主星之前；近半圈画在主星之后。给了相机与偏心率时按方位角算（farWindow） */
export function isFarSide(theta: number, camera?: Camera, ecc = 0): boolean {
  if (camera === undefined || camera.azimuth === 0) return Math.sin(theta) > 0;
  return inFarWindow(theta, farWindow(ecc, camera.azimuth));
}

/**
 * 行星的屏幕半径：物理半径按「主星那么远」透视一次（不随公转变大变小——合成器只平移它），再取可读下限、等你放大。
 * 屏幕安全布局（screen-safe.ts）与绘制用同一个数。
 */
export function planetPx(radius: number, waiting: boolean, camera: Camera, vp: Viewport, minPx: number): number {
  const depth = project({ x: 0, y: 0, z: 0 }, camera).depth;
  return Math.max((vp.focal * radius) / depth, minPx) * (waiting ? WAITING_SCALE : 1);
}

/** 碎石带里每颗碎石此刻的屏幕位置（与 HomeGalaxy 合成器转出来的同一个模型） */
export function dustPoints(belt: Belt, camera: Camera, vp: Viewport, t: number): { id: string; x: number; y: number; far: boolean }[] {
  const frame = beltFrame(belt, camera, vp);
  const mid = (belt.inner + belt.outer) / 2;
  return belt.particles.map((particle) => {
    const theta = particle.theta0 + belt.omega * t;
    return { id: particle.id, ...framePoint(frame, theta, particle.r / mid), far: isFarSide(theta, camera, belt.ecc) };
  });
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
  label: string | null;
  depth: number;
  x: number;
  y: number;
  r: number;
}

/** 在做事的一块碎石（屏幕坐标）：字段名与 PlanetItem 对齐（planetId / state / label），锁定框与引线层直接认它 */
export interface RockItem {
  kind: "rock";
  key: string;
  planetId: string;
  state: RockState;
  label: string;
  depth: number;
  x: number;
  y: number;
  r: number;
}

export type DrawItem = OrbitArc | StarItem | PlanetItem | RockItem;

/** 碎石块的屏幕半径（px）：比星屑大一圈、远小于行星——它是会话，不是天体 */
export const ROCK_PX = 4.5;

export const ARCS_PER_ORBIT = 16;

/** 等你的行星画大一档（仍远小于主星：最大的行星质量 40 也只有主星半径的一半不到） */
export const WAITING_SCALE = 1.35;

/**
 * 轨道是静止的几何：每条拆成 ARCS_PER_ORBIT 段，各带自己的平均深度。分段是为了遮挡——
 * 远半圈画在主星后面、近半圈画在前面；不分段的话整条轨道只能整体在前或在后。
 */
export function orbitArcs(layout: GalaxyLayout, camera: Camera, vp: Viewport, samplesPerArc = 6): OrbitArc[] {
  const arcs: OrbitArc[] = [];
  const span = (Math.PI * 2) / ARCS_PER_ORBIT;
  const rings = layout.planets.map((p) => ({ id: p.id, a: p.orbitRadius, inclination: p.inclination, node: p.node, ecc: p.ecc, periapsis: p.periapsis, expected: false }));
  if (layout.expectedOrbit !== null) {
    rings.push({ id: EXPECTED_ID, a: layout.expectedOrbit, inclination: 0, node: 0, ecc: layout.ecc, periapsis: 0, expected: true });
  }
  for (const planet of rings) {
    const frame = orbitFrame(planet.a, planet.inclination, planet.node, camera, vp, planet.ecc, planet.periapsis);
    for (let k = 0; k < ARCS_PER_ORBIT; k++) {
      const from = k * span;
      let d = "";
      let depthSum = 0;
      for (let i = 0; i <= samplesPerArc; i++) {
        const theta = from + (span * i) / samplesPerArc;
        const projected = project(orbitPoint(planet.a, planet.inclination, planet.node, theta, planet.ecc, planet.periapsis), camera);
        const { x, y } = framePoint(frame, theta);
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

/**
 * 某一时刻的绘制表，按深度从远到近排好（画家算法）。
 * 行星压在自己的轨道线上：与它相邻的三段自家轨道弧的排序深度不小于行星，先画；
 * 否则一段「更近」的弧会从行星中间划过去。
 */
/**
 * 行星在屏幕上的最小可读半径（px）：星系规则「主星与行星的大小差距应缩小到行星表情可读的程度」——
 * 小于这个半径，两只竖胶囊眼睛就糊成一个点。上限 PLANET_READABLE_MAX；但不超过「相邻两圈轨道间距」的 PLANET_READABLE_GAP 倍，
 * 窄画布（右栏）里放大的行星不会压到隔壁轨道上的那颗（轨道等距排，间距是 orbitStep 个世界单位）。
 * 只在工作区页 / 右栏星系图用（drawFrame 的 minPlanetPx）。
 */
export const PLANET_READABLE_MAX = 11;
/** 星际空间（没有主星，碎石 = 会话）的碎石屏幕半径区间（dustLookOf） */
export const DEBRIS_PX = [2.4, 4.4] as const;
export const PLANET_READABLE_MIN = 5;
export const PLANET_READABLE_GAP = 0.36;

export function readablePlanetPx(camera: Camera, vp: Viewport, orbitStep: number, max: number = PLANET_READABLE_MAX, gap: number = PLANET_READABLE_GAP): number {
  const pxPerUnit = vp.focal / project({ x: 0, y: 0, z: 0 }, camera).depth;
  return clamp(gap * orbitStep * pxPerUnit, PLANET_READABLE_MIN, max);
}

/**
 * 子智能体行星（编排星系：行星 = 子智能体，带地表图与名字）的可读半径上限：一座星系只有几颗，
 * 比「一件活一颗」的旧星系画大一档，地表与两只眼睛都看得清（星系规则：大小差距缩小到表情可读）。
 * 主星仍明显最大：屏幕安全布局再把它夹在主星屏幕半径 / STAR_OVER_PLANET 以下。
 */
export const AGENT_READABLE_MAX = 20;
/**
 * 子智能体行星可读半径占「相邻轨道间距」的比例：比旧星系（PLANET_READABLE_GAP）放宽——子智能体只有几颗，
 * 相邻两圈挨不挨着由屏幕安全布局（screen-safe.ts）在屏幕坐标里推轨道保证，不再靠把行星画小来躲
 */
export const AGENT_READABLE_GAP = 0.7;
export const STAR_OVER_PLANET = 1.6;

export function drawFrame(
  layout: GalaxyLayout,
  camera: Camera,
  vp: Viewport,
  arcs: readonly OrbitArc[],
  t: number,
  /** 行星屏幕半径的下限（px）：0 = 照物理半径画 */
  minPlanetPx = 0,
): DrawItem[] {
  const starP = project({ x: 0, y: 0, z: 0 }, camera);
  const starS = toScreen(starP, vp);
  const items: DrawItem[] = [
    { kind: "star", key: "star", depth: starP.depth, x: starS.x, y: starS.y, r: (vp.focal * layout.starRadius) / starP.depth },
  ];
  const planetAngle = new Map<string, { theta: number; depth: number }>();
  for (const planet of layout.planets) {
    // phase + ω·t 是平近点角；开普勒方程换成轨道上的位置（偏近点角）：近日点快、远日点慢，面积速度恒定
    const theta = eccentricAnomaly(planet.phase + planet.omega * t, planet.ecc);
    const p = project(orbitPoint(planet.orbitRadius, planet.inclination, planet.node, theta, planet.ecc, planet.periapsis), camera);
    const s = framePoint(orbitFrame(planet.orbitRadius, planet.inclination, planet.node, camera, vp, planet.ecc, planet.periapsis), theta);
    // 等你的行星放大一档；转到主星背后就让主星挡住（星系规则「天体不得相撞」，屏幕安全布局保证它在近侧不碰主星）
    const waiting = planet.state === "waiting";
    const depth = p.depth;
    items.push({
      kind: "planet",
      key: `planet-${planet.id}`,
      planetId: planet.id,
      composition: planet.composition,
      state: planet.state,
      label: planet.label,
      depth,
      x: s.x,
      y: s.y,
      r: planetPx(planet.radius, waiting, camera, vp, minPlanetPx),
    });
    planetAngle.set(planet.id, { theta: normalizeAngle(theta), depth });
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
  if (layout.rockOrbit !== null) {
    // 碎石块永远小于行星（层级：碎石 < 行星 < 主星；2026-11-24 设计审查 R3 量到窄窗里碎石比行星大）：
    // 不超过此刻最小那颗行星的一半
    const rockR = rockPxOf(items);
    const omega = angularSpeed(layout.rockOrbit);
    const frame = orbitFrame(layout.rockOrbit, 0, 0, camera, vp, layout.ecc);
    for (const rock of layout.rocks) {
      // 碎石块在平近点角上等距：同一个周期，永远不互相追上
      const theta = eccentricAnomaly(rock.theta0 + omega * t, layout.ecc);
      const p = project(orbitPoint(layout.rockOrbit, 0, 0, theta, layout.ecc), camera);
      const s = framePoint(frame, theta);
      items.push({ kind: "rock", key: `rock-${rock.id}`, planetId: rock.id, state: rock.state, label: rock.label, depth: p.depth, x: s.x, y: s.y, r: rockR });
    }
  }
  return items.sort((a, b) => b.depth - a.depth);
}

function rockPxOf(items: readonly DrawItem[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (const item of items) if (item.kind === "planet") smallest = Math.min(smallest, item.r);
  return Number.isFinite(smallest) ? Math.min(ROCK_PX, smallest * 0.5) : ROCK_PX;
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
  /** 离电省电档（power-save.ts）：停转 */
  powerSave?: boolean;
}

export function motionAllowed(inputs: MotionInputs): boolean {
  return !isWindowInactive(inputs) && inputs.onScreen && !inputs.reducedMotion && inputs.powerSave !== true;
}

/**
 * 锁定框、引线、名字牌（HomeGalaxy 里唯一还由 JS 摆的东西）两次重排之间至少隔这么久（约 30 帧/秒）：
 * 天体本身由合成器连续转，这几样只需跟上它
 */
export const LIVE_FRAME_MS = 33;


export const LABEL_MAX_CHARS = 14;

export function truncateLabel(text: string, max = LABEL_MAX_CHARS): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * 空星系（只有主星和预期轨道，没有行星也没有碎石）下一句提示的屏幕位置：预期轨道近侧再往下一行。
 * 有任何行星 / 碎石就不出（返回 null）——这一句只在「还没有派出的活」时说。
 */
export function emptyHintAt(layout: GalaxyLayout, camera: Camera, vp: Viewport): { x: number; y: number } | null {
  if (layout.planets.length > 0 || layout.belt !== null || layout.expectedOrbit === null) return null;
  const p = project(orbitPoint(layout.expectedOrbit, 0, 0, -Math.PI / 2, layout.ecc), camera);
  const s = toScreen(p, vp);
  return { x: s.x, y: s.y + 28 };
}
