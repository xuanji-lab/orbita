/**
 * 版式（layout）：agent 只给内容（slots），这里把它落成**普通元素**（带 `$token` 的 text / shape / image / table / line）。
 * 落盘的仍是元素数组，用户照样能拖改；颜色 / 字号 / 字体全走主题 token，换主题整份跟着变。
 *
 * 为什么有这一层：此前 agent 只拿到「坐标 + 元素」的低层接口，每页都凭空排版——出来的是满屏纯色 + 居中两行小字。
 * 版式把「大标题、眉题、留白、色块与圆形做构图、一页一个意思」写死成十一种页型，agent 只负责选页型、填内容。
 *
 * 版式名与槽位的分法参照 Slidev（MIT）packages/client/layouts：cover / section / fact / quote / image-left / image-right /
 * two-cols / end；眉题的做法参照其 layouts-base.css 里的 h6（小字号、拉字距、降对比）；图文页用「半幅满高图 + 另一半文字」。
 * presenton（Apache-2.0）每个 layout 带一句话描述、由模型挑选——我们的工具描述同样按「什么时候用哪个版式」写。
 *
 * 文字量用 slides-measure 估算（无 DOM）：标题装不下就沿主题字号阶梯往下退（display → title → h2 → body，最多退到 body，
 * 不会比正文还小）；正文区装不下**不缩字**（正文不许小于主题 body），而是在警告里让 agent 拆页。
 */
import { CANVAS_SIZE, serializeRichText, type Aspect, type SlideFooter, type TextParagraph, type TextRun } from "./slides.ts";
import { estimateListHeight, estimateTextHeight, countLines, visualLength } from "./slides-measure.ts";
import { contrastRatio, luminance, resolveTheme, type DeckTheme, type ResolvedTheme, type ScaleKey } from "./slides-theme.ts";

export const LAYOUT_NAMES = ["cover", "section", "bullets", "two-column", "image-left", "image-right", "image-full", "table", "quote", "stat", "closing"] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

export function isLayoutName(value: unknown): value is LayoutName {
  return typeof value === "string" && (LAYOUT_NAMES as readonly string[]).includes(value);
}

/** 写给模型看的版式说明：什么时候用哪个、要哪些槽位（工具描述直接拼它） */
export const LAYOUT_GUIDE: Readonly<Record<LayoutName, string>> = {
  cover: "cover — the opening slide: eyebrow? (small label), title (≤16 chars), subtitle?, meta? (author · date). Big serif title on the left, colour-block / circles on the right. Use exactly once, first.",
  section: "section — chapter divider on a full colour block: number? (\"02\"), title, subtitle?. Use between groups of slides in decks of 7+ pages.",
  bullets: "bullets — the default content slide: eyebrow?, title, bullets (3–6 items, ≤20 chars each). One idea per slide.",
  "two-column": "two-column — comparison or two parallel lists: eyebrow?, title, columns:[{heading?, bullets? | body?}, {…}] (≤4 bullets per column).",
  "image-left": "image-left — picture on the left half, text on the right: eyebrow?, title, bullets? | body?, image (path, or \"attached\" for the picture the user sent in chat). Always use image-left/right (not free coordinates) when a slide has a picture plus text.",
  "image-right": "image-right — same as image-left, picture on the right half.",
  "image-full": "image-full — full-bleed picture with a caption card: eyebrow?, title, caption?, image. For a single striking photo.",
  table: "table — eyebrow?, title, rows (string[][], first row = header; ≤6 rows, ≤4 columns), note? (source / footnote).",
  quote: "quote — one big sentence: quote, source? (who said it), eyebrow?. For a key claim, a testimonial or a pull-quote.",
  stat: "stat — 1–3 big numbers: eyebrow?, title?, stats:[{value:\"3.5%\", label:\"GDP growth\", detail?}]. Value ≤6 chars.",
  closing: "closing — last slide on a dark block: title (\"谢谢\" / key takeaway), subtitle?, contact? (lines), eyebrow?.",
};

/** 每个版式认的槽位（多给的会警告并忽略） */
const SLOT_KEYS: Readonly<Record<LayoutName, readonly string[]>> = {
  cover: ["eyebrow", "title", "subtitle", "meta"],
  section: ["number", "eyebrow", "title", "subtitle"],
  bullets: ["eyebrow", "title", "bullets", "body"],
  "two-column": ["eyebrow", "title", "columns"],
  "image-left": ["eyebrow", "title", "bullets", "body", "image"],
  "image-right": ["eyebrow", "title", "bullets", "body", "image"],
  "image-full": ["eyebrow", "title", "caption", "image"],
  table: ["eyebrow", "title", "rows", "header", "note"],
  quote: ["eyebrow", "quote", "source"],
  stat: ["eyebrow", "title", "stats"],
  closing: ["eyebrow", "title", "subtitle", "contact"],
};

export class LayoutError extends Error {}

export interface LayoutImage {
  /** 已落进 assets 的相对路径 */
  src: string;
  width: number;
  height: number;
}

export interface LayoutInput {
  layout: LayoutName;
  slots: Record<string, unknown>;
  aspect: Aspect;
  theme: DeckTheme | undefined;
  /** 图片槽位 → 已落盘的图（工具层先把 "attached" / 路径解析并复制进 assets） */
  images?: Readonly<Record<string, LayoutImage | undefined>>;
}

