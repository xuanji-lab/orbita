import { DENSITY, type Composition } from "../chat/galaxy.ts";
import type { MixBasis, MixScope, PlanetMix, PlanetMixItem } from "@shared/planet-design";
import { ELEMENT_BY_SYMBOL } from "./elements.ts";

/**
 * 行星元素构成的纯内核（星系设计面板「成分」一节）：默认放哪一层、旧稿怎么映射、留空项怎么按种子随机、
 * 滑块怎么在同一组里联动、密度与颜色提示怎么从构成里推出来。组件只画这里算出的东西。
 *
 * 数值可以编造，但单位是真的：比例是质量分数 / 体积分数，密度是 g/cm³（与读数里的「密度」同一个数）。
 */

export type MixGroupKey = `${MixScope}|${MixBasis}`;

export function groupKey(item: Pick<PlanetMixItem, "scope" | "basis">): MixGroupKey {
  return `${item.scope}|${item.basis}`;
}

/** 组的固定顺序：整体·质量（定密度）在前，然后大气、表面 */
export const GROUP_ORDER: readonly MixGroupKey[] = [
  "bulk|mass_fraction",
  "bulk|volume_fraction",
  "atmosphere|volume_fraction",
  "atmosphere|mass_fraction",
  "surface|volume_fraction",
  "surface|mass_fraction",
];

// ── 默认放法 ───────────────────────────────────────────────────────────

/**
 * 新加一个元素时放哪一层、按什么口径（界面上标「默认」）：
 * - 惰性气体只待在气体里 → 大气 · 体积；
 * - 气态行星上的氢、碳、氮、氧（气体与挥发物）→ 大气 · 体积（需求清单：气态默认「大气 · 体积」）；
 * - 其余 → 整体 · 质量（岩质默认「整体 · 质量」，它定密度）。
 */
export function defaultPlacement(symbol: string, cls: Composition): { scope: MixScope; basis: MixBasis } {
  const info = ELEMENT_BY_SYMBOL.get(symbol);
  if (info?.reservoir === "noble") return { scope: "atmosphere", basis: "volume_fraction" };
  if (cls === "gas" && (symbol === "H" || info?.reservoir === "volatile" || info?.reservoir === "oxygen")) {
    return { scope: "atmosphere", basis: "volume_fraction" };
  }
  return { scope: "bulk", basis: "mass_fraction" };
}

/**
 * 旧稿（只有岩石 / 冰质 / 气态）映射成的整体质量分数。数值是示意（地球、冰卫星、木星的量级），
 * 与下面的储库密度一起标定：三组各自推出来的密度与旧的 5.5 / 2 / 1.3 g/cm³ 相差 < 0.5%（见测试），旧稿的大小不变。
 */
export const LEGACY_PRESETS: Readonly<Record<Composition, readonly (readonly [string, number])[]>> = {
  rock: [["Fe", 0.32], ["O", 0.3], ["Si", 0.15], ["Mg", 0.14], ["S", 0.03], ["Ni", 0.02], ["Ca", 0.02], ["Al", 0.02]],
  ice: [["O", 0.55], ["Fe", 0.13], ["Si", 0.1], ["Mg", 0.09], ["H", 0.06], ["C", 0.05], ["N", 0.02]],
  gas: [["H", 0.74], ["He", 0.24], ["C", 0.01], ["O", 0.01]],
};

/** 种子：没有就按行星 id 起一个（同一颗永远同一个） */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function legacyMix(cls: Composition, seed: number): PlanetMix {
  return {
    seed,
    items: LEGACY_PRESETS[cls].map(([id, share]) => ({ id, kind: "element", scope: "bulk", basis: "mass_fraction", share, origin: "default" })),
  };
}

// ── 按种子补留空项 ─────────────────────────────────────────────────────

/** mulberry32：小而确定，同一个种子同一串数 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 值的来源（界面上的标签）：你定的 / 默认 / 随机 */
export type ShareSource = "user" | "default" | "random";

export interface ResolvedItem extends PlanetMixItem {
  /** 在 items 里的下标 */
  index: number;
  /** 实际用的比例（0–1）：留空项是按种子分到的 */
  value: number;
  source: ShareSource;
}

export interface MixGroup {
  key: MixGroupKey;
  scope: MixScope;
  basis: MixBasis;
  items: ResolvedItem[];
  /** 定了数（含 0）的合计 */
  setTotal: number;
  /** 没分出去的部分（没有留空项时才有）：界面上画成「其余」 */
  rest: number;
}

/**
 * 把构成解析成实际比例：每组里定了数的照用（合计超过 1 的旧数据按比例压回 1）；留空项按种子把剩下的分掉
 * （每项拿 0.2–1 的随机权重）；没有留空项时剩下的记为「其余」。同一份构成 + 同一个种子永远同一个结果。
 */
