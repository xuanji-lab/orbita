import {
  DENSITY,
  MIN_CLEARANCE,
  PLANET_MASS,
  PLANET_ZONE,
  STAR_DENSITY,
  STAR_MASS,
  planetRadius,
  starRadius,
  type Composition,
} from "../chat/galaxy.ts";
import type { RightPanelKind } from "../../shell/RightRail.tsx";

/**
 * 星系设计面板（原型，proto/planet-designer）的纯内核：参数、校验、半径、2D 形象的几何、
 * 每个工作区一份的设计稿、面板开合。GalaxyDesigner.tsx 只把这里算出的东西画出来。
 *
 * 规则来源：「璇玑星系规则」（orbita-notes/orbita-universe-rules.md），物理部分直接用 galaxy.ts：
 * - 「天体类型」「成分」「质量」「轨道半径」分开：质量 + 成分（密度）定天体半径，轨道半径独立指定；
 *   所以面板里**没有半径滑块**——尺寸控制只是预览缩放，算出的半径写在预览下面；
 * - 主星与行星的质量区间互不重叠（STAR_MASS / PLANET_MASS，同 galaxy.ts）；
 * - 轨道不得让天体相撞，并留出 MIN_CLEARANCE 的间距；
 * - 成分只影响密度、纹理、颜色深浅与同质量下的半径，不决定职责；
 * - 行星是面向用户的 2D 形象：眼睛永远画在正面（只有一双竖胶囊眼，不画嘴），纹理与星环是各自独立的层，不把眼睛转到背后；
 * - 主星明显最大，但行星的眼睛要读得出来：显示半径按 r^DISPLAY_GAMMA 压缩差距（displayRadius）。
 */

export type BodyKind = "star" | "planet";

/** 元素：眼睛、星环、云带、卫星（行星）、日冕（主星）。一律是开 / 关，不随机 */
export type ElementKey = "eyes" | "ring" | "clouds" | "moons" | "corona";

/** 每种天体能开哪些元素（主星没有卫星与云带；行星没有日冕） */
export const ELEMENTS_OF: Readonly<Record<BodyKind, readonly ElementKey[]>> = {
  star: ["eyes", "ring", "corona"],
  planet: ["eyes", "ring", "clouds", "moons"],
};

/** 预览背景：四档都是中性的纸 / 壳 / 衬底色（「深衬底」= 衬底混一点主墨），不借有职责的颜色（nebula 只给用量） */
export type Backdrop = "well" | "shell" | "muted" | "deep";
export const BACKDROPS: readonly Backdrop[] = ["well", "shell", "muted", "deep"];

/** 预览缩放（百分比）：只放大预览，不改天体半径 */
export const ZOOM = { min: 50, max: 200, step: 10 } as const;
/**
 * 默认预览缩放，按天体分开存：行星小，100% 时宽面板里默认行星只有约 40px 直径、眼睛读不清，默认放到 140%；
 * 140% 下任何合法行星（最重的气态 + 星环 + 卫星）都装得进固定画框（见测试）。主星本来就大，留 100%，
 * 满载主星 + 日冕 + 星环再由 previewFrame 放大画框装下。
 */
export const ZOOM_DEFAULT: Readonly<Record<BodyKind, number>> = { star: 100, planet: 140 };
/** 轨道半径滑块的范围；合法下限另由两颗天体的半径算（minOrbit），滑块能拖到下限以下，拖过去就报错 */
export const ORBIT_RANGE = { min: 4, max: PLANET_ZONE, step: 0.5 } as const;
/** 天体名字最多几个字（按字符数，中文一个字算一个） */
export const NAME_MAX = 24;

export interface BodyDesign {
  /** 空串 = 用默认名（主星用工作区名，行星用「未命名行星」） */
  name: string;
  mass: number;
  elements: Readonly<Record<ElementKey, boolean>>;
  /** 这一颗的预览缩放（百分比）：主星与行星各记各的，切换天体类型不互相影响 */
  zoom: number;
}