export interface LayoutOutput {
  elements: Record<string, unknown>[];
  /** 页背景（`$token`） */
  background: string;
  footer: SlideFooter;
  warnings: string[];
}

// ─── 槽位取值 ───────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function strList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : undefined;
  if (raw === undefined) return undefined;
  const items = raw.map((item) => str(item)).filter((item): item is string => item !== undefined);
  return items.length === 0 ? undefined : items.map((item) => item.replace(/^\s*(?:[-*•·]|\d+[.)、])\s+/, ""));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `**加粗**` → 粗体段；其余原样（html 由 serializeRichText 转义） */
function runsOf(text: string, bold: boolean): TextRun[] {
  const runs: TextRun[] = [];
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (part === "") return;
    const strong = /^\*\*[^*]+\*\*$/.test(part);
    runs.push({ text: strong ? part.slice(2, -2) : part, ...(bold || strong ? { bold: true } : {}) });
  });
  return runs;
}

function plainOf(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function paragraphsHtml(lines: readonly string[], bold: boolean): string {
  const paragraphs: TextParagraph[] = lines.map((line) => ({ runs: runsOf(line, bold) }));
  return serializeRichText(paragraphs);
}

function listHtml(items: readonly string[]): string {
  const paragraphs: TextParagraph[] = items.map((item) => ({ runs: runsOf(item, false), list: "bullet" as const }));
  return serializeRichText(paragraphs);
}

// ─── 构建器 ─────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
type Align = "left" | "center" | "right";

interface TextSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  html: string;
  size: ScaleKey;
  color: string;
  font?: "heading" | "body";
  align?: Align;
  valign?: "top" | "middle" | "bottom";
  letterSpacing?: number;
  lineHeight?: number;
  paraGap?: number;
}

function textEl(spec: TextSpec): Raw {
  return {
    kind: "text",
    x: Math.round(spec.x),
    y: Math.round(spec.y),
    w: Math.round(spec.w),
    h: Math.max(Math.round(spec.h), 8),
    html: spec.html,
    fontSize: `$${spec.size}`,
    color: spec.color,
    ...(spec.font === "heading" ? { fontFamily: "$heading" } : {}),
    align: spec.align ?? "left",
    valign: spec.valign ?? "top",
    ...(spec.letterSpacing === undefined ? {} : { letterSpacing: spec.letterSpacing }),
    ...(spec.lineHeight === undefined ? {} : { lineHeight: spec.lineHeight }),
    ...(spec.paraGap === undefined ? {} : { paraGap: spec.paraGap }),
  };
}

function shapeEl(shape: "rect" | "ellipse" | "roundRect", x: number, y: number, w: number, h: number, fill: string): Raw {
  return { kind: "shape", shape, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), fill, stroke: "none", strokeWidth: 0 };
}

function lineEl(x: number, y: number, w: number, color: string, thickness: number): Raw {
  return { kind: "line", x: Math.round(x), y: Math.round(y), w: Math.round(w), h: 1, points: [[0, 0], [Math.round(w), 0]], startArrow: "none", endArrow: "none", stroke: color, strokeWidth: thickness, dash: false };
}

const LH_DISPLAY = 1.12;
const LH_BODY = 1.35;

interface Ctx {
  W: number;
  H: number;
  mx: number;
  cw: number;
  /** 正文区下沿（页脚之上） */
  bottom: number;
  rt: ResolvedTheme;
  warnings: string[];
  images: Readonly<Record<string, LayoutImage | undefined>>;
  scale: (key: ScaleKey) => number;
  /** 在给定底色上读得清的强调色 token */
  accentOn: (bg: string) => string;
}

function makeCtx(input: LayoutInput, warnings: string[]): Ctx {
  const { w: W, h: H } = CANVAS_SIZE[input.aspect];
  const rt = resolveTheme(input.theme);
  const mx = W >= 1200 ? 96 : 72;
  return {
    W,
    H,
    mx,
    cw: W - mx * 2,
    bottom: H - 100,
    rt,
    warnings,
    images: input.images ?? {},
    scale: (key) => rt.scale[key],
    accentOn: (bgRef) => {
      // bgRef 可以是 `$token` 或具体色
      const name = bgRef.startsWith("$") ? bgRef.slice(1) : null;
      const bg = name === null ? bgRef : ((rt.colors as Record<string, string>)[name] ?? rt.colors.bg);
      const ok = (color: string): boolean => contrastRatio(color, bg) >= 3.2;
      if (ok(rt.colors.accent)) return "$accent";
      if (ok(rt.colors.accent2)) return "$accent2";
      return contrastRatio(rt.colors.ink, bg) >= contrastRatio(rt.colors.bg, bg) ? "$ink" : "$bg";
    },
  };
}

interface Fitted {
  size: ScaleKey;
  height: number;
  lines: number;
  ok: boolean;
}

/**
 * 沿字号阶梯找第一个装得下的字号。ladder 从大到小；maxLines 限制行数（标题）；maxHeight 限制高度（正文，传 Infinity 不限）。
 * 都装不下 → 返回最后一档、ok=false（调用方记警告，让 agent 拆页 / 缩短）。
 */
