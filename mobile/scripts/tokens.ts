/**
 * 设计系统 token（design-system/tokens/*.css）→ React Native 能用的值。
 *
 * RN 没有 CSS 变量，主题只能是一份 JS 对象；这份对象**由 CSS 真源生成**，不手抄：
 * - 颜色：按主题块（`:root` = 浅色，`[data-theme="black"]` = 玄，`[data-theme="graphite"]` = 黛）
 *   取声明，`var(--x)` 先在本主题里找、找不到落回浅色；`color-mix(in srgb, X p%, transparent)`
 *   换成 X 的 rgba（透明度 p%）。
 * - 尺寸：`--space-*`、`--radius*`、`--control-height-*`、`--font-size-*`、`--weight-*`、
 *   `--line-height-*` 等，`calc(a ± b)` 与 `rem` 算成 px 数字。同名后声明的覆盖先声明的（CSS 的级联）。
 *
 * 只认这几种写法；遇到别的写法直接抛错——宁可生成失败，也不悄悄生成一个错值。
 * 纯函数，`gen-theme.ts` 写文件、`gen-theme.test.ts` 核对已提交的文件没过期。
 */

export type ThemeId = "light" | "graphite" | "black";

const THEME_SELECTORS: Readonly<Record<ThemeId, RegExp>> = {
  light: /^:root,\s*\[data-theme-preview="light"\]$/,
  graphite: /^:root\[data-theme="graphite"\],\s*\[data-theme-preview="graphite"\]$/,
  black: /^:root\[data-theme="black"\],\s*\[data-theme-preview="black"\]$/,
};

interface Block {
  selector: string;
  decls: [string, string][];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 只解析顶层的「选择器 { 声明 }」；@media 之类的嵌套块整块跳过 */
export function parseBlocks(css: string): Block[] {
  const text = stripComments(css);
  const blocks: Block[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const selector = text.slice(i, open).trim();
    // 找配对的右括号（跳过嵌套）
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (!body.includes("{")) {
      const decls: [string, string][] = [];
      for (const part of body.split(";")) {
        const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
        if (match !== null && match[1] !== undefined && match[2] !== undefined) decls.push([match[1], match[2].replace(/\s+/g, " ")]);
      }
      blocks.push({ selector: selector.replace(/\s+/g, " "), decls });
    }
    i = j;
  }
  return blocks;
}

// ————————————————————————————————————————————————————————————————
// 颜色
// ————————————————————————————————————————————————————————————————

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHex(text: string): Rgba | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (match === null || match[1] === undefined) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: 1,
  };
}

