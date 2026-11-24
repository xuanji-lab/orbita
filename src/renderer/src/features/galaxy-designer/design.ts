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
import type { EyeStyle, PlanetMix, PlanetWriteBody, PlanetWriteRequest, WorkspacePlanets } from "@shared/planet-design";
import { classOfDensity, legacyMix, mixPhysics, planetDensity, seedOf, starDefaultMix } from "./mix.ts";
// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { EYE_STYLE_DEFAULT } from "../../../../shared/planet-design.ts";

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
 * 140% 下任何合法行星（最重的气态 + 星环 + 卫星）都装得进固定画框（见测试）。主星默认 70%：它压在一张引力网格布上
 * （well.ts），100% 时主星把网格的坑整个盖住、看不出布怎么弯；70% 让坑四周的弯线露出来。满载主星 + 日冕 + 星环再由 previewFrame 放大画框装下。
 */
export const ZOOM_DEFAULT: Readonly<Record<BodyKind, number>> = { star: 70, planet: 140 };
/** 轨道半径滑块的范围；合法下限另由两颗天体的半径算（minOrbit），滑块能拖到下限以下，拖过去就报错 */
export const ORBIT_RANGE = { min: 4, max: PLANET_ZONE, step: 0.5 } as const;
/** 天体名字最多几个字（按字符数，中文一个字算一个） */
export const NAME_MAX = 24;

/**
 * 无脸地表图（插件 planet-forge 出的 Qwen 地表，主进程裁成球、缩小后的 data URL）：画在代码画的圆里当贴图，
 * 明暗由代码叠；眼睛、星环、日冕照旧由代码画——图里不出现眼睛和嘴。flip = 上下翻转（地表上的风暴落在眼睛下方会被读成嘴）。
 */
export interface SurfaceImage {
  src: string;
  flip: boolean;
}

export interface BodyDesign {
  /** 空串 = 用默认名（主星用工作区名，行星用「未命名行星」） */
  name: string;
  mass: number;
  elements: Readonly<Record<ElementKey, boolean>>;
  /** 这一颗的预览缩放（百分比）：主星与行星各记各的，切换天体类型不互相影响 */
  zoom: number;
  /** 地表图；没有 = 代码画纹理（种子稿、没出过图的天体） */
  surface?: SurfaceImage | null;
  /** 主星的一句故事 / 行星的职责（插件稿与伴随文件里来，只显示） */
  note?: string | null;
  /** 眼睛样式（面板里 DIY，存进 planet/galaxy.json）；缺席 = 没设过，画成 EYE_STYLE_DEFAULT（大） */
  eyeStyle?: EyeStyle;
  /** 元素构成（面板「成分」一节）；缺席 = 没改过：行星按 composition 映射一组默认元素，主星取太阳的量级（mixOf / starMixOf） */
  mix?: PlanetMix;
}

export interface PlanetDesign extends BodyDesign {
  /** 成分类别（纹理与只认三类的读者用）：有元素构成时由构成推出的密度归类（withMix），不再单独选 */
  composition: Composition;
  orbitRadius: number;
  /** 子智能体的 id（伴随文件 planet/galaxy.json 里的）；面板里新加、还没落盘的没有 */
  id?: string;
}

/**
 * 一座星系的设计稿。**不变量：没有主星就没有行星**——star 为 null 时 planet 必为 null
 * （璇玑星系规则：行星是绕主星运行的子智能体）。所有写入口都过 normalizeDesign，加行星只走 addPlanet（没主星就拒绝），
 * validateDesign 对违反不变量的数据报 planet-without-star；面板上不只是把按钮置灰。
 */
export interface GalaxyDesign {
  /** 面板正在看哪一页：主星或行星（页可以是空的：没主星时行星页是「先创建主星」的空态） */
  editing: BodyKind;
  /** null = 这座星系还没有主星 */
  star: BodyDesign | null;
  /** null = 还没有行星；star 为 null 时必为 null */
  planet: PlanetDesign | null;
  backdrop: Backdrop;
  /**
   * 这座星系的全部子智能体（每颗一颗行星）。planet 是面板正在编辑的那一颗（= planets[planetIndex]），
   * normalizeDesign 保证两者同步。缺席 = 只有 planet 这一颗（老的单行星稿、种子稿）。
   */
  planets?: readonly PlanetDesign[];
  planetIndex?: number;
}