function fitLadder(c: Ctx, plain: string, width: number, ladder: readonly ScaleKey[], limit: { maxLines?: number; maxHeight?: number }, lineHeight: number, bold: boolean): Fitted {
  let last: Fitted = { size: ladder[0] as ScaleKey, height: 0, lines: 0, ok: false };
  for (const size of ladder) {
    const fontSize = c.scale(size);
    const lines = countLines(plain, fontSize, width, { bold });
    const height = estimateTextHeight(plain, fontSize, width, { lineHeight, bold });
    last = { size, height, lines, ok: false };
    if ((limit.maxLines === undefined || lines <= limit.maxLines) && (limit.maxHeight === undefined || height <= limit.maxHeight)) {
      return { ...last, ok: true };
    }
  }
  return last;
}

/** 通用页头：眉题（或一小段强调色短横）+ 标题。返回元素与下一块内容的起点 y */
function pageHead(c: Ctx, x: number, w: number, slots: { eyebrow?: string; title: string }, label: string, bg: string): { elements: Raw[]; y: number } {
  const elements: Raw[] = [];
  const accent = c.accentOn(bg);
  if (slots.eyebrow !== undefined) {
    elements.push(
      textEl({ x, y: 60, w, h: 28, html: paragraphsHtml([slots.eyebrow], true), size: "caption", color: accent, letterSpacing: 3 }),
    );
  } else {
    elements.push(shapeEl("rect", x, 64, 56, 6, accent === "$accent2" ? "$accent2" : "$accent"));
  }
  const titleY = slots.eyebrow === undefined ? 92 : 100;
  const title = plainOf(slots.title);
  const fit = fitLadder(c, title, w, ["title", "h2"], { maxLines: 2 }, LH_DISPLAY, c.rt.headingBold);
  if (!fit.ok) c.warnings.push(`${label}: title is too long even at the "${fit.size}" size (${fit.lines} lines) — shorten it to ≤16 characters`);
  const height = Math.ceil(fit.height) + 8;
  elements.push(
    textEl({ x, y: titleY, w, h: height, html: paragraphsHtml([slots.title], c.rt.headingBold), size: fit.size, color: "$ink", font: "heading", lineHeight: LH_DISPLAY }),
  );
  return { elements, y: titleY + height + 36 };
}

function warnLimits(c: Ctx, label: string, slots: { title?: string; bullets?: string[]; eyebrow?: string }): void {
  if (slots.title !== undefined && visualLength(plainOf(slots.title)) > 18) c.warnings.push(`${label}: title is ${Math.round(visualLength(plainOf(slots.title)))} characters long — keep titles ≤16 characters (one line)`);
  if (slots.bullets !== undefined) {
    if (slots.bullets.length > 6) c.warnings.push(`${label}: ${slots.bullets.length} bullets — keep ≤6 per slide, split the rest onto another slide`);
    slots.bullets.forEach((item, i) => {
      if (visualLength(plainOf(item)) > 24) c.warnings.push(`${label}: bullet ${i + 1} is ${Math.round(visualLength(plainOf(item)))} characters — keep each bullet ≤20 characters`);
    });
  }
}

/** 正文区装不装得下：装不下只警告（正文不缩字） */
function checkBody(c: Ctx, label: string, what: string, need: number, avail: number): void {
  if (need > avail + 4) c.warnings.push(`${label}: ${what} needs ≈${Math.round(need)}px but only ${Math.round(avail)}px are available — body text is never shrunk below the theme's body size, so cut items or split this slide in two`);
}

// ─── 各版式 ─────────────────────────────────────────────────────────────

function buildCover(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const eyebrow = str(slots["eyebrow"]);
  const subtitle = str(slots["subtitle"]);
  const meta = str(slots["meta"]);
  const { W, H, mx } = c;
  const els: Raw[] = [];
  const motif = c.rt.motif;
  let textW: number;
  if (motif === "circle") {
    const d1 = W * 0.48;
    const x1 = W - d1 * 0.6;
    els.push(shapeEl("ellipse", x1, (H - d1) / 2 + 24, d1, d1, "$accent"));
    const d2 = W * 0.13;
    els.push(shapeEl("ellipse", x1 - d2 * 0.55, H - d2 * 2.1, d2, d2, "$accent2"));
    textW = Math.min(640, x1 - mx - 56);
  } else if (motif === "block") {
    const x1 = W * 0.66;
    els.push(shapeEl("rect", x1, 0, W - x1, H, "$accent"));
    const s = W * 0.1;
    els.push(shapeEl("rect", x1 - s / 2, H * 0.6, s, s, "$accent2"));
    textW = Math.min(640, x1 - mx - 56);
  } else {
    els.push(shapeEl("rect", 0, H - 148, W, 148, "$accent"));
    els.push(shapeEl("rect", 0, H - 158, W, 10, "$accent2"));
    textW = Math.min(880, W - mx * 2);
  }
  const accent = c.accentOn("$bg");
  const eyebrowY = H * 0.26;
  let y = eyebrowY;
  if (eyebrow !== undefined) {
    els.push(textEl({ x: mx, y, w: textW, h: 28, html: paragraphsHtml([eyebrow], true), size: "caption", color: accent, letterSpacing: 3 }));
    y += 52;
  }
  const fit = fitLadder(c, plainOf(title), textW, ["display", "title", "h2"], { maxLines: 3 }, LH_DISPLAY, c.rt.headingBold);
  if (!fit.ok) c.warnings.push(`${label}: title is too long for a cover (${fit.lines} lines even at "${fit.size}") — shorten it to ≤16 characters`);
  const titleH = Math.ceil(fit.height) + 10;
  els.push(textEl({ x: mx, y, w: textW, h: titleH, html: paragraphsHtml([title], c.rt.headingBold), size: fit.size, color: "$ink", font: "heading", lineHeight: LH_DISPLAY }));
  y += titleH + 28;
  if (subtitle !== undefined) {
    const sub = fitLadder(c, plainOf(subtitle), textW, ["h2", "body"], { maxLines: 3 }, LH_BODY, false);
    const subH = Math.ceil(sub.height) + 8;
    els.push(textEl({ x: mx, y, w: textW, h: subH, html: paragraphsHtml([subtitle], false), size: sub.size, color: "$muted", lineHeight: LH_BODY }));
    y += subH;
  }
  if (meta !== undefined) {
    const metaY = motif === "band" ? H - 148 - 74 : H - 96;
    els.push(textEl({ x: mx, y: metaY, w: textW, h: 30, html: paragraphsHtml([meta], false), size: "caption", color: "$muted", letterSpacing: 1 }));
  }
  warnLimits(c, label, { title });
  return { elements: els, background: "$bg", footer: "none", warnings: c.warnings };
}