function parseRgba(text: string): Rgba | null {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (match === null) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

function formatColor(color: Rgba): string {
  if (color.a >= 1) return `#${[color.r, color.g, color.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  const alpha = Math.round(color.a * 1000) / 1000;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

type Lookup = (name: string) => string | undefined;

function resolveColor(value: string, lookup: Lookup, seen: readonly string[] = []): Rgba {
  const text = value.trim();
  const hex = parseHex(text) ?? parseRgba(text);
  if (hex !== null) return hex;
  const ref = /^var\((--[\w-]+)\)$/.exec(text);
  if (ref !== null && ref[1] !== undefined) {
    const name = ref[1];
    if (seen.includes(name)) throw new Error(`token cycle: ${[...seen, name].join(" → ")}`);
    const next = lookup(name);
    if (next === undefined) throw new Error(`undefined token ${name}`);
    return resolveColor(next, lookup, [...seen, name]);
  }
  const mix = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, transparent\)$/.exec(text);
  if (mix !== null && mix[1] !== undefined && mix[2] !== undefined) {
    const base = resolveColor(mix[1], lookup, seen);
    return { ...base, a: base.a * (Number(mix[2]) / 100) };
  }
  throw new Error(`unsupported colour value: ${text}`);
}

/** 这些 token 不是颜色（或手机用不上的颜色派生），跳过 */
const NOT_A_COLOR = /^--(color-scheme)$/;

/** glass.css 的主题块（选择器比 colors.css 的短：没有预览卡那一半） */
const GLASS_SELECTORS: Readonly<Record<ThemeId, string>> = {
  light: ":root",
  graphite: ':root[data-theme="graphite"]',
  black: ':root[data-theme="black"]',
};
/** glass.css 里手机要的两项（卡面与它的发丝线）；`--glass-alpha` 不是颜色 */
const GLASS_NAMES = ["--glass-bg", "--glass-border"];

export function themeColors(colorsCss: string, glassCss = ""): Record<ThemeId, Record<string, string>> {
  const blocks = parseBlocks(colorsCss);
  const glassBlocks = parseBlocks(glassCss);
  const declsOf = (id: ThemeId): Map<string, string> => {
    const block = blocks.find((item) => THEME_SELECTORS[id].test(item.selector));
    if (block === undefined) throw new Error(`theme block not found: ${id}`);
    return new Map(block.decls);
  };
  const light = declsOf("light");
  const out = {} as Record<ThemeId, Record<string, string>>;
  for (const id of ["light", "graphite", "black"] as const) {
    const own = id === "light" ? light : declsOf(id);
    const glass = new Map(glassBlocks.find((block) => block.selector === GLASS_SELECTORS[id])?.decls ?? []);
    const lookup: Lookup = (name) => own.get(name) ?? light.get(name);
    const colors: Record<string, string> = {};
    for (const name of GLASS_NAMES) {
      const value = glass.get(name);
      if (value !== undefined) colors[camel(name.slice(2))] = formatColor(resolveColor(value, lookup));
    }
    // 每个主题都给齐浅色有的那些名字（暗档没声明的沿用浅色的值，和 CSS 级联一样）
    const names = [...new Set([...light.keys(), ...own.keys()])].filter((name) => name.startsWith("--color-") && !NOT_A_COLOR.test(name));
    for (const name of names.sort()) {
      const value = lookup(name);
      if (value === undefined) continue;
      colors[camel(name.slice("--color-".length))] = formatColor(resolveColor(value, lookup));
    }
    out[id] = colors;
  }
  return out;
}

// ————————————————————————————————————————————————————————————————
// 尺寸
// ————————————————————————————————————————————————————————————————

const ROOT_FONT_PX = 16;

function resolveLength(value: string, lookup: Lookup, seen: readonly string[] = []): number {
  const text = value.trim();
  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(text);
  if (px !== null) return Number(px[1]);
  const rem = /^(-?\d+(?:\.\d+)?)rem$/.exec(text);
  if (rem !== null) return Number(rem[1]) * ROOT_FONT_PX;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const ref = /^var\((--[\w-]+)\)$/.exec(text);
  if (ref !== null && ref[1] !== undefined) {
    const name = ref[1];
    if (seen.includes(name)) throw new Error(`token cycle: ${name}`);
    const next = lookup(name);
    if (next === undefined) throw new Error(`undefined token ${name}`);
    return resolveLength(next, lookup, [...seen, name]);
  }
  const calc = /^calc\((.+) ([+-]) (.+)\)$/.exec(text);
  if (calc !== null && calc[1] !== undefined && calc[3] !== undefined) {
    const a = resolveLength(calc[1], lookup, seen);
    const b = resolveLength(calc[3], lookup, seen);
    return calc[2] === "+" ? a + b : a - b;
  }
  throw new Error(`unsupported length value: ${text}`);
}

/** 手机要的尺寸 token（按前缀挑）；其余（桌面的标题栏、索引边栏…）不进 */
const METRIC_PREFIXES = ["--space-", "--radius", "--control-height-", "--font-size-", "--weight-", "--line-height-", "--ui-font-size"];
const SKIP_METRICS = new Set(["--font-size-terminal", "--line-height-terminal", "--font-size-titlebar", "--font-size-wordmark"]);

export function metrics(cssFiles: readonly string[]): Record<string, number> {
  const decls = new Map<string, string>();
  for (const css of cssFiles) {
    for (const block of parseBlocks(css)) {
      // 尺寸只在 :root 上声明；主题块里的颜色不碰
      if (block.selector !== ":root") continue;
      for (const [name, value] of block.decls) decls.set(name, value);
    }
  }
  const lookup: Lookup = (name) => decls.get(name);
  const out: Record<string, number> = {};
  for (const name of [...decls.keys()].sort()) {
    if (!METRIC_PREFIXES.some((prefix) => name.startsWith(prefix)) || SKIP_METRICS.has(name)) continue;
    const value = decls.get(name);
    if (value === undefined) continue;
    out[camel(name.slice(2))] = resolveLength(value, lookup);
  }
  return out;
}

/** `space-0-5` → `space0_5`（数字之间的连字符写成下划线，免得 1-5 读成 15），其余转驼峰 */
function camel(name: string): string {
  return name.replace(/(\d)-(\d)/g, "$1_$2").replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/** 生成的 TS 文件全文（确定性：键排好序） */
export function renderTokensModule(input: { colors: Record<ThemeId, Record<string, string>>; metrics: Record<string, number> }): string {
  const lines = [
    "// 由 mobile/scripts/gen-theme.ts 从 design-system/tokens/*.css 生成，**不要手改**。",
    "// 设计系统改了 token：在 mobile/ 下跑 `bun run gen`，再提交；`scripts/gen-theme.test.ts` 会拦住过期的这份。",
    "",
    `export const COLORS = ${JSON.stringify(input.colors, null, 2)} as const;`,
    "",
    `export const METRICS = ${JSON.stringify(input.metrics, null, 2)} as const;`,
    "",
  ];
  return lines.join("\n");
}
