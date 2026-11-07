/**
 * 演示文稿的主题：调色板 + 字体 + 字号阶梯，整份 deck 一套。
 *
 * 元素上的颜色 / 字号 / 字体可以写成 `$token`（如 `"$accent"`、`"$title"`、`"$heading"`）：
 * 规整时（normalizeElement）解析成**具体值**落盘，同时在元素的 `bind` 里记下「这一项跟着主题走」；
 * 换主题（applyTheme）只重算 bind 里记着的项。用户手动改过的项会被拆掉绑定（见 slides-ops 的 unbindChanged），
 * 所以换主题时手改的值保持不变——渲染层、导出层因此只看具体值，不需要认识 token。
 *
 * 无 DOM、无 node 依赖；不 import slides.ts（slides.ts 反过来 import 这里）。
 * 内置 6 套主题的取色与字号阶梯参照 reveal.js settings.scss 的 token 表（MIT）与 presenton template.json
 * 的 theme.colors（Apache-2.0）的组织方式：一套模板 = 字体 + 色板 + 版式，色板里有 background / card / stroke 这几个角色。
 */

export type PaletteKey = "bg" | "surface" | "ink" | "muted" | "accent" | "accent2";
export type ThemePalette = Record<PaletteKey, string>;
export type ScaleKey = "display" | "title" | "h2" | "body" | "caption";
export type ThemeScale = Record<ScaleKey, number>;
export interface ThemeFonts {
  heading: string;
  body: string;
}
/** 装饰母题：封面 / 章节 / 结尾页的构图（圆、色块、横带），让六套主题不只是换色 */
export type ThemeMotif = "circle" | "block" | "band";

export interface DeckTheme {
  /** 内置主题 id（forest / ink / mono / academic / warm / night）；改过色板后仍保留来源 id */
  id?: string;
  /** 旧字段：没有色板的老文稿只有这三项；有色板时 = body 字体 / ink / bg，给不认识色板的渲染路径兜底 */
  fontFamily?: string;
  color?: string;
  background?: string;
  palette?: ThemePalette;
  fonts?: ThemeFonts;
  scale?: ThemeScale;
  motif?: ThemeMotif;
  /** 标题是否加粗（无衬线主题加粗，衬线主题常规字重） */
  headingBold?: boolean;
  /** 页脚「标题 · 页码」；false = 整份都不画 */
  footer?: boolean;
}

export const PALETTE_KEYS: readonly PaletteKey[] = ["bg", "surface", "ink", "muted", "accent", "accent2"];
export const SCALE_KEYS: readonly ScaleKey[] = ["display", "title", "h2", "body", "caption"];
/** 派生色：由色板算出，不能在主题里单独写 */
export const DERIVED_COLORS = ["onAccent", "onAccent2", "line"] as const;
export type ColorToken = PaletteKey | (typeof DERIVED_COLORS)[number];
export const COLOR_TOKENS: readonly ColorToken[] = [...PALETTE_KEYS, ...DERIVED_COLORS];
export const FONT_TOKENS = ["heading", "body"] as const;
export type FontToken = (typeof FONT_TOKENS)[number];

/** 能写 `$token` 的元素字段，及各自认哪一类 token */
export const BINDABLE_FIELDS = {
  color: "color",
  fill: "color",
  stroke: "color",
  headerFill: "color",
  headerColor: "color",
  borderColor: "color",
  fontSize: "size",
  fontFamily: "font",
} as const;
export type BindField = keyof typeof BINDABLE_FIELDS;
export type BindKind = (typeof BINDABLE_FIELDS)[BindField];
export type ElementBindings = Partial<Record<BindField, string>>;

// 字体栈：拉丁字形放前面、CJK 字形落到后面的宋体 / 黑体（浏览器按字符逐个回退）。每条 ≤120 字符（safeFontFamily 的闸）
// Charter（macOS）/ Cambria（Windows）的数字是等高的；Georgia 的老式数字（6 沉底）放大做统计数字很怪
export const FONT_SERIF = 'Charter, Cambria, Georgia, "Songti SC", "Noto Serif SC", SimSun, serif';
export const FONT_SANS = '"Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

const palette = (bg: string, surface: string, ink: string, muted: string, accent: string, accent2: string): ThemePalette => ({ bg, surface, ink, muted, accent, accent2 });