function buildSection(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const number = str(slots["number"]);
  const eyebrow = str(slots["eyebrow"]);
  const subtitle = str(slots["subtitle"]);
  const { W, H, mx } = c;
  const els: Raw[] = [];
  const w = Math.min(W - mx * 2, 880);
  let y = H * 0.2;
  if (number !== undefined) {
    const size = c.scale("display");
    els.push(textEl({ x: mx, y: H * 0.12, w: 560, h: Math.ceil(size * 1.1), html: paragraphsHtml([number], false), size: "display", color: "$onAccent", font: "heading", lineHeight: 1 }));
    y = H * 0.12 + Math.ceil(size * 1.1) + 24;
  } else if (eyebrow !== undefined) {
    els.push(textEl({ x: mx, y: H * 0.3, w, h: 28, html: paragraphsHtml([eyebrow], true), size: "caption", color: "$onAccent", letterSpacing: 3 }));
    y = H * 0.3 + 52;
  } else {
    y = H * 0.34;
  }
  els.push(lineEl(mx, y, 120, "$onAccent", 3));
  y += 28;
  const fit = fitLadder(c, plainOf(title), w, ["display", "title", "h2"], { maxLines: 2 }, LH_DISPLAY, c.rt.headingBold);
  if (!fit.ok) c.warnings.push(`${label}: title is too long for a section slide — shorten it to ≤16 characters`);
  const titleH = Math.ceil(fit.height) + 10;
  els.push(textEl({ x: mx, y, w, h: titleH, html: paragraphsHtml([title], c.rt.headingBold), size: fit.size, color: "$onAccent", font: "heading", lineHeight: LH_DISPLAY }));
  y += titleH + 20;
  if (subtitle !== undefined) {
    const sub = fitLadder(c, plainOf(subtitle), w, ["h2", "body"], { maxLines: 2 }, LH_BODY, false);
    els.push(textEl({ x: mx, y, w, h: Math.ceil(sub.height) + 8, html: paragraphsHtml([subtitle], false), size: sub.size, color: "$onAccent", lineHeight: LH_BODY }));
  }
  warnLimits(c, label, { title });
  return { elements: els, background: "$accent", footer: "none", warnings: c.warnings };
}

/** 页内右下角的小装饰：跟主题母题走，给内容页一点签名感又不抢字 */
function cornerDecor(c: Ctx): Raw[] {
  const size = c.W >= 1200 ? 88 : 72;
  const x = c.W - c.mx - size;
  const y = c.bottom - size;
  switch (c.rt.motif) {
    case "circle":
      return [shapeEl("ellipse", x, y, size, size, "$accent2")];
    case "block":
      return [shapeEl("rect", x, y, size, size, "$accent2")];
    default:
      return [shapeEl("rect", x - size * 0.6, y + size - 10, size * 1.6, 10, "$accent")];
  }
}

/** 条目少时用更大一档（h2），装得宽松才用，否则正文档；永远不会比 body 小 */
function bulletsBox(c: Ctx, items: readonly string[], x: number, y: number, w: number, availH: number, label: string, allowLarge = true): Raw {
  const plain = items.map(plainOf);
  const gapFor = (size: ScaleKey): number => Math.round(c.scale(size) * 0.55);
  const largeNeed = estimateListHeight(plain, c.scale("h2"), w, gapFor("h2"), { lineHeight: LH_BODY });
  const size: ScaleKey = allowLarge && items.length <= 4 && largeNeed <= availH * 0.7 ? "h2" : "body";
  const gap = gapFor(size);
  const need = size === "h2" ? largeNeed : estimateListHeight(plain, c.scale("body"), w, gap, { lineHeight: LH_BODY });
  checkBody(c, label, "the bullet list", need, availH);
  return textEl({ x, y, w, h: Math.min(Math.max(need + 12, 60), Math.max(availH, 60)), html: listHtml(items), size, color: "$ink", lineHeight: LH_BODY, paraGap: gap });
}