export interface PlanetDesign extends BodyDesign {
  composition: Composition;
  orbitRadius: number;
}

export interface GalaxyDesign {
  /** 面板正在编辑哪一颗：主星或行星 */
  editing: BodyKind;
  star: BodyDesign;
  planet: PlanetDesign;
  backdrop: Backdrop;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function massRange(kind: BodyKind): { min: number; max: number } {
  return kind === "star" ? STAR_MASS : PLANET_MASS;
}

export function densityOf(kind: BodyKind, composition: Composition): number {
  return kind === "star" ? STAR_DENSITY : DENSITY[composition];
}

/** 天体半径（与轨道同一单位）：galaxy.ts 的同一条公式，(质量 / 密度)^(1/3)，质量先夹进区间 */
export function radiusOf(design: GalaxyDesign, kind: BodyKind): number {
  return kind === "star" ? starRadius(design.star.mass) : planetRadius(design.planet);
}

/** 行星轨道的合法下限：两颗天体的半径和 + 间距——再近就相撞 */
export function minOrbit(design: GalaxyDesign): number {
  return radiusOf(design, "star") + radiusOf(design, "planet") + MIN_CLEARANCE;
}

/** 轨道的合法上限：行星整颗留在行星区里 */
export function maxOrbit(design: GalaxyDesign): number {
  return PLANET_ZONE - radiusOf(design, "planet");
}

// ── 校验 ─────────────────────────────────────────────────────────────

export type DesignError =
  | { kind: "mass-range"; body: BodyKind; min: number; max: number; value: number }
  | { kind: "orbit-collision"; min: number; value: number }
  | { kind: "orbit-far"; max: number; value: number }
  | { kind: "name-long"; body: BodyKind; max: number; length: number };

export function nameLength(name: string): number {
  return [...name].length;
}

/**
 * 逐条找出不合规则的参数。不夹、不改：值原样留着、错误原样报出来，面板把错写在对应那一行下面，
 * 预览打上不合法的记号——「不默默接受非法组合」。质量非数字（输入框清空）也算越界。
 */
export function validateDesign(design: GalaxyDesign): DesignError[] {
  const errors: DesignError[] = [];
  for (const body of ["star", "planet"] as const) {
    const { min, max } = massRange(body);
    const value = design[body].mass;
    if (!Number.isFinite(value) || value < min || value > max) errors.push({ kind: "mass-range", body, min, max, value });
    const length = nameLength(design[body].name);
    if (length > NAME_MAX) errors.push({ kind: "name-long", body, max: NAME_MAX, length });
  }
  const orbit = design.planet.orbitRadius;
  const near = minOrbit(design);
  const far = maxOrbit(design);
  if (!Number.isFinite(orbit) || orbit < near) errors.push({ kind: "orbit-collision", min: near, value: orbit });
  else if (orbit > far) errors.push({ kind: "orbit-far", max: far, value: orbit });
  return errors;
}

/** 某一行下面要写的错：碰撞属于轨道行，也写在主星的质量行下面（加大主星质量同样会撞上） */
export function errorsAt(errors: readonly DesignError[], body: BodyKind, field: "mass" | "orbit" | "name"): DesignError[] {
  return errors.filter((error) => {
    if (error.kind === "mass-range") return field === "mass" && error.body === body;
    if (error.kind === "name-long") return field === "name" && error.body === body;
    if (error.kind === "orbit-collision") return (body === "planet" && field === "orbit") || (body === "star" && field === "mass");
    return body === "planet" && field === "orbit";
  });
}

// ── 显示半径：压缩主星与行星的差距 ─────────────────────────────────────

/** 显示半径 = K · r^γ（px，预览缩放 100% 时）。γ < 1 把差距压小，单调不变：质量大的永远画得大 */
export const DISPLAY_K = 27;
export const DISPLAY_GAMMA = 0.5;
/** 眼睛（竖胶囊）的宽至少这么大（px），否则小行星的眼睛读不出来 */
export const EYE_MIN = 1.6;

export function displayRadius(radius: number): number {
  return DISPLAY_K * Math.pow(Math.max(radius, 0), DISPLAY_GAMMA);
}

// ── 2D 形象的几何（以天体中心为原点、单位 px） ────────────────────────

/** 竖向圆角胶囊：中心 (x, y)，宽 w、高 h，圆角 = w / 2 */
export interface Capsule {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface BodyArt {
  r: number;
  /** star | rock | ice | gas：决定底色与纹理 */
  surface: "star" | Composition;
  corona: { r: number; halo: number } | null;
  /** 星环：同一个椭圆拆成后半（画在天体前面之前）与前半（画在眼睛之后） */
  ring: { back: string; front: string; width: number; tilt: number } | null;
  /** 成分自带的纹理（裁在圆内）：岩石的坑、冰质的极冠与裂纹、气态的纬向带 */
  craters: Circle[];
  cap: { cx: number; cy: number; rx: number; ry: number } | null;
  cracks: string[];
  bands: { y: number; h: number }[];
  /** 云带元素：两道横向的浅色条 */
  clouds: { x: number; y: number; w: number; h: number }[];
  /**
   * 眼睛：两只近乎纯黑的竖向圆角胶囊（高 ≈ 宽 × 2.5），大小相同。坐标是「没歪头」时的（左右对称、同高），
   * 整双眼睛再绕天体中心顺时针转 eyesTilt 度——左眼因此略高，像在歪头注视镜头
   * （orbita-notes/orbita-planet-avatar-prompt.md 第 1 节：整体顺时针倾斜约 12 度、其中一只略高）。
   * 只有这一双眼睛——不画嘴、鼻子、腮红、眉毛、瞳孔、高光；生命感来自注视、歪头和地表。
   */
  eyes: [Capsule, Capsule] | null;
  /** 双眼绕天体中心顺时针转的角度（度） */
  eyesTilt: number;
  /** 卫星：behind 的先于天体画（被挡住一部分） */
  moons: (Circle & { behind: boolean })[];
  /** 整个形象的外框（含星环、卫星、日冕），预览用它判断会不会出框 */
  extent: { x: number; y: number };
}

export const RING = { rx: 1.7, ry: 0.3, tiltDeg: -8, width: 0.07 } as const;
/**
 * 眼睛的几何（单位 = 天体半径）：两眼中心横向 ±x，纵向 y（圆心略上）；宽 w、高 = w × aspect；
 * tiltDeg 是整双眼睛绕天体中心顺时针转的角度（提示词文档：约 12 度的歪头）。星环前半从两眼下面绕过去（见测试）。
 */
export const EYES = { x: 0.2, y: -0.1, w: 0.11, aspect: 2.5, tiltDeg: 12 } as const;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 半个椭圆（未旋转；旋转交给外层 transform）：back = 上半圈（远侧），front = 下半圈（近侧） */
function halfEllipse(rx: number, ry: number, half: "back" | "front"): string {
  const sweep = half === "back" ? 1 : 0;
  return `M${round2(-rx)} 0A${round2(rx)} ${round2(ry)} 0 0 ${sweep} ${round2(rx)} 0`;
}

export function bodyArt(design: GalaxyDesign, kind: BodyKind, r: number): BodyArt {
  const body = kind === "star" ? design.star : design.planet;
  const on = (key: ElementKey): boolean => ELEMENTS_OF[kind].includes(key) && body.elements[key];
  const surface: BodyArt["surface"] = kind === "star" ? "star" : design.planet.composition;
  const ring = on("ring")
    ? {
        back: halfEllipse(RING.rx * r, RING.ry * r, "back"),
        front: halfEllipse(RING.rx * r, RING.ry * r, "front"),
        width: Math.max(RING.width * r, 1.5),
        tilt: RING.tiltDeg,
      }
    : null;
  const eyeW = Math.max(EYES.w * r, EYE_MIN);
  const eyeH = eyeW * EYES.aspect;
  const eyes: [Capsule, Capsule] | null = on("eyes")
    ? [
        { x: -EYES.x * r, y: EYES.y * r, w: eyeW, h: eyeH },
        { x: EYES.x * r, y: EYES.y * r, w: eyeW, h: eyeH },
      ]
    : null;
  const moons = on("moons")
    ? [
        { x: 1.42 * r, y: -0.62 * r, r: Math.max(0.17 * r, 3), behind: false },
        { x: -1.3 * r, y: 0.5 * r, r: Math.max(0.12 * r, 2.4), behind: true },
      ]
    : [];
  const corona = on("corona") ? { r: 1.14 * r, halo: 1.32 * r } : null;
  const craters =
    surface === "rock"
      ? [
          { x: -0.46 * r, y: -0.42 * r, r: 0.13 * r },
          { x: 0.42 * r, y: 0.46 * r, r: 0.11 * r },
          { x: 0.58 * r, y: -0.24 * r, r: 0.08 * r },
          { x: -0.34 * r, y: 0.56 * r, r: 0.07 * r },
        ]
      : [];
  const cap = surface === "ice" ? { cx: 0, cy: -0.8 * r, rx: 0.6 * r, ry: 0.24 * r } : null;
  const cracks =
    surface === "ice"
      ? [
          `M${round2(0.12 * r)} ${round2(0.46 * r)}L${round2(0.34 * r)} ${round2(0.58 * r)}L${round2(0.56 * r)} ${round2(0.4 * r)}`,
          `M${round2(-0.62 * r)} ${round2(0.16 * r)}L${round2(-0.46 * r)} ${round2(0.32 * r)}L${round2(-0.52 * r)} ${round2(0.54 * r)}`,
        ]
      : [];
  const bands =
    surface === "gas"
      ? [
          { y: -0.66 * r, h: 0.1 * r },
          { y: -0.44 * r, h: 0.08 * r },
          { y: 0.34 * r, h: 0.1 * r },
          { y: 0.58 * r, h: 0.12 * r },
        ]
      : [];
  const clouds = on("clouds")
    ? [
        { x: -0.62 * r, y: -0.58 * r, w: 0.7 * r, h: 0.1 * r },
        { x: -0.05 * r, y: 0.44 * r, w: 0.66 * r, h: 0.1 * r },
      ]
    : [];
  let ex = corona?.halo ?? r;
  let ey = corona?.halo ?? r;
  if (ring !== null) {
    ex = Math.max(ex, RING.rx * r + ring.width);
    ey = Math.max(ey, r);
  }
  for (const moon of moons) {
    ex = Math.max(ex, Math.abs(moon.x) + moon.r);
    ey = Math.max(ey, Math.abs(moon.y) + moon.r);
  }
  return { r, surface, corona, ring, craters, cap, cracks, bands, clouds, eyes, eyesTilt: EYES.tiltDeg, moons, extent: { x: ex, y: ey } };
}

/**
 * 预览画框（viewBox 的半宽 / 半高）：平时固定 PREVIEW_FRAME，质量变了天体就在同一个框里变大变小；
 * 天体连同星环 / 日冕 / 卫星装不下时，框按同一比例放大到刚好装下（留 8% 边），不让 100% 缩放时就被裁掉。
 * 预览缩放再作用在框里面。
 */
export const PREVIEW_FRAME = { halfW: 130, halfH: 90 } as const;

export function previewFrame(art: Pick<BodyArt, "extent">): { halfW: number; halfH: number; scale: number } {
  const scale = Math.max(1, (art.extent.x * 1.08) / PREVIEW_FRAME.halfW, (art.extent.y * 1.08) / PREVIEW_FRAME.halfH);
  return { halfW: PREVIEW_FRAME.halfW * scale, halfH: PREVIEW_FRAME.halfH * scale, scale };
}

/** 一只眼睛歪头之后的中心（屏幕坐标，绕天体中心顺时针转 tiltDeg） */
export function tiltedCenter(eye: Pick<Capsule, "x" | "y">, tiltDeg: number): { x: number; y: number } {
  const t = (tiltDeg * Math.PI) / 180;
  return { x: eye.x * Math.cos(t) - eye.y * Math.sin(t), y: eye.x * Math.sin(t) + eye.y * Math.cos(t) };
}

/** 星环前半上的采样点（已按 tilt 旋转）：测试用它证明星环从两眼下面绕过去 */
export function ringFrontPoints(r: number, samples = 48): { x: number; y: number }[] {
  const tilt = (RING.tiltDeg * Math.PI) / 180;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const theta = (Math.PI * i) / samples;
    const x = -Math.cos(theta) * RING.rx * r;
    const y = Math.sin(theta) * RING.ry * r;
    points.push({ x: x * Math.cos(tilt) - y * Math.sin(tilt), y: x * Math.sin(tilt) + y * Math.cos(tilt) });
  }
  return points;
}

// ── 三档 fixture 与每个工作区一份的设计稿 ──────────────────────────────

/** 原型专用：`?designer=bare|full` 切空元素 / 满载；不带参数是默认（一颗行星、常用元素） */
export type DesignLevel = "default" | "bare" | "full";

export function designLevelOf(search: string): DesignLevel {
  const value = new URLSearchParams(search).get("designer");
  return value === "bare" || value === "full" ? value : "default";
}

const ALL_OFF: Readonly<Record<ElementKey, boolean>> = { eyes: false, ring: false, clouds: false, moons: false, corona: false };
const ALL_ON: Readonly<Record<ElementKey, boolean>> = { eyes: true, ring: true, clouds: true, moons: true, corona: true };

/** 三个行星预设：工作区 id 的哈希挑一个。不同工作区一眼不一样，同一个工作区每次一样 */
const PLANET_PRESETS: readonly Omit<PlanetDesign, "name" | "elements" | "zoom">[] = [
  { mass: 6, composition: "rock", orbitRadius: 22 },
  { mass: 14, composition: "gas", orbitRadius: 30 },
  { mass: 3, composition: "ice", orbitRadius: 18 },
];
const ELEMENT_PRESETS: readonly Readonly<Record<ElementKey, boolean>>[] = [
  { ...ALL_OFF, eyes: true, clouds: true },
  { ...ALL_OFF, eyes: true, ring: true },
  { ...ALL_OFF, eyes: true, moons: true },
];

export function workspaceHash(id: string): number {
  let hash = 2166136261;
  for (const ch of id) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 满载档的长名字：超过 NAME_MAX，用来看面板会不会被撑开、错误会不会报出来 */
export const LONG_NAME = "一颗名字特别长用来检查面板会不会被撑开的行星开普勒四五二乙扩展版";

/** 默认主星质量：没在面板里设计过的工作区、全局首页都用它（与原型三档 fixture 同一个数） */
export const STAR_MASS_DEFAULT = 620;

export function defaultDesign(workspaceId: string, level: DesignLevel): GalaxyDesign {
  const pick = workspaceHash(workspaceId) % PLANET_PRESETS.length;
  const preset = PLANET_PRESETS[pick] ?? PLANET_PRESETS[0];
  const elements = ELEMENT_PRESETS[pick] ?? ALL_OFF;
  const base: GalaxyDesign = {
    editing: "planet",
    star: { name: "", mass: STAR_MASS_DEFAULT, elements: { ...ALL_OFF, eyes: true }, zoom: ZOOM_DEFAULT.star },
    planet: { name: "", elements, mass: 6, composition: "rock", orbitRadius: 22, zoom: ZOOM_DEFAULT.planet, ...preset },
    backdrop: "muted",
  };
  if (level === "bare") {
    return { ...base, star: { ...base.star, elements: ALL_OFF }, planet: { ...base.planet, elements: ALL_OFF } };
  }
  if (level === "full") {
    // 满载：所有元素开、质量顶到两个区间的上沿、名字超长、轨道近到与主星相撞——两条错误都要报出来
    return {
      ...base,
      star: { name: LONG_NAME, mass: STAR_MASS.max, elements: ALL_ON, zoom: ZOOM_DEFAULT.star },
      planet: { name: LONG_NAME, mass: PLANET_MASS.max, composition: "gas", orbitRadius: 9, elements: ALL_ON, zoom: ZOOM_DEFAULT.planet },
    };
  }
  return base;
}

/**
 * 每个工作区一份设计稿，只活在这次运行的内存里（原型：尚未写入配置）。面板关了再开、切到别的工作区再切回来
 * 都还在；重启就回到 fixture。按工作区 id 分开存，切工作区不会把上一个的参数带过去。
 */
export interface DesignStore {
  /** 同一个工作区没改过时每次返回同一个对象（useSyncExternalStore 要求快照稳定，否则每次渲染都算变了） */
  get: (workspaceId: string) => GalaxyDesign;
  /** 这个工作区在面板里改过（不是默认稿）：页面星系只在改过时才把设计的行星套到第一颗上 */
  has: (workspaceId: string) => boolean;
  set: (workspaceId: string, design: GalaxyDesign) => void;
  reset: (workspaceId: string) => GalaxyDesign;
  /** 任一工作区的设计稿变了就通知：侧栏头像与页面星系跟着重画。返回退订函数 */
  subscribe: (listener: () => void) => () => void;
}

export function createDesignStore(level: DesignLevel): DesignStore {
  const designs = new Map<string, GalaxyDesign>();
  const defaults = new Map<string, GalaxyDesign>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const fallback = (id: string): GalaxyDesign => {
    const cached = defaults.get(id);
    if (cached !== undefined) return cached;
    const fresh = defaultDesign(id, level);
    defaults.set(id, fresh);
    return fresh;
  };
  return {
    get: (id) => designs.get(id) ?? fallback(id),
    has: (id) => designs.has(id),
    set: (id, design) => {
      designs.set(id, design);
      notify();
    },
    reset: (id) => {
      designs.delete(id);
      notify();
      return fallback(id);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ── 面板开合：DIY 键、切工作区、切会话 ──────────────────────────────────

export interface DesignerPanelState {
  panel: RightPanelKind | null;
  /** 面板在设计哪个工作区的星系 */
  target: string | null;
}

/** 点某个工作区的 DIY 键：面板正开着同一个工作区 = 收起；否则打开（或换成）这个工作区 */
export function designerClick(state: DesignerPanelState, workspaceId: string): DesignerPanelState {
  if (state.panel === "galaxy" && state.target === workspaceId) return { panel: null, target: workspaceId };
  return { panel: "galaxy", target: workspaceId };
}

/**
 * 主槽换了工作区（打开别的工作区里的会话、在别的工作区新建任务）：面板开着就跟过去，换成那个工作区的设计稿；
 * 换到不属于任何工作区的任务时不跟（没有星系可设计，面板仍写着它在设计哪个工作区）。面板关着不动。
 */
export function designerFollow(state: DesignerPanelState, workspaceId: string | null): DesignerPanelState {
  if (state.panel !== "galaxy" || workspaceId === null || workspaceId === state.target) return state;
  return { panel: "galaxy", target: workspaceId };
}

/**
 * 切主槽会话时右栏按会话记忆恢复；星系设计面板是工作区级的、不进会话记忆，开着时目标会话又没记过别的面板，就留着它。
 * 目标会话记着别的面板（文件、审查……），照记忆换过去。
 */
export function keepDesignerAcrossSessions(current: RightPanelKind | null, recalled: RightPanelKind | null): RightPanelKind | null {
  return current === "galaxy" && recalled === null ? "galaxy" : recalled;
}

/** 数字输入框的文字 → 数值；空串与非数字给 NaN（交给 validateDesign 报错，不默默回退） */
export function parseNumberInput(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return Number.NaN;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** 面板上显示的数：最多两位小数，去掉尾零 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return String(Math.round(value * 100) / 100);
}

export { clamp as clampValue };