/** 主星和行星都在的设计稿：三档 fixture 与测试用的都是这种 */
export interface CompleteDesign extends GalaxyDesign {
  star: BodyDesign;
  planet: PlanetDesign;
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

/** 一颗行星的元素构成：有就用；旧稿（只有成分类别）映射成一组默认元素，种子按 id 起 */
export function mixOf(planet: PlanetDesign): PlanetMix {
  return planet.mix ?? legacyMix(planet.composition, seedOf(planet.id ?? planet.name));
}

/** 主星的元素构成：有就用，没有取太阳的量级（只影响颜色提示，主星密度固定） */
export function starMixOf(star: BodyDesign, seedKey: string): PlanetMix {
  return star.mix ?? starDefaultMix(seedOf(seedKey));
}

/** 改了构成：成分类别跟着推出来的密度走（构成里没有整体·质量这一组时类别不动） */
export function withMix(planet: PlanetDesign, mix: PlanetMix): PlanetDesign {
  const physics = mixPhysics(mix);
  return { ...planet, mix, composition: physics === null ? planet.composition : classOfDensity(physics.density) };
}

/** 天体的密度（g/cm³）：主星固定；行星按元素构成推（旧稿按成分类别） */
export function bodyDensity(design: GalaxyDesign, kind: BodyKind): number {
  if (kind === "star") return STAR_DENSITY;
  return design.planet === null ? Number.NaN : planetDensity(design.planet);
}

/** 天体半径（与轨道同一单位）：galaxy.ts 的同一条公式，(质量 / 密度)^(1/3)，质量先夹进区间。这颗天体不存在时是 NaN */
export function radiusOf(design: GalaxyDesign, kind: BodyKind): number {
  if (kind === "star") return design.star === null ? Number.NaN : starRadius(design.star.mass);
  return design.planet === null ? Number.NaN : planetRadius({ ...design.planet, density: planetDensity(design.planet) });
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
  | { kind: "name-long"; body: BodyKind; max: number; length: number }
  /** 数据违反了不变量：有行星、没主星。面板里走不到（加行星要先有主星），读进来的坏数据才会有 */
  | { kind: "planet-without-star" };

export function nameLength(name: string): number {
  return [...name].length;
}

/**
 * 逐条找出不合规则的参数。不夹、不改：值原样留着、错误原样报出来，面板把错写在对应那一行下面，
 * 预览打上不合法的记号——「不默默接受非法组合」。质量非数字（输入框清空）也算越界。
 */
export function validateDesign(design: GalaxyDesign): DesignError[] {
  const errors: DesignError[] = [];
  if (design.star === null && design.planet !== null) errors.push({ kind: "planet-without-star" });
  for (const body of ["star", "planet"] as const) {
    const it = design[body];
    if (it === null) continue;
    const { min, max } = massRange(body);
    const value = it.mass;
    if (!Number.isFinite(value) || value < min || value > max) errors.push({ kind: "mass-range", body, min, max, value });
    const length = nameLength(it.name);
    if (length > NAME_MAX) errors.push({ kind: "name-long", body, max: NAME_MAX, length });
  }
  if (design.star === null || design.planet === null) return errors;
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
    if (error.kind === "planet-without-star") return false;
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
  /** 地表图：有就画贴图（裁在圆里）+ 代码明暗，成分纹理（坑、极冠、带）不再画 */
  image: SurfaceImage | null;
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
  /** 眼睛样式（这颗天体设计稿里的，没设过取默认）：BodyFigure 据此决定白眼的填色与亮边宽 */
  eyeStyle: EyeStyle;
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

/**
 * 眼睛尺寸的四档（2026-11-24 用户：「眼睛太小了，感觉不可爱。你看看 grok bot 的」，之后「开放一个选项可 diy 吧」）：s = 最早的尺寸（眼高约直径的 14%），
 * 往 grok bot 的方向放大——l 档眼高约直径的 30%、两眼间距约一只眼宽；长宽比守提示词的 2.2–2.8。
 * 眼睛越大，整双眼的中心越往下挪一点（不顶到天体上缘），歪头的倾角收一点（大眼睛转 12° 两眼高低差太明显）。
 * 「白眼」（xl 的几何 + 浅色填充）在规则外，只供讨论。
 */
export type EyeSize = "s" | "m" | "l" | "xl";
/**
 * ringRy：这一档配的星环纵半轴（单位 = 天体半径）。眼睛大了下缘更低，星环前半要再开一点才能照旧从两眼下面绕过去
 * （规则：星环不压眼睛），l / xl 的环看起来更「俯视」一些。
 */
export const EYE_SIZES: Readonly<Record<EyeSize, { x: number; y: number; w: number; aspect: number; tiltDeg: number; ringRy: number }>> = {
  s: { ...EYES, ringRy: 0.3 },
  m: { x: 0.2, y: -0.09, w: 0.17, aspect: 2.5, tiltDeg: 10, ringRy: 0.3 },
  l: { x: 0.24, y: -0.08, w: 0.24, aspect: 2.5, tiltDeg: 8, ringRy: 0.42 },
  xl: { x: 0.27, y: -0.06, w: 0.28, aspect: 2.5, tiltDeg: 8, ringRy: 0.56 },
};

/** 样式 → 几何档：白眼用特大的几何 */
export function eyeSizeOf(style: EyeStyle): EyeSize {
  return style === "xl-white" ? "xl" : style;
}

/** 一颗天体实际画的眼睛样式：设计稿里没设过的取默认（大） */
export function eyeStyleOf(body: Pick<BodyDesign, "eyeStyle"> | null | undefined): EyeStyle {
  return body?.eyeStyle ?? EYE_STYLE_DEFAULT;
}

/** 一只胶囊眼（歪头后）的中轴线段与半宽：纹理避让与测试都按它量 */
export function eyeSegment(eye: Capsule, tiltDeg: number): { a: { x: number; y: number }; b: { x: number; y: number }; pad: number } {
  const t = (tiltDeg * Math.PI) / 180;
  const c = tiltedCenter(eye, tiltDeg);
  const half = eye.h / 2 - eye.w / 2;
  const dx = -Math.sin(t) * half;
  const dy = Math.cos(t) * half;
  return { a: { x: c.x - dx, y: c.y - dy }, b: { x: c.x + dx, y: c.y + dy }, pad: eye.w / 2 };
}

function segmentDistance(p: { x: number; y: number }, seg: ReturnType<typeof eyeSegment>): number {
  const vx = seg.b.x - seg.a.x;
  const vy = seg.b.y - seg.a.y;
  const len = vx * vx + vy * vy;
  const k = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - seg.a.x) * vx + (p.y - seg.a.y) * vy) / len));
  return Math.hypot(p.x - seg.a.x - k * vx, p.y - seg.a.y - k * vy);
}