export function resolveMix(mix: PlanetMix): { items: ResolvedItem[]; groups: MixGroup[] } {
  const byKey = new Map<MixGroupKey, PlanetMixItem[]>();
  mix.items.forEach((item) => {
    const key = groupKey(item);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  });
  const resolved: ResolvedItem[] = mix.items.map((item, index) => ({ ...item, index, value: 0, source: item.share === null ? "random" : item.origin }));
  const groups: MixGroup[] = [];
  const keys = [...GROUP_ORDER.filter((key) => byKey.has(key)), ...[...byKey.keys()].filter((key) => !GROUP_ORDER.includes(key))];
  for (const key of keys) {
    const members = resolved.filter((item) => groupKey(item) === key);
    const setSum = members.reduce((sum, item) => sum + (item.share ?? 0), 0);
    const squeeze = setSum > 1 ? 1 / setSum : 1;
    for (const item of members) if (item.share !== null) item.value = item.share * squeeze;
    const blanks = members.filter((item) => item.share === null);
    const remaining = Math.max(0, 1 - setSum * squeeze);
    if (blanks.length > 0) {
      const draw = rng(mix.seed ^ seedOf(key));
      const weights = blanks.map(() => 0.2 + 0.8 * draw());
      const total = weights.reduce((sum, w) => sum + w, 0);
      blanks.forEach((item, i) => {
        item.value = (remaining * (weights[i] ?? 0)) / total;
      });
    }
    const [scope, basis] = key.split("|") as [MixScope, MixBasis];
    groups.push({ key, scope, basis, items: members, setTotal: Math.min(1, setSum * squeeze), rest: blanks.length > 0 ? 0 : remaining });
  }
  return { items: resolved, groups };
}

// ── 编辑：联动、留空、增删、换层、换种子 ───────────────────────────────

/**
 * 拖第 index 项到 value（0–1）：这一项变「你定的」；同组其他定了数的项合计超出 1 - value 时按比例一起让，
 * 别的组不动（只在同一层同一口径里联动）。留空项不动——它们分剩下的。
 */
export function setShare(mix: PlanetMix, index: number, value: number): PlanetMix {
  const target = mix.items[index];
  if (target === undefined) return mix;
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const key = groupKey(target);
  const others = mix.items.filter((item, i) => i !== index && groupKey(item) === key && item.share !== null);
  const othersSum = others.reduce((sum, item) => sum + (item.share ?? 0), 0);
  const room = 1 - v;
  const scale = othersSum > room && othersSum > 0 ? room / othersSum : 1;
  return {
    ...mix,
    items: mix.items.map((item, i) => {
      if (i === index) return { ...item, share: v, origin: "user" };
      if (scale !== 1 && groupKey(item) === key && item.share !== null) return { ...item, share: item.share * scale };
      return item;
    }),
  };
}

/** 留空：交给种子随机（不是 0%） */
export function clearShare(mix: PlanetMix, index: number): PlanetMix {
  return { ...mix, items: mix.items.map((item, i) => (i === index ? { ...item, share: null, origin: "default" } : item)) };
}

/** 周期表上点一下：没有就按默认放法加一条（留空），有就把这个元素的条目都拿掉 */
export function toggleElement(mix: PlanetMix, symbol: string, cls: Composition, max: number): PlanetMix {
  if (mix.items.some((item) => item.id === symbol)) return { ...mix, items: mix.items.filter((item) => item.id !== symbol) };
  if (mix.items.length >= max || !ELEMENT_BY_SYMBOL.has(symbol)) return mix;
  const place = defaultPlacement(symbol, cls);
  return { ...mix, items: [...mix.items, { id: symbol, kind: "element", ...place, share: null, origin: "default" }] };
}

export function removeItem(mix: PlanetMix, index: number): PlanetMix {
  return { ...mix, items: mix.items.filter((_, i) => i !== index) };
}

/** 换层 / 口径（用户挑的，标 placed）；目标组里已有同一元素时不换 */
export function placeItem(mix: PlanetMix, index: number, scope: MixScope, basis: MixBasis): PlanetMix {
  const target = mix.items[index];
  if (target === undefined) return mix;
  if (mix.items.some((item, i) => i !== index && item.id === target.id && item.scope === scope && item.basis === basis)) return mix;
  return { ...mix, items: mix.items.map((item, i) => (i === index ? { ...item, scope, basis, placed: true } : item)) };
}

/** 「换一版」：只换种子，留空项重新随机，定了数的不动 */
export function reseed(mix: PlanetMix, previous: number = mix.seed): PlanetMix {
  return { ...mix, seed: (Math.imul(previous ^ 0x9e3779b9, 2654435761) >>> 0) % 100000000 };
}

// ── 推算：储库 → 密度 ─────────────────────────────────────────────────