export const THEME_PRESETS: Readonly<Record<string, DeckTheme>> = {
  // 深绿 + 橙：Claude Slides 截图的那种暗底大色块
  forest: {
    id: "forest",
    palette: palette("#14372e", "#1d4a3e", "#f4efe4", "#a9bdb2", "#e8833a", "#f2c14e"),
    fonts: { heading: FONT_SERIF, body: FONT_SANS },
    scale: { display: 84, title: 52, h2: 36, body: 28, caption: 18 },
    motif: "circle",
    headingBold: false,
  },
  // 浅米 + 墨：书页感，砖红点缀
  ink: {
    id: "ink",
    palette: palette("#f5f1ea", "#e9e3d7", "#1d1b18", "#6f685e", "#b4472a", "#2f5d62"),
    fonts: { heading: FONT_SERIF, body: FONT_SANS },
    scale: { display: 80, title: 50, h2: 34, body: 28, caption: 18 },
    motif: "band",
    headingBold: false,
  },
  // 黑白高对比：无衬线粗标题，红色只做点睛
  mono: {
    id: "mono",
    palette: palette("#ffffff", "#efefef", "#0a0a0a", "#555555", "#0a0a0a", "#e5251b"),
    fonts: { heading: FONT_SANS, body: FONT_SANS },
    scale: { display: 92, title: 54, h2: 36, body: 28, caption: 18 },
    motif: "block",
    headingBold: true,
  },
  // 学术蓝灰：冷静、信息密度高
  academic: {
    id: "academic",
    palette: palette("#f7f8fa", "#e4e9f0", "#1c2733", "#5d6b7b", "#2a4d8f", "#c08a2e"),
    fonts: { heading: FONT_SERIF, body: FONT_SANS },
    scale: { display: 76, title: 48, h2: 34, body: 26, caption: 17 },
    motif: "band",
    headingBold: false,
  },
  // 暖纸：奶油底，焦糖与酒红
  warm: {
    id: "warm",
    palette: palette("#fbf3e4", "#f1e1c5", "#3b2a1e", "#85705a", "#d9822b", "#a23e48"),
    fonts: { heading: FONT_SERIF, body: FONT_SANS },
    scale: { display: 80, title: 52, h2: 36, body: 28, caption: 18 },
    motif: "circle",
    headingBold: false,
  },
  // 夜空：深蓝底，暖黄做主操作色（对应应用暗主题的黄）
  night: {
    id: "night",
    palette: palette("#0f1729", "#19233d", "#e9eefb", "#8c9ac0", "#ffc857", "#5ea3ff"),
    fonts: { heading: FONT_SANS, body: FONT_SANS },
    scale: { display: 88, title: 54, h2: 36, body: 28, caption: 18 },
    motif: "block",
    headingBold: true,
  },
};

export const THEME_IDS: readonly string[] = Object.keys(THEME_PRESETS);
export const DEFAULT_THEME_ID = "ink";

/** 给界面与工具描述用的一句话（agent 按主题气质挑） */
export const THEME_BLURBS: Readonly<Record<string, { zh: string; en: string }>> = {
  forest: { zh: "深林", en: "deep green with orange — bold, editorial, great for keynotes and culture / travel topics" },
  ink: { zh: "纸墨", en: "warm off-white with ink black and terracotta — calm, book-like, safe default for reports and essays" },
  mono: { zh: "黑白", en: "pure white, black type, red accent — maximum contrast, for pitches, design and tech talks" },
  academic: { zh: "学术", en: "cool blue-grey with serif headings — papers, lectures, data-heavy talks" },
  warm: { zh: "暖纸", en: "cream paper with caramel and wine — food, lifestyle, storytelling, education" },
  night: { zh: "夜空", en: "midnight blue with warm yellow — product launches, tech, evening talks" },
};

export function presetTheme(id: string): DeckTheme | undefined {
  const preset = THEME_PRESETS[id];
  return preset === undefined ? undefined : withLegacyFields(preset);
}

/** 色板在手时，顺手把旧字段（fontFamily / color / background）补齐，旧渲染路径不用改 */
export function withLegacyFields(theme: DeckTheme): DeckTheme {
  if (theme.palette === undefined) return theme;
  return {
    ...theme,
    background: theme.palette.bg,
    color: theme.palette.ink,
    ...(theme.fonts === undefined ? {} : { fontFamily: theme.fonts.body }),
  };
}

// ─── 颜色运算（相对亮度 / 对比度 / 混色），只认 #rgb / #rrggbb ──────────────────