function bodyBox(c: Ctx, lines: readonly string[], x: number, y: number, w: number, availH: number, label: string): Raw {
  const plain = lines.map(plainOf).join("\n");
  const need = estimateTextHeight(plain, c.scale("body"), w, { lineHeight: LH_BODY }) + (lines.length - 1) * 14;
  checkBody(c, label, "the body text", need, availH);
  return textEl({ x, y, w, h: Math.min(Math.max(need + 12, 60), Math.max(availH, 60)), html: paragraphsHtml(lines, false), size: "body", color: "$ink", lineHeight: LH_BODY, paraGap: 14 });
}

function buildBullets(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const bullets = strList(slots["bullets"]);
  const body = strList(slots["body"]);
  if (bullets === undefined && body === undefined) needSlot(label, "bullets");
  const eyebrow = str(slots["eyebrow"]);
  const head = pageHead(c, c.mx, c.cw, { title, ...(eyebrow === undefined ? {} : { eyebrow }) }, label, "$bg");
  const w = Math.round(c.cw * 0.82);
  const els = [...head.elements];
  const avail = c.bottom - head.y;
  els.push(bullets !== undefined ? bulletsBox(c, bullets, c.mx, head.y, w, avail, label) : bodyBox(c, body as string[], c.mx, head.y, w, avail, label));
  els.push(...cornerDecor(c));
  warnLimits(c, label, { title, ...(bullets === undefined ? {} : { bullets }) });
  return { elements: els, background: "$bg", footer: "left", warnings: c.warnings };
}

function buildTwoColumn(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const rawColumns = Array.isArray(slots["columns"]) ? slots["columns"] : [];
  if (rawColumns.length < 2) throw new LayoutError(`${label}: layout "two-column" needs slots.columns with 2 entries ([{heading, bullets|body}, {heading, bullets|body}])`);
  const eyebrow = str(slots["eyebrow"]);
  const head = pageHead(c, c.mx, c.cw, { title, ...(eyebrow === undefined ? {} : { eyebrow }) }, label, "$bg");
  const els = [...head.elements];
  const gap = 72;
  const colW = Math.floor((c.cw - gap) / 2);
  rawColumns.slice(0, 2).forEach((raw, i) => {
    const col = record(raw) ?? {};
    const heading = str(col["heading"]);
    const bullets = strList(col["bullets"]);
    const body = strList(col["body"]);
    if (bullets === undefined && body === undefined) throw new LayoutError(`${label}: column ${i + 1} needs bullets or body`);
    const x = c.mx + i * (colW + gap);
    let y = head.y;
    if (heading !== undefined) {
      els.push(textEl({ x, y, w: colW, h: 44, html: paragraphsHtml([heading], true), size: "h2", color: c.accentOn("$bg"), font: "heading", lineHeight: 1.2 }));
      y += 56;
      els.push(lineEl(x, y, colW, "$line", 2));
      y += 24;
    }
    const avail = c.bottom - y;
    if (bullets !== undefined && bullets.length > 4) c.warnings.push(`${label}: column ${i + 1} has ${bullets.length} bullets — keep ≤4 per column`);
    els.push(bullets !== undefined ? bulletsBox(c, bullets, x, y, colW, avail, `${label} column ${i + 1}`, false) : bodyBox(c, body as string[], x, y, colW, avail, `${label} column ${i + 1}`));
  });
  warnLimits(c, label, { title });
  return { elements: els, background: "$bg", footer: "left", warnings: c.warnings };
}

function imageEl(c: Ctx, name: string, x: number, y: number, w: number, h: number, label: string, alt: string): Raw[] {
  const image = c.images[name];
  if (image === undefined) {
    c.warnings.push(`${label}: no picture was given in slots.${name} — a grey placeholder was drawn; pass a file path or "attached"`);
    return [shapeEl("rect", x, y, w, h, "$surface")];
  }
  return [{ kind: "image", x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), src: image.src, fit: "cover", alt: alt.slice(0, 120) }];
}

function buildImageSide(c: Ctx, slots: Record<string, unknown>, label: string, side: "left" | "right"): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const bullets = strList(slots["bullets"]);
  const body = strList(slots["body"]);
  const eyebrow = str(slots["eyebrow"]);
  const { W, H, mx } = c;
  const panelW = Math.round(W * 0.4);
  const gap = 56;
  const textX = side === "right" ? mx : panelW + gap;
  const textW = side === "right" ? W - panelW - mx - gap : W - textX - mx;
  const els: Raw[] = [];
  els.push(...imageEl(c, "image", side === "right" ? W - panelW : 0, 0, panelW, H, label, title));
  const head = pageHead(c, textX, textW, { title, ...(eyebrow === undefined ? {} : { eyebrow }) }, label, "$bg");
  els.push(...head.elements);
  const avail = c.bottom - head.y;
  if (bullets !== undefined) {
    if (bullets.length > 5) c.warnings.push(`${label}: ${bullets.length} bullets next to a picture — keep ≤5`);
    els.push(bulletsBox(c, bullets, textX, head.y, textW, avail, label, false));
  } else if (body !== undefined) els.push(bodyBox(c, body, textX, head.y, textW, avail, label));
  warnLimits(c, label, { title, ...(bullets === undefined ? {} : { bullets }) });
  return { elements: els, background: "$bg", footer: side === "left" ? "right" : "left", warnings: c.warnings };
}