/**
 * 「储库」近似：只看整体 · 质量分数这一组（它才是这颗星的质量构成）。
 * 铁、镍、硫（FeS）等进金属核；镁、硅、铝、钙等与氧结合成硅酸盐（氧按 MgSiO₃ 的比例 0.92 倍先配给它们）；
 * 多下的氧、碳、氮和最多 1/8 氧量的氢（H₂O）成冰；其余的氢和惰性气体是气体。
 * 每个储库取一个压缩后的等效密度（g/cm³，示意值，与 LEGACY_PRESETS 一起标定），按质量调和平均：1/ρ = Σ wₖ / ρₖ。
 */
export const RESERVOIR_DENSITY = { metal: 10.48, silicate: 4.3, ice: 1.253, gas: 1.301 } as const;
export type ReservoirKey = keyof typeof RESERVOIR_DENSITY;
const O_PER_ROCK = 0.92;

export interface MixPhysics {
  /** g/cm³ */
  density: number;
  /** 各储库的质量分数（合计 1） */
  reservoirs: Record<ReservoirKey, number>;
}

export function mixPhysics(mix: PlanetMix): MixPhysics | null {
  const group = resolveMix(mix).groups.find((g) => g.key === "bulk|mass_fraction");
  if (group === undefined) return null;
  const total = group.items.reduce((sum, item) => sum + item.value, 0);
  if (!(total > 0)) return null;
  const mass = { metal: 0, rock: 0, oxygen: 0, hydrogen: 0, volatile: 0, noble: 0 };
  for (const item of group.items) {
    const w = item.value / total;
    if (item.id === "H") mass.hydrogen += w;
    else {
      const reservoir = ELEMENT_BY_SYMBOL.get(item.id)?.reservoir ?? "rock";
      mass[reservoir] += w;
    }
  }
  const oRock = Math.min(mass.oxygen, O_PER_ROCK * mass.rock);
  const oLeft = mass.oxygen - oRock;
  const hIce = Math.min(mass.hydrogen, oLeft / 8);
  const reservoirs = {
    metal: mass.metal,
    silicate: mass.rock + oRock,
    ice: oLeft + hIce + mass.volatile,
    gas: mass.hydrogen - hIce + mass.noble,
  };
  let inverse = 0;
  for (const key of Object.keys(reservoirs) as ReservoirKey[]) inverse += reservoirs[key] / RESERVOIR_DENSITY[key];
  return { density: 1 / inverse, reservoirs };
}

/** 按密度归成三类（纹理、星系里的老读者用）：与 shared 的 compositionFromDensity 同一组门槛（g/cm³） */
export function classOfDensity(density: number): Composition {
  if (density < 1.8) return "gas";
  if (density < 3) return "ice";
  return "rock";
}

/** 行星的密度：有构成按构成推，没有（或没有整体·质量这一组）按成分类别 */
export function planetDensity(planet: { composition: Composition; mix?: PlanetMix | null }): number {
  const physics = planet.mix === undefined || planet.mix === null ? null : mixPhysics(planet.mix);
  return physics?.density ?? DENSITY[planet.composition];
}

// ── 推算：颜色提示 ─────────────────────────────────────────────────────

/** 表面最显色，大气其次，整体（埋在里面）只带一点 */
const SCOPE_WEIGHT: Readonly<Record<MixScope, number>> = { surface: 1, atmosphere: 0.7, bulk: 0.25 };

export interface ColorHint {
  l: number;
  c: number;
  h: number;
}

/** 按比例 × 层权重在 OKLab 里平均各元素的颜色提示；没有构成为 null */
export function mixColor(mix: PlanetMix): ColorHint | null {
  let wSum = 0;
  let L = 0;
  let a = 0;
  let b = 0;
  for (const item of resolveMix(mix).items) {
    const info = ELEMENT_BY_SYMBOL.get(item.id);
    if (info === undefined) continue;
    const w = item.value * SCOPE_WEIGHT[item.scope];
    if (!(w > 0)) continue;
    const rad = (info.hint.h * Math.PI) / 180;
    L += w * info.hint.l;
    a += w * info.hint.c * Math.cos(rad);
    b += w * info.hint.c * Math.sin(rad);
    wSum += w;
  }
  if (!(wSum > 0)) return null;
  const c = Math.hypot(a, b) / wSum;
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l: L / wSum, c, h };
}

export type ColorName = "pale" | "gray" | "dark" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "violet" | "magenta";

/** 颜色提示的名字（读数里写给人看的） */
export function colorNameOf(hint: ColorHint): ColorName {
  if (hint.c < 0.025) return hint.l > 0.72 ? "pale" : hint.l < 0.45 ? "dark" : "gray";
  const h = hint.h;
  if (h < 50 || h >= 350) return "red";
  if (h < 75) return "orange";
  if (h < 110) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 275) return "blue";
  if (h < 320) return "violet";
  return "magenta";
}

/** CSS 颜色（给天体底色混色用）：数据驱动的颜色，不是界面配色 */
export function cssColorOf(hint: ColorHint): string {
  return `oklch(${hint.l.toFixed(3)} ${Math.min(hint.c, 0.2).toFixed(3)} ${hint.h.toFixed(1)})`;
}