/**
 * 深色地表上眼睛外描的亮边宽（描在填色外面，外露一半）：s 档照旧是眼宽的 0.45；放大的档按天体半径给、封顶，
 * 不让大眼睛在 96px 头像上描出一道粗白圈
 */
export function eyeRimWidth(eyeW: number, r: number, size: EyeSize): number {
  if (size === "s") return eyeW * 0.45;
  return Math.min(eyeW * 0.45, Math.max(0.8, r * 0.045));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 半个椭圆（未旋转；旋转交给外层 transform）：back = 上半圈（远侧），front = 下半圈（近侧） */
function halfEllipse(rx: number, ry: number, half: "back" | "front"): string {
  const sweep = half === "back" ? 1 : 0;
  return `M${round2(-rx)} 0A${round2(rx)} ${round2(ry)} 0 0 ${sweep} ${round2(rx)} 0`;
}

/** 主星连星环 / 日冕的外缘是主星半径的几倍（元素都关 = 1）：页面星系据此把第一圈轨道推出去，行星不从星环里穿过 */
export function starExtentRatio(design: GalaxyDesign): number {
  if (design.star === null) return 1;
  const { ring, corona } = design.star.elements;
  return Math.max(1, ring ? RING.rx : 1, corona ? 1.32 : 1);
}

export function bodyArt(design: GalaxyDesign, kind: BodyKind, r: number): BodyArt {
  const body = kind === "star" ? design.star : design.planet;
  if (body === null) throw new Error(`bodyArt：这座星系没有${kind === "star" ? "主星" : "行星"}，调用方应先显示空态`);
  const on = (key: ElementKey): boolean => ELEMENTS_OF[kind].includes(key) && body.elements[key];
  const surface: BodyArt["surface"] = design.planet !== null && kind === "planet" ? design.planet.composition : "star";
  const image = body.surface ?? null;
  const textured = image === null;
  const eyeStyle = eyeStyleOf(body);
  const geo = EYE_SIZES[eyeSizeOf(eyeStyle)];
  const ring = on("ring")
    ? {
        back: halfEllipse(RING.rx * r, geo.ringRy * r, "back"),
        front: halfEllipse(RING.rx * r, geo.ringRy * r, "front"),
        width: Math.max(RING.width * r, 1.5),
        tilt: RING.tiltDeg,
      }
    : null;
  const eyeW = Math.max(geo.w * r, EYE_MIN);
  const eyeH = eyeW * geo.aspect;
  const eyes: [Capsule, Capsule] | null = on("eyes")
    ? [
        { x: -geo.x * r, y: geo.y * r, w: eyeW, h: eyeH },
        { x: geo.x * r, y: geo.y * r, w: eyeW, h: eyeH },
      ]
    : null;
  // 纹理（坑、极冠裂纹、纬向带、云带）不压眼睛：眼睛大了，压到的那几笔不画（s 档的位置本来就避开了）
  const segments = eyes === null ? [] : eyes.map((eye) => eyeSegment(eye, geo.tiltDeg));
  const eyeTop = Math.min(...segments.flatMap((seg) => [seg.a.y, seg.b.y].map((y) => y - seg.pad))) - 1;
  const eyeBottom = Math.max(...segments.flatMap((seg) => [seg.a.y, seg.b.y].map((y) => y + seg.pad))) + 1;
  const clearOfEyes = (c: Circle): boolean => segments.every((seg) => segmentDistance(c, seg) > c.r + seg.pad);
  const clearRow = (y: number, h: number): boolean => segments.length === 0 || y + h < eyeTop || y > eyeBottom;
  const moons = on("moons")
    ? [
        { x: 1.42 * r, y: -0.62 * r, r: Math.max(0.17 * r, 3), behind: false },
        { x: -1.3 * r, y: 0.5 * r, r: Math.max(0.12 * r, 2.4), behind: true },
      ]
    : [];
  const corona = on("corona") ? { r: 1.14 * r, halo: 1.32 * r } : null;
  const craters = (
    textured && surface === "rock"
      ? [
          { x: -0.46 * r, y: -0.42 * r, r: 0.13 * r },
          { x: 0.42 * r, y: 0.46 * r, r: 0.11 * r },
          { x: 0.58 * r, y: -0.24 * r, r: 0.08 * r },
          { x: -0.34 * r, y: 0.56 * r, r: 0.07 * r },
        ]
      : []
  ).filter(clearOfEyes);
  const cap = textured && surface === "ice" ? { cx: 0, cy: -0.8 * r, rx: 0.6 * r, ry: 0.24 * r } : null;
  const cracks =
    textured && surface === "ice"
      ? [
          `M${round2(0.12 * r)} ${round2(0.46 * r)}L${round2(0.34 * r)} ${round2(0.58 * r)}L${round2(0.56 * r)} ${round2(0.4 * r)}`,
          `M${round2(-0.62 * r)} ${round2(0.16 * r)}L${round2(-0.46 * r)} ${round2(0.32 * r)}L${round2(-0.52 * r)} ${round2(0.54 * r)}`,
        ]
      : [];
  const bands = (
    textured && surface === "gas"
      ? [
          { y: -0.66 * r, h: 0.1 * r },
          { y: -0.44 * r, h: 0.08 * r },
          { y: 0.34 * r, h: 0.1 * r },
          { y: 0.58 * r, h: 0.12 * r },
        ]
      : []
  ).filter((band) => clearRow(band.y, band.h));
  const clouds = (
    on("clouds")
      ? [
          { x: -0.62 * r, y: -0.58 * r, w: 0.7 * r, h: 0.1 * r },
          { x: -0.05 * r, y: 0.44 * r, w: 0.66 * r, h: 0.1 * r },
        ]
      : []
  ).filter((cloud) => clearRow(cloud.y, cloud.h));
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
  return { r, image, surface, corona, ring, craters, cap, cracks, bands, clouds, eyes, eyesTilt: geo.tiltDeg, eyeStyle, moons, extent: { x: ex, y: ey } };
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
export function ringFrontPoints(r: number, samples = 48, ry: number = RING.ry): { x: number; y: number }[] {
  const tilt = (RING.tiltDeg * Math.PI) / 180;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const theta = (Math.PI * i) / samples;
    const x = -Math.cos(theta) * RING.rx * r;
    const y = Math.sin(theta) * ry * r;
    points.push({ x: x * Math.cos(tilt) - y * Math.sin(tilt), y: x * Math.sin(tilt) + y * Math.cos(tilt) });
  }
  return points;
}

// ── 三档 fixture 与每个工作区一份的设计稿 ──────────────────────────────

/** 原型专用：`?designer=bare|full|nostar` 切空元素 / 满载 / 还没有主星；不带参数是默认（一颗主星 + 一颗行星） */
export type DesignLevel = "default" | "bare" | "full" | "nostar";

export function designLevelOf(search: string): DesignLevel {
  const value = new URLSearchParams(search).get("designer");
  return value === "bare" || value === "full" || value === "nostar" ? value : "default";
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

function defaultStar(): BodyDesign {
  return { name: "", mass: STAR_MASS_DEFAULT, elements: { ...ALL_OFF, eyes: true }, zoom: ZOOM_DEFAULT.star };
}

function defaultPlanet(workspaceId: string): PlanetDesign {
  const pick = workspaceHash(workspaceId) % PLANET_PRESETS.length;
  const preset = PLANET_PRESETS[pick] ?? PLANET_PRESETS[0];
  const elements = ELEMENT_PRESETS[pick] ?? ALL_OFF;
  return { name: "", elements, mass: 6, composition: "rock", orbitRadius: 22, zoom: ZOOM_DEFAULT.planet, ...preset };
}

export function defaultDesign(workspaceId: string, level: Exclude<DesignLevel, "nostar">): CompleteDesign {
  const base: CompleteDesign = {
    // 打开面板默认停在主星：它就是这个工作区的主智能体本人（2026-11-24 用户：主智能体只能是主星，不是行星）
    editing: "star",
    star: defaultStar(),
    planet: defaultPlanet(workspaceId),
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
 * 页面星系里一颗行星的「脸」：只开眼睛的行星设计稿（成分跟着这件活走，质量与轨道只是占位，画图不读）。
 * 星系规则「主星与行星的大小差距应缩小到行星表情可读的程度」——页面上每颗行星都画成带两只竖胶囊眼的小天体，
 * 不再是一个素圆点；星环、云带、卫星在十来个像素上只会糊，不开。
 */
export function planetFaceDesign(composition: Composition, surface: SurfaceImage | null = null, eyeStyle?: EyeStyle): CompleteDesign {
  return {
    editing: "planet",
    star: defaultStar(),
    planet: { name: "", mass: 6, composition, orbitRadius: 22, zoom: ZOOM_DEFAULT.planet, elements: { ...ALL_OFF, eyes: true }, surface, ...(eyeStyle === undefined ? {} : { eyeStyle }) },
    backdrop: "muted",
  };
}

/** 主星（还没有主星时取默认主星）：头像、页面星系这些「总得画出一颗主星」的地方用它，不改设计稿本身 */
export function starOf(design: GalaxyDesign): BodyDesign {
  return design.star ?? defaultStar();
}

/** 补上主星的设计稿（已有就原样返回）：给只认「有主星」的绘制函数用 */
export function withStar(design: GalaxyDesign): GalaxyDesign & { star: BodyDesign } {
  return design.star === null ? { ...design, star: defaultStar(), planet: null } : { ...design, star: design.star };
}

/** 某一档 fixture 的设计稿：nostar 是还没有主星（也就没有行星）的星系，停在主星页 */
export function fixtureDesign(workspaceId: string, level: DesignLevel): GalaxyDesign {
  if (level === "nostar") return { editing: "star", star: null, planet: null, backdrop: "muted" };
  return defaultDesign(workspaceId, level);
}

/**
 * 守不变量：没有主星就把行星一起拿掉；有行星名单时，正在编辑的那颗写回名单里它的位置（面板只改 planet，
 * 名单跟着变）。已经合规就原样返回（引用不变）。
 */
export function normalizeDesign(design: GalaxyDesign): GalaxyDesign {
  if (design.star === null) {
    return design.planet !== null || (design.planets !== undefined && design.planets.length > 0) ? { ...design, planet: null, planets: [] } : design;
  }
  const list = design.planets;
  if (list === undefined || design.planet === null) return design;
  const index = clamp(design.planetIndex ?? 0, 0, Math.max(0, list.length - 1));
  if (list[index] === design.planet) return design;
  if (list.length === 0) return { ...design, planets: [design.planet], planetIndex: 0 };
  return { ...design, planets: list.map((planet, i) => (i === index ? (design.planet as PlanetDesign) : planet)), planetIndex: index };
}

/** 面板切到第 index 颗子智能体（越界夹回来） */
export function selectPlanet(design: GalaxyDesign, index: number): GalaxyDesign {
  const list = design.planets;
  if (list === undefined || list.length === 0) return design;
  const i = clamp(Math.round(index), 0, list.length - 1);
  return { ...design, planet: list[i] ?? null, planetIndex: i, editing: "planet" };
}

/**
 * 页面星系上画哪些子智能体：只画名单 planets（工作区 planet/ 里读来的，或用户在面板里明确新增 / 改过的那颗，见 commitPlanet）。
 * 没有名单时 planet 只是面板里的示例草稿，不是真的子智能体——只改主星不会让它变成行星
 * （2026-11-24 Windows 验收：只把主星质量 40 → 71，重载后多出一颗「未命名行星」，galaxy.json 里写进了 planet-1）。
 */
export function agentPlanetsOf(design: GalaxyDesign): readonly PlanetDesign[] {
  if (design.star === null) return [];
  return design.planets ?? [];
}

/**
 * 用户明确要这颗行星（点了「添加行星」或在行星页改了它）：草稿进名单。已有名单原样返回。
 * 只有进了名单的行星才画到页面星系上、才写回工作区 planet/。
 */
export function commitPlanet(design: GalaxyDesign): GalaxyDesign {
  if (design.star === null || design.planet === null || design.planets !== undefined) return design;
  return { ...design, planets: [design.planet], planetIndex: 0 };
}

/** 星系数据层要的子智能体行星（galaxy-data 的 AgentPlanetInput）：没有 id 的按次序起一个 */
export function agentInputsOf(planets: readonly PlanetDesign[]): { id: string; mass: number; composition: Composition; density?: number; orbitRadius: number }[] {
  return planets.map((planet, index) => ({
    id: planet.id ?? `planet-${index + 1}`,
    mass: Number.isFinite(planet.mass) ? planet.mass : 6,
    composition: planet.composition,
    // 只有面板里改过构成的才带密度；旧稿照旧按成分类别（推出来的差 < 0.5%，不让老星系的轨道因此挪一下）
    ...(planet.mix === undefined ? {} : { density: planetDensity(planet) }),
    orbitRadius: Number.isFinite(planet.orbitRadius) ? planet.orbitRadius : defaultAgentOrbit(index),
  }));
}

/** HomeGalaxy 的 agents：行星 id → 设计稿（与 agentInputsOf 同一套 id） */
export function agentMapOf(planets: readonly PlanetDesign[]): Map<string, PlanetDesign> {
  return new Map(planets.map((planet, index) => [planet.id ?? `planet-${index + 1}`, planet]));
}

// ── 与工作区 planet/ 的换算（盘上 M⊕，界面单位 = M⊕ × 10）────────────────

export const MASS_UNIT_PER_EARTH = 10;

/** 没给轨道的第 i 颗子智能体的默认轨道（与 galaxy-data 的 orbitRadiusOf 同一个起点与步长） */
export function defaultAgentOrbit(index: number): number {
  return 19 + 12 * index;
}

/**
 * 盘上读回的设计稿 → 面板的设计稿。读不到的字段取 fallback（按工作区 id 取的种子稿）；
 * 主星不随机星环 / 日冕：盘上有就照盘上，没有只开眼睛（地表图已经是它的样子，不再给它加装饰）。
 */
export function designFromPlanets(data: WorkspacePlanets, fallback: GalaxyDesign): GalaxyDesign {
  const baseStar = starOf(fallback);
  const main = data.main;
  const star: BodyDesign | null =
    main === null
      ? data.planets.length > 0
        ? baseStar
        : null
      : {
          name: main.name,
          mass: main.massEarth === null ? baseStar.mass : main.massEarth * MASS_UNIT_PER_EARTH,
          elements: { ...ALL_OFF, eyes: true, ...(main.elements ?? {}) },
          zoom: ZOOM_DEFAULT.star,
          surface: main.surface === null ? null : { src: main.surface, flip: main.flip },
          note: main.note,
          ...(main.eyeStyle === null ? {} : { eyeStyle: main.eyeStyle }),
          ...(main.mix === null ? {} : { mix: main.mix }),
        };
  if (star === null) return fallback;
  const planets: PlanetDesign[] = data.planets.map((body, index) => ({
    id: body.id,
    name: body.name,
    mass: body.massEarth === null ? 6 : body.massEarth * MASS_UNIT_PER_EARTH,
    composition: body.composition ?? "rock",
    ...(body.mix === null ? {} : { mix: body.mix }),
    orbitRadius: body.orbit ?? defaultAgentOrbit(index),
    elements: { ...ALL_OFF, eyes: true, ...(body.elements ?? {}) },
    zoom: ZOOM_DEFAULT.planet,
    surface: body.surface === null ? null : { src: body.surface, flip: body.flip },
    note: body.note,
    ...(body.eyeStyle === null ? {} : { eyeStyle: body.eyeStyle }),
  }));
  return { editing: "star", star, planet: planets[0] ?? null, planets, planetIndex: 0, backdrop: fallback.backdrop };
}

function writeBody(id: string, body: BodyDesign, composition: Composition | null, orbit: number | null, mix?: PlanetMix): PlanetWriteBody {
  return {
    ...(mix === undefined ? {} : { mix }),
    id,
    name: body.name,
    massEarth: Math.round((body.mass / MASS_UNIT_PER_EARTH) * 1000) / 1000,
    composition,
    orbit,
    elements: { ...body.elements },
    ...(body.eyeStyle === undefined ? {} : { eyeStyle: body.eyeStyle }),
  };
}

/** 写回不合法的数（质量清空 = NaN）时不写：等它改回合法再写，盘上永远是一份读得回来的稿 */
export function writableDesign(design: GalaxyDesign): boolean {
  const all = [design.star, ...(design.planets ?? (design.planet === null ? [] : [design.planet]))];
  return all.every((body) => body === null || (Number.isFinite(body.mass) && body.mass > 0));
}

/** 面板的设计稿 → 写回请求（没有 id 的新行星按次序起一个 planet-N） */
export function planetsWriteOf(workspaceId: string, design: GalaxyDesign): PlanetWriteRequest {
  // 只写名单里的行星：面板里没进名单的示例草稿不落盘（只改主星时 planets 原样，原来没有就写空）
  const list = design.star === null ? [] : (design.planets ?? []);
  return {
    workspaceId,
    main: design.star === null ? null : writeBody("main", design.star, null, null, design.star.mix),
    planets: list.map((planet, index) => writeBody(planet.id ?? `planet-${index + 1}`, planet, planet.composition, planet.orbitRadius, planet.mix)),
  };
}

/** 创建主星（已有就原样返回），并切到主星页 */
export function createStar(design: GalaxyDesign): GalaxyDesign {
  return design.star === null ? { ...design, star: defaultStar(), editing: "star" } : { ...design, editing: "star" };
}

export type AddPlanetResult = { ok: true; design: GalaxyDesign } | { ok: false; reason: "no-star" };

/** 加一颗行星（已有就原样返回）。没有主星时拒绝——行星必须绕着主星，这是数据层的规矩，不靠按钮置灰 */
export function addPlanet(design: GalaxyDesign, workspaceId: string): AddPlanetResult {
  if (design.star === null) return { ok: false, reason: "no-star" };
  if (design.planet !== null) return { ok: true, design: commitPlanet({ ...design, editing: "planet" }) };
  return { ok: true, design: commitPlanet({ ...design, planet: defaultPlanet(workspaceId), editing: "planet" }) };
}

/**
 * 没设计过的工作区的「种子默认」：以工作区 id 为种子，从面板已有的参数里取一套稳定的稿——
 * 主星质量（300–1000，步长 100，决定主星半径）、星环、日冕（眼睛恒开：它是「这是个智能体」的脸）；行星的成分与元素沿用 defaultDesign 的三套预设。
 * 只用面板里本来就有的开关与数值，颜色仍由主题 token 决定（主星没有可调的色），所以不会冒出裸 hex；
 * 质量夹在 STAR_MASS / PLANET_MASS 里，行星轨道取合法区间内（不撞主星、不出行星区），所以不违反引力语法。
 * 同一个 id 永远同一套；不同 id 在 8 档质量 × 星环 × 日冕 = 32 种之间散开（12 个工作区大概率各不相同，碰撞概率见测试）。
 * 注意主星没有成分 / 色调 / 纹理 / 云带这些轴（那是行星的），所以主星头像的差异轴只有这三个。
 */
export const STAR_MASS_STEPS = 8;

/** 头像按质量缩放的系数：最轻的主星 0.8、最重的 1（侧栏头像槽是固定的 28px，按这个系数在槽里放大放小） */
export const AVATAR_SCALE = { min: 0.8, max: 1 } as const;

export function avatarScale(mass: number): number {
  const t = (clamp(mass, STAR_MASS.min, STAR_MASS.max) - STAR_MASS.min) / (STAR_MASS.max - STAR_MASS.min);
  return AVATAR_SCALE.min + (AVATAR_SCALE.max - AVATAR_SCALE.min) * t;
}

export function seededDesign(workspaceId: string, level: Exclude<DesignLevel, "nostar"> = "default"): CompleteDesign {
  const base = defaultDesign(workspaceId, level);
  const bits = workspaceHash(`${workspaceId}:star`);
  const mass = STAR_MASS.min + 100 * ((bits >>> 3) % STAR_MASS_STEPS);
  const star: BodyDesign = {
    ...base.star,
    mass: clamp(mass, STAR_MASS.min, STAR_MASS.max),
    elements: { ...ALL_OFF, eyes: true, ring: (bits & 1) === 1, corona: (bits & 2) === 2 },
  };
  const draft: CompleteDesign = { ...base, star };
  // 行星轨道：预设值落在合法区间外（主星大了会撞）就挪到下限之上一格
  const orbit = clamp(draft.planet.orbitRadius, minOrbit(draft) + 1, Math.max(minOrbit(draft) + 1, maxOrbit(draft)));
  return { ...draft, planet: { ...draft.planet, orbitRadius: orbit } };
}

/**
 * 每个工作区一份设计稿，只活在这次运行的内存里（原型：尚未写入配置）。面板关了再开、切到别的工作区再切回来
 * 都还在；重启就回到 fixture。按工作区 id 分开存，切工作区不会把上一个的参数带过去。
 */
/** 设计稿从哪来：面板里改过 / 工作区 planet/ 里读来的 / 默认（种子）稿 */
export type DesignOrigin = "edited" | "file" | "default";

export interface DesignStore {
  /** 同一个工作区没改过时每次返回同一个对象（useSyncExternalStore 要求快照稳定，否则每次渲染都算变了） */
  get: (workspaceId: string) => GalaxyDesign;
  origin: (workspaceId: string) => DesignOrigin;
  /** 从工作区 planet/ 读回来的稿（不算「改过」）；null = 盘上没有，回退种子稿 */
  load: (workspaceId: string, design: GalaxyDesign | null) => void;
  /** 默认稿（种子稿）：读盘失败 / 没有设计稿时用它，也是 designFromPlanets 的 fallback */
  fallback: (workspaceId: string) => GalaxyDesign;
  /** 这个工作区在面板里改过（不是默认稿）：页面星系只在改过时才把设计的行星套到第一颗上 */
  has: (workspaceId: string) => boolean;
  set: (workspaceId: string, design: GalaxyDesign) => void;
  reset: (workspaceId: string) => GalaxyDesign;
  /** 默认稿的来源变了（种子默认开 / 关）：丢掉缓存的默认稿、通知订阅者重画；用户设计过的稿不动 */
  refresh: () => void;
  /** 任一工作区的设计稿变了就通知：侧栏头像与页面星系跟着重画。返回退订函数 */
  subscribe: (listener: () => void) => () => void;
}

export function createDesignStore(level: DesignLevel, options: { seeded?: boolean | (() => boolean) } = {}): DesignStore {
  const isSeeded = (): boolean => (typeof options.seeded === "function" ? options.seeded() : options.seeded === true);
  const designs = new Map<string, GalaxyDesign>();
  const loaded = new Map<string, GalaxyDesign>();
  const defaults = new Map<string, GalaxyDesign>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const fallback = (id: string): GalaxyDesign => {
    const cached = defaults.get(id);
    if (cached !== undefined) return cached;
    const fresh = level === "nostar" ? fixtureDesign(id, level) : isSeeded() ? seededDesign(id, level) : defaultDesign(id, level);
    defaults.set(id, fresh);
    return fresh;
  };
  return {
    get: (id) => designs.get(id) ?? loaded.get(id) ?? fallback(id),
    has: (id) => designs.has(id) || loaded.has(id),
    origin: (id) => (designs.has(id) ? "edited" : loaded.has(id) ? "file" : "default"),
    fallback,
    load: (id, design) => {
      if (design === null) loaded.delete(id);
      else loaded.set(id, normalizeDesign(design));
      notify();
    },
    refresh: () => {
      defaults.clear();
      notify();
    },
    // 存之前再守一次不变量：哪条路径写进来的「有行星没主星」都存不进去
    set: (id, design) => {
      designs.set(id, normalizeDesign(design));
      notify();
    },
    reset: (id) => {
      designs.delete(id);
      notify();
      return loaded.get(id) ?? fallback(id);
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
 * 换到不属于任何工作区的任务（星际空间）时收起——那里没有星系可设计，留着上一个工作区的面板会让人以为在改眼前这座
 * （2026-11-24 Windows 验收：设计面板开着时切到别的工作区或页面，面板不跟着收起或换）。面板关着不动。
 */
export function designerFollow(state: DesignerPanelState, workspaceId: string | null): DesignerPanelState {
  if (state.panel !== "galaxy" || workspaceId === state.target) return state;
  if (workspaceId === null) return { panel: null, target: state.target };
  return { panel: "galaxy", target: workspaceId };
}

/**
 * 切主槽会话时右栏按会话记忆恢复；星系设计面板是工作区级的、不进会话记忆，开着时目标会话又没记过别的面板，就留着它。
 * 目标会话记着别的面板（文件、审查……），照记忆换过去。
 */
export function keepDesignerAcrossSessions(current: RightPanelKind | null, recalled: RightPanelKind | null): RightPanelKind | null {
  // 编排面板同理：它是工作区级的全景，从树上点开一条会话不该把它收掉
  return (current === "galaxy" || current === "orchestra") && recalled === null ? current : recalled;
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

/**
 * 插件稿里主星 / 行星的故事只留第一句（2026-11-24 设计审查 R16：一段带破折号的抒情长句占了面板三行）：
 * 取第一个句号 / 问号 / 叹号之前的部分，破折号之后的展开不要；全文仍在悬停提示里。
 */
export function storyLineOf(note: string): string {
  const text = note.trim();
  const dash = text.indexOf("——");
  const head = dash > 0 ? text.slice(0, dash) : text;
  const end = head.search(/[。！？.!?]/);
  return (end > 0 ? head.slice(0, end + 1) : head).trim();
}