function buildImageFull(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const caption = str(slots["caption"]);
  const eyebrow = str(slots["eyebrow"]);
  const { W, H, mx } = c;
  const els: Raw[] = [...imageEl(c, "image", 0, 0, W, H, label, title)];
  const cardW = Math.min(Math.round(W * 0.5), 640);
  const pad = 40;
  const inner = cardW - pad * 2;
  const fit = fitLadder(c, plainOf(title), inner, ["title", "h2"], { maxLines: 2 }, LH_DISPLAY, c.rt.headingBold);
  const titleH = Math.ceil(fit.height) + 8;
  const eyebrowH = eyebrow === undefined ? 0 : 44;
  const capNeed = caption === undefined ? 0 : Math.ceil(estimateTextHeight(plainOf(caption), c.scale("body"), inner, { lineHeight: LH_BODY })) + 8;
  const cardH = pad + eyebrowH + titleH + (caption === undefined ? 0 : 16 + capNeed) + pad;
  const cardY = H - 72 - cardH;
  els.push(shapeEl("rect", mx, cardY, cardW, cardH, "$bg"));
  let y = cardY + pad;
  if (eyebrow !== undefined) {
    els.push(textEl({ x: mx + pad, y, w: inner, h: 28, html: paragraphsHtml([eyebrow], true), size: "caption", color: c.accentOn("$bg"), letterSpacing: 3 }));
    y += eyebrowH;
  }
  els.push(textEl({ x: mx + pad, y, w: inner, h: titleH, html: paragraphsHtml([title], c.rt.headingBold), size: fit.size, color: "$ink", font: "heading", lineHeight: LH_DISPLAY }));
  y += titleH + 16;
  if (caption !== undefined) els.push(textEl({ x: mx + pad, y, w: inner, h: capNeed, html: paragraphsHtml([caption], false), size: "body", color: "$muted", lineHeight: LH_BODY }));
  warnLimits(c, label, { title });
  return { elements: els, background: "$bg", footer: "none", warnings: c.warnings };
}