function parseHex(color: string): [number, number, number] | null {
  const text = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short !== null) return [parseInt((short[1] as string) + (short[1] as string), 16), parseInt((short[2] as string) + (short[2] as string), 16), parseInt((short[3] as string) + (short[3] as string), 16)];
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(text);
  if (full === null) return null;
  return [parseInt(full[1] as string, 16), parseInt(full[2] as string, 16), parseInt(full[3] as string, 16)];
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 相对亮度；认不出的颜色当中灰 */
export function luminance(color: string): number {
  const rgb = parseHex(color);
  if (rgb === null) return 0.4;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** a 占 weight（0–1），b 占 1 - weight */
export function mixColors(a: string, b: string, weight: number): string {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (ra === null || rb === null) return a;
  return toHex([ra[0] * weight + rb[0] * (1 - weight), ra[1] * weight + rb[1] * (1 - weight), ra[2] * weight + rb[2] * (1 - weight)]);
}

// ─── token 解析 ─────────────────────────────────────────────────────────

export interface ResolvedTheme {
  palette: ThemePalette;
  fonts: ThemeFonts;
  scale: ThemeScale;
  motif: ThemeMotif;
  headingBold: boolean;
  footer: boolean;
  colors: Record<ColorToken, string>;
}

/**
 * 任意 DeckTheme（含 undefined、只有旧三字段的老文稿）→ 全量解析结果。
 * 缺的项从默认主题（ink）补；老文稿的 color / background / fontFamily 覆盖 ink 的对应项，
 * 所以对老文稿写 `$ink` 得到的是它自己的字色，不是我们的默认米色。
 */
export function resolveTheme(theme: DeckTheme | undefined): ResolvedTheme {
  const base = THEME_PRESETS[theme?.id ?? DEFAULT_THEME_ID] ?? (THEME_PRESETS[DEFAULT_THEME_ID] as DeckTheme);
  const basePalette = base.palette as ThemePalette;
  const baseFonts = base.fonts as ThemeFonts;
  const pal: ThemePalette = { ...basePalette, ...(theme?.palette ?? {}) };
  if (theme?.palette === undefined) {
    if (theme?.background !== undefined) pal.bg = theme.background;
    if (theme?.color !== undefined) pal.ink = theme.color;
  }
  const fonts: ThemeFonts = { ...baseFonts, ...(theme?.fonts ?? {}) };
  if (theme?.fonts === undefined && theme?.fontFamily !== undefined) fonts.body = theme.fontFamily;
  const scale: ThemeScale = { ...(base.scale as ThemeScale), ...(theme?.scale ?? {}) };
  const pickOn = (fill: string): string => (contrastRatio(fill, pal.bg) >= contrastRatio(fill, pal.ink) ? pal.bg : pal.ink);
  const colors: Record<ColorToken, string> = {
    ...pal,
    onAccent: pickOn(pal.accent),
    onAccent2: pickOn(pal.accent2),
    line: mixColors(pal.ink, pal.bg, 0.18),
  };
  return {
    palette: pal,
    fonts,
    scale,
    motif: theme?.motif ?? base.motif ?? "circle",
    headingBold: theme?.headingBold ?? base.headingBold ?? false,
    footer: theme?.footer !== false,
    colors,
  };
}

export function isColorToken(name: string): name is ColorToken {
  return (COLOR_TOKENS as readonly string[]).includes(name);
}
export function isScaleKey(name: string): name is ScaleKey {
  return (SCALE_KEYS as readonly string[]).includes(name);
}
export function isFontToken(name: string): name is FontToken {
  return (FONT_TOKENS as readonly string[]).includes(name);
}

/** token 名对某个字段是否合法 */
export function tokenFitsField(field: BindField, name: string): boolean {
  switch (BINDABLE_FIELDS[field]) {
    case "color":
      return isColorToken(name);
    case "size":
      return isScaleKey(name);
    case "font":
      return isFontToken(name);
  }
}

/** token 在给定主题里的具体值；名字不合法返回 undefined */
export function tokenValue(theme: ResolvedTheme, field: BindField, name: string): string | number | undefined {
  if (!tokenFitsField(field, name)) return undefined;
  switch (BINDABLE_FIELDS[field]) {
    case "color":
      return theme.colors[name as ColorToken];
    case "size":
      return theme.scale[name as ScaleKey];
    case "font":
      return theme.fonts[name as FontToken];
  }
}

/** 元素 / 页背景里的字符串是否写成了 `$token` */
export function tokenName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\$([A-Za-z][A-Za-z0-9]{0,15})$/.exec(value.trim());
  return match === null ? null : (match[1] as string);
}