function buildTable(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const rawRows = Array.isArray(slots["rows"]) ? slots["rows"] : [];
  const rows = rawRows
    .map((row) => (Array.isArray(row) ? row.map((cell) => (typeof cell === "string" ? cell : typeof cell === "number" ? String(cell) : "")) : []))
    .filter((row) => row.length > 0);
  if (rows.length === 0) throw new LayoutError(`${label}: layout "table" needs slots.rows (string[][], first row = header)`);
  const eyebrow = str(slots["eyebrow"]);
  const note = str(slots["note"]);
  const head = pageHead(c, c.mx, c.cw, { title, ...(eyebrow === undefined ? {} : { eyebrow }) }, label, "$bg");
  const els = [...head.elements];
  const cols = Math.max(...rows.map((row) => row.length));
  if (rows.length > 6) c.warnings.push(`${label}: ${rows.length} rows — keep tables ≤6 rows (header included)`);
  if (cols > 4) c.warnings.push(`${label}: ${cols} columns — keep tables ≤4 columns`);
  // 列宽按各列最长内容占比（夹在 4–24 个字之间，免得一列宽得离谱）
  const weights = Array.from({ length: cols }, (_, ci) => Math.min(24, Math.max(4, ...rows.map((row) => visualLength(row[ci] ?? "")))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const colWidths = weights.map((n) => Math.round((n / sum) * 1000) / 1000);
  const fontSize = c.scale("body");
  let total = 0;
  rows.forEach((row) => {
    const lines = Math.max(1, ...row.map((cell, ci) => countLines(cell, fontSize, c.cw * (colWidths[ci] ?? 1 / cols) - 28)));
    total += Math.max(60, lines * fontSize * 1.25 + 24);
  });
  const noteH = note === undefined ? 0 : 56;
  checkBody(c, label, "the table", total, c.bottom - head.y - noteH);
  els.push({
    kind: "table",
    x: c.mx,
    y: Math.round(head.y),
    w: c.cw,
    h: Math.round(total),
    rows,
    header: slots["header"] !== false,
    colWidths,
    fontSize: "$body",
    color: "$ink",
    headerFill: "$accent",
    headerColor: "$onAccent",
    borderColor: "$line",
  });
  if (note !== undefined) els.push(textEl({ x: c.mx, y: head.y + total + 20, w: c.cw, h: 30, html: paragraphsHtml([note], false), size: "caption", color: "$muted" }));
  warnLimits(c, label, { title });
  return { elements: els, background: "$bg", footer: "left", warnings: c.warnings };
}

function buildQuote(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const quote = str(slots["quote"]) ?? needSlot(label, "quote");
  const source = str(slots["source"]);
  const eyebrow = str(slots["eyebrow"]);
  const { H, mx } = c;
  const w = c.cw - 56;
  const fit = fitLadder(c, plainOf(quote), w, ["display", "title", "h2"], { maxHeight: H * 0.46 }, 1.22, c.rt.headingBold);
  if (!fit.ok) c.warnings.push(`${label}: the quote is too long for one slide (${Math.round(visualLength(plainOf(quote)))} characters) — shorten it to one sentence`);
  const quoteH = Math.ceil(fit.height) + 10;
  const eyebrowH = eyebrow === undefined ? 0 : 56;
  const sourceH = source === undefined ? 0 : 28 + 40;
  const total = eyebrowH + quoteH + sourceH;
  let y = Math.max(72, (H - total) / 2 - 20);
  const els: Raw[] = [];
  if (eyebrow !== undefined) {
    els.push(textEl({ x: mx + 56, y, w, h: 28, html: paragraphsHtml([eyebrow], true), size: "caption", color: c.accentOn("$surface"), letterSpacing: 3 }));
    y += eyebrowH;
  }
  els.push(shapeEl("rect", mx, y + 6, 8, Math.max(quoteH - 12, 40), "$accent"));
  els.push(textEl({ x: mx + 56, y, w, h: quoteH, html: paragraphsHtml([quote], c.rt.headingBold), size: fit.size, color: "$ink", font: "heading", lineHeight: 1.22 }));
  y += quoteH + 28;
  if (source !== undefined) {
    const text = /^[—–-]/.test(source) ? source : `— ${source}`;
    els.push(textEl({ x: mx + 56, y, w, h: 40, html: paragraphsHtml([text], false), size: "body", color: "$muted" }));
  }
  return { elements: els, background: "$surface", footer: "left", warnings: c.warnings };
}

function buildStat(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const rawStats = Array.isArray(slots["stats"]) ? slots["stats"] : [];
  if (rawStats.length === 0) throw new LayoutError(`${label}: layout "stat" needs slots.stats ([{value:"3.5%", label:"…"}], 1–3 items)`);
  if (rawStats.length > 3) c.warnings.push(`${label}: ${rawStats.length} stats — only the first 3 are shown; split the rest onto another slide`);
  const stats = rawStats.slice(0, 3).map((raw) => record(raw) ?? {});
  const title = str(slots["title"]);
  const eyebrow = str(slots["eyebrow"]);
  const els: Raw[] = [];
  let y: number;
  if (title !== undefined) {
    const head = pageHead(c, c.mx, c.cw, { title, ...(eyebrow === undefined ? {} : { eyebrow }) }, label, "$bg");
    els.push(...head.elements);
    y = Math.max(head.y + 40, c.H * 0.4);
  } else {
    if (eyebrow !== undefined) els.push(textEl({ x: c.mx, y: 60, w: c.cw, h: 28, html: paragraphsHtml([eyebrow], true), size: "caption", color: c.accentOn("$bg"), letterSpacing: 3 }));
    y = c.H * 0.3;
  }
  const n = stats.length;
  const colW = Math.floor(c.cw / n);
  const innerW = colW - 48;
  stats.forEach((stat, i) => {
    const value = str(stat["value"]) ?? needSlot(label, `stats[${i}].value`);
    const caption = str(stat["label"]);
    const detail = str(stat["detail"]);
    const x = c.mx + i * colW;
    if (visualLength(value) > 8) c.warnings.push(`${label}: stat value "${value}" is long — keep big numbers ≤6 characters`);
    els.push(shapeEl("rect", x, y, innerW, 4, "$accent"));
    const fit = fitLadder(c, value, innerW, ["display", "title", "h2"], { maxLines: 1 }, 1.05, c.rt.headingBold);
    const valueH = Math.ceil(fit.height) + 8;
    els.push(textEl({ x, y: y + 28, w: innerW, h: valueH, html: paragraphsHtml([value], c.rt.headingBold), size: fit.size, color: c.accentOn("$bg") === "$accent" ? "$accent" : "$ink", font: "heading", lineHeight: 1.05 }));
    let ty = y + 28 + valueH + 12;
    if (caption !== undefined) {
      const h = Math.ceil(estimateTextHeight(plainOf(caption), c.scale("body"), innerW, { lineHeight: LH_BODY, bold: true })) + 6;
      els.push(textEl({ x, y: ty, w: innerW, h, html: paragraphsHtml([caption], true), size: "body", color: "$ink", lineHeight: LH_BODY }));
      ty += h + 6;
    }
    if (detail !== undefined) {
      const h = Math.ceil(estimateTextHeight(plainOf(detail), c.scale("body"), innerW, { lineHeight: LH_BODY })) + 6;
      checkBody(c, `${label} stat ${i + 1}`, "the detail text", ty + h - y, c.bottom - y);
      els.push(textEl({ x, y: ty, w: innerW, h, html: paragraphsHtml([detail], false), size: "body", color: "$muted", lineHeight: LH_BODY }));
    }
  });
  warnLimits(c, label, title === undefined ? {} : { title });
  return { elements: els, background: "$bg", footer: "left", warnings: c.warnings };
}

function buildClosing(c: Ctx, slots: Record<string, unknown>, label: string): LayoutOutput {
  const title = str(slots["title"]) ?? needSlot(label, "title");
  const subtitle = str(slots["subtitle"]);
  const eyebrow = str(slots["eyebrow"]);
  const contact = strList(slots["contact"]);
  const { W, H, mx } = c;
  const els: Raw[] = [];
  let textW: number;
  if (c.rt.motif === "circle") {
    const d = W * 0.42;
    els.push(shapeEl("ellipse", W - d * 0.58, H - d * 0.62, d, d, "$accent"));
    const d2 = W * 0.08;
    els.push(shapeEl("ellipse", W - d * 0.58 - d2 * 1.3, H - d2 * 2.4, d2, d2, "$accent2"));
    textW = Math.min(700, W * 0.6);
  } else if (c.rt.motif === "block") {
    const w = W * 0.2;
    els.push(shapeEl("rect", W - w, 0, w, H, "$accent"));
    els.push(shapeEl("rect", W - w - W * 0.045, H - W * 0.09, W * 0.09, W * 0.09, "$accent2"));
    textW = Math.min(700, W - w - mx - 56);
  } else {
    els.push(shapeEl("rect", 0, 0, W, H * 0.2, "$accent"));
    els.push(shapeEl("rect", 0, H * 0.2, W, 10, "$accent2"));
    textW = Math.min(880, W - mx * 2);
  }
  // 浅色主题用 ink（深）色块收尾；深色主题 ink 是浅色，那样会突然亮起来，改用 surface（比底色略浅一档）
  const darkTheme = luminance(c.rt.colors.bg) < 0.25;
  const closingBg = darkTheme ? "$surface" : "$ink";
  const closingText = darkTheme ? "$ink" : "$bg";
  const accent = c.accentOn(closingBg);
  let y = c.rt.motif === "band" ? H * 0.34 : H * 0.28;
  if (eyebrow !== undefined) {
    els.push(textEl({ x: mx, y, w: textW, h: 28, html: paragraphsHtml([eyebrow], true), size: "caption", color: accent, letterSpacing: 3 }));
    y += 52;
  }
  const fit = fitLadder(c, plainOf(title), textW, ["display", "title", "h2"], { maxLines: 2 }, LH_DISPLAY, c.rt.headingBold);
  if (!fit.ok) c.warnings.push(`${label}: closing title is too long — shorten it`);
  const titleH = Math.ceil(fit.height) + 10;
  els.push(textEl({ x: mx, y, w: textW, h: titleH, html: paragraphsHtml([title], c.rt.headingBold), size: fit.size, color: closingText, font: "heading", lineHeight: LH_DISPLAY }));
  y += titleH + 28;
  if (subtitle !== undefined) {
    const sub = fitLadder(c, plainOf(subtitle), textW, ["h2", "body"], { maxLines: 3 }, LH_BODY, false);
    const subH = Math.ceil(sub.height) + 8;
    els.push(textEl({ x: mx, y, w: textW, h: subH, html: paragraphsHtml([subtitle], false), size: sub.size, color: closingText, lineHeight: LH_BODY }));
    y += subH + 24;
  }
  if (contact !== undefined) {
    const h = Math.ceil(estimateTextHeight(contact.map(plainOf).join("\n"), c.scale("body"), textW, { lineHeight: LH_BODY })) + 8;
    els.push(textEl({ x: mx, y: Math.max(y, H - 96 - h), w: textW, h, html: paragraphsHtml(contact, false), size: "body", color: closingText, lineHeight: LH_BODY }));
  }
  warnLimits(c, label, { title });
  return { elements: els, background: closingBg, footer: "none", warnings: c.warnings };
}

function needSlot(label: string, name: string): never {
  throw new LayoutError(`${label}: missing required slot "${name}"`);
}

/** 版式 + 内容 → 元素。`label` 之类的页号由调用方通过 slots 之外的参数传不进来，这里统一用 layout 名做前缀 */
export function buildLayout(input: LayoutInput, pageLabel: string): LayoutOutput {
  const warnings: string[] = [];
  const label = `${pageLabel} (${input.layout})`;
  const allowed = SLOT_KEYS[input.layout];
  const unknown = Object.keys(input.slots).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) warnings.push(`${label}: ignored unknown slot(s) ${unknown.join(", ")} — this layout takes: ${allowed.join(", ")}`);
  const c = makeCtx(input, warnings);
  const slots = input.slots;
  switch (input.layout) {
    case "cover":
      return buildCover(c, slots, label);
    case "section":
      return buildSection(c, slots, label);
    case "bullets":
      return buildBullets(c, slots, label);
    case "two-column":
      return buildTwoColumn(c, slots, label);
    case "image-left":
      return buildImageSide(c, slots, label, "left");
    case "image-right":
      return buildImageSide(c, slots, label, "right");
    case "image-full":
      return buildImageFull(c, slots, label);
    case "table":
      return buildTable(c, slots, label);
    case "quote":
      return buildQuote(c, slots, label);
    case "stat":
      return buildStat(c, slots, label);
    case "closing":
      return buildClosing(c, slots, label);
  }
}

/** 图片槽位名（有这个槽位的版式，工具层要先把图落进 assets） */
export function imageSlotOf(layout: LayoutName): "image" | null {
  return layout === "image-left" || layout === "image-right" || layout === "image-full" ? "image" : null;
}
