/**
 * 演示文稿 v2 的数据模型 —— 一份 `<名字>.slides.json` 就是一个 Deck（JSON 元素数组）。
 *
 * 为什么是元素数组而不是 Markdown / HTML：pptx 是「页 → 带位置的元素」的世界，
 * 元素数组与它同构，导出逐元素映射；用 HTML 当模型，导出 pptx 时映射不回元素（已否决）。
 * 图片放旁边的 `<名字>.assets/`，JSON 里只存相对路径——文件小、可 git、别的工具读得懂。
 *
 * 画布逻辑尺寸：16:9 = 1280×720，4:3 = 960×720；元素的 x/y/w/h 都在这套坐标里，
 * 编辑器、缩略图、播放、导出都按它缩放，页内元素的相对位置因此不随显示大小变。
 *
 * **本文件无 DOM、无 node 依赖**：agent 工具、主进程导出、渲染层共用同一份解析与校验。
 * 解析是**宽进严出**：外来的 JSON（agent 写的、用户手改的）逐字段规整，坏字段回默认、
 * 认不出的元素丢掉并记一条警告——文件永远能打开，不会因为一个字段整份报错。
 */

export type Aspect = "16:9" | "4:3";

export const CANVAS_SIZE: Readonly<Record<Aspect, { w: number; h: number }>> = {
  "16:9": { w: 1280, h: 720 },
  "4:3": { w: 960, h: 720 },
};

export const DECK_VERSION = 1;
/** 一份演示文稿的体量闸：再大不是演示文稿 */
export const DECK_MAX_SLIDES = 500;
export const SLIDE_MAX_ELEMENTS = 400;
export const DECK_MAX_BYTES = 16 * 1024 * 1024;

export type TextAlign = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";
export type ShapeKind = "rect" | "roundRect" | "ellipse" | "triangle";
export type ArrowEnd = "none" | "arrow";
export type ElementKind = "text" | "image" | "table" | "shape" | "line";

interface ElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 旋转角（度，顺时针） */
  rotate?: number;
}

export interface TextElement extends ElementBase {
  kind: "text";
  /** 受限富文本（见 sanitizeRichHtml）：b / i / u / span(color·font-size) / ul·ol·li / br */
  html: string;
  fontFamily?: string;
  fontSize: number;
  color: string;
  align: TextAlign;
  valign: VAlign;
}

export interface ImageElement extends ElementBase {
  kind: "image";
  /** 相对 .slides.json 所在目录的路径（`<名字>.assets/x.png`） */
  src: string;
  fit: "cover" | "contain";
  alt?: string;
}

export interface TableElement extends ElementBase {
  kind: "table";
  rows: string[][];
  /** 第一行是表头 */
  header: boolean;
  /** 各列宽占比（和 = 1）；缺席 = 等宽 */
  colWidths?: number[];
  fontSize: number;
  color: string;
  headerFill: string;
  headerColor: string;
  borderColor: string;
}

export interface ShapeElement extends ElementBase {
  kind: "shape";
  shape: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text?: string;
  fontSize: number;
  color: string;
}

export interface LineElement extends ElementBase {
  kind: "line";
  /** 起止点，坐标相对元素框左上角 */
  points: [[number, number], [number, number]];
  startArrow: ArrowEnd;
  endArrow: ArrowEnd;
  stroke: string;
  strokeWidth: number;
  dash: boolean;
}

export type SlideElement = TextElement | ImageElement | TableElement | ShapeElement | LineElement;

export interface Slide {
  id: string;
  /** 页背景色；缺席 = deck.theme.background */
  background?: string;
  elements: SlideElement[];
  /** 演讲备注（纯文本） */
  notes?: string;
}

export interface DeckTheme {
  fontFamily?: string;
  color?: string;
  background?: string;
}

export interface Deck {
  version: number;
  title: string;
  aspect: Aspect;
  theme?: DeckTheme;
  slides: Slide[];
}

export const DEFAULT_FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif';
export const DEFAULT_TEXT_COLOR = "#1f2328";
export const DEFAULT_BACKGROUND = "#ffffff";

export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

// ─── 颜色 / 字体 / 路径的白名单 ─────────────────────────────────────────

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_COLOR = /^rgba?\(\s*\d{1,3}\s*(?:,\s*\d{1,3}\s*){2}(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
const NAMED_COLORS: ReadonlySet<string> = new Set(["white", "black", "transparent", "red", "green", "blue", "gray", "grey", "orange", "yellow", "purple"]);

/** 颜色只认 #hex / rgb() / rgba() / 少数命名色；其余（含 url()、expression、分号）一律回退 */
export function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (HEX_COLOR.test(text) || FUNC_COLOR.test(text) || NAMED_COLORS.has(text.toLowerCase())) return text;
  return fallback;
}

/** 填充 / 描边允许 "none" */
export function safePaint(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().toLowerCase() === "none") return "none";
  return safeColor(value, fallback);
}

const FONT_FAMILY = /^[\w\u4e00-\u9fff .,'"\-]{1,120}$/;

export function safeFontFamily(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return FONT_FAMILY.test(text) ? text : undefined;
}

function finite(value: unknown, fallback: number, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  let out = value;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

/**
 * 资源路径：相对、不含 `..`、不是绝对路径 / 盘符 / 协议。图片路径经此过一遍——
 * `../../etc/passwd`、`file:///…`、`http://…` 一律拒绝（返回 null）。
 */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\\/g, "/");
  if (text === "" || text.length > 400) return null;
  if (text.startsWith("/") || /^[a-zA-Z]:/.test(text) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return null;
  if (text.split("/").some((part) => part === ".." || part === "")) return null;
  if (text.includes("\0")) return null;
  return text;
}

// ─── 受限富文本 ─────────────────────────────────────────────────────────

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  /** px（画布坐标） */
  size?: number;
}

export interface TextParagraph {
  runs: TextRun[];
  list?: "bullet" | "number";
}

const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|noscript|svg|math|textarea|title)\b[\s\S]*?<\/\1\s*>/gi;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-fA-F]{1,6});/g, (whole, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default: {
        const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface StyleState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  size?: number;
}

/** span 的 style 只认 color / font-size(px) / font-weight / font-style / text-decoration */
function applySpanStyle(base: StyleState, style: string): StyleState {
  const next: StyleState = { ...base };
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (prop === "color") {
      const color = safeColor(value, "");
      if (color !== "") next.color = color;
    } else if (prop === "font-size") {
      const match = /^(\d{1,3}(?:\.\d+)?)px$/.exec(value);
      if (match !== null) next.size = Number(match[1]);
    } else if (prop === "font-weight") {
      if (/^(bold|[6-9]00)$/i.test(value)) next.bold = true;
    } else if (prop === "font-style") {
      if (/^italic$/i.test(value)) next.italic = true;
    } else if (prop === "text-decoration" || prop === "text-decoration-line") {
      if (/underline/i.test(value)) next.underline = true;
    }
  }
  return next;
}

function styleAttr(tagAttrs: string): string {
  const match = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tagAttrs);
  return match === null ? "" : decodeEntities(match[1] ?? match[2] ?? "");
}

/**
 * 受限 HTML → 段落 / 样式段。不在白名单里的标签丢标签留文字（script / style 等连内容一起丢）；
 * 事件属性、href、src、class 一概不认——这里**没有**任何把原串透传出去的路径，
 * 所以 `<img onerror>` / `<script>` 写进去只会变成纯文字或消失。
 */
export function parseRichText(html: string): TextParagraph[] {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_WITH_CONTENT, "");
  const paragraphs: TextParagraph[] = [];
  let current: TextParagraph = { runs: [] };
  let list: "bullet" | "number" | null = null;
  const stack: StyleState[] = [{ bold: false, italic: false, underline: false }];
  const top = (): StyleState => stack[stack.length - 1] as StyleState;
  // 开标签是否压了栈（闭标签按它弹）
  const pushed: boolean[] = [];
  const tagNames: string[] = [];

  const endParagraph = (force: boolean): void => {
    if (current.runs.length > 0 || force) {
      paragraphs.push(list !== null ? { ...current, list } : current);
    }
    current = { runs: [] };
  };
  const addText = (raw: string): void => {
    const text = decodeEntities(raw).replace(/\r?\n/g, " ");
    if (text === "") return;
    const state = top();
    const run: TextRun = { text };
    if (state.bold) run.bold = true;
    if (state.italic) run.italic = true;
    if (state.underline) run.underline = true;
    if (state.color !== undefined) run.color = state.color;
    if (state.size !== undefined) run.size = state.size;
    const last = current.runs[current.runs.length - 1];
    if (
      last !== undefined &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.underline === run.underline &&
      last.color === run.color &&
      last.size === run.size
    ) {
      last.text += text;
    } else {
      current.runs.push(run);
    }
  };

  let cursor = 0;
  let afterBreak = false;
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(cleaned)) !== null) {
    if (match.index > cursor) {
      addText(cleaned.slice(cursor, match.index));
      afterBreak = false;
    }
    cursor = match.index + match[0].length;
    const closing = match[1] === "/";
    const name = (match[2] as string).toLowerCase();
    const attrs = match[3] ?? "";
    if (!closing) {
      switch (name) {
        case "br":
          endParagraph(true);
          afterBreak = true;
          continue;
        case "ul":
        case "ol":
          endParagraph(false);
          list = name === "ul" ? "bullet" : "number";
          break;
        case "li":
          endParagraph(false);
          break;
        case "p":
        case "div":
          // 紧跟在 <br> 后的块不再多切一段（contenteditable 的 `<div><br></div>` 空行 = 一个空段）
          if (!afterBreak) endParagraph(false);
          break;
        case "b":
        case "strong":
          stack.push({ ...top(), bold: true });
          pushed.push(true);
          tagNames.push(name);
          continue;
        case "i":
        case "em":
          stack.push({ ...top(), italic: true });
          pushed.push(true);
          tagNames.push(name);
          continue;
        case "u":
          stack.push({ ...top(), underline: true });
          pushed.push(true);
          tagNames.push(name);
          continue;
        case "span":
        case "font": {
          const style = name === "font" ? `color:${/\bcolor\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ""}` : styleAttr(attrs);
          stack.push(applySpanStyle(top(), style));
          pushed.push(true);
          tagNames.push(name);
          continue;
        }
        default:
          // 白名单之外：丢标签、留文字（子节点照常进来）
          break;
      }
      afterBreak = false;
    } else {
      switch (name) {
        case "ul":
        case "ol":
          endParagraph(false);
          list = null;
          break;
        case "li":
        case "p":
        case "div":
          endParagraph(false);
          break;
        case "b":
        case "strong":
        case "i":
        case "em":
        case "u":
        case "span":
        case "font": {
          // 弹到最近的同名开标签；找不到（多余的闭标签）就忽略
          const at = tagNames.lastIndexOf(name);
          if (at >= 0) {
            while (tagNames.length > at) {
              tagNames.pop();
              pushed.pop();
              stack.pop();
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }
  if (cursor < cleaned.length) addText(cleaned.slice(cursor));
  endParagraph(false);
  return paragraphs;
}

function runHtml(run: TextRun): string {
  let out = escapeHtml(run.text);
  const style: string[] = [];
  if (run.color !== undefined) style.push(`color:${run.color}`);
  if (run.size !== undefined) style.push(`font-size:${run.size}px`);
  if (style.length > 0) out = `<span style="${style.join(";")}">${out}</span>`;
  if (run.underline === true) out = `<u>${out}</u>`;
  if (run.italic === true) out = `<i>${out}</i>`;
  if (run.bold === true) out = `<b>${out}</b>`;
  return out;
}

/** 段落 → 规范 HTML：普通段落以 `<br>` 分隔，列表用 ul / ol > li */
export function serializeRichText(paragraphs: readonly TextParagraph[]): string {
  const parts: string[] = [];
  let openList: "bullet" | "number" | null = null;
  let pendingBreak = false;
  const closeList = (): void => {
    if (openList !== null) parts.push(openList === "bullet" ? "</ul>" : "</ol>");
    openList = null;
  };
  for (const paragraph of paragraphs) {
    const inner = paragraph.runs.map(runHtml).join("");
    if (paragraph.list !== undefined) {
      if (openList !== paragraph.list) {
        closeList();
        parts.push(paragraph.list === "bullet" ? "<ul>" : "<ol>");
        openList = paragraph.list;
      }
      parts.push(`<li>${inner}</li>`);
      pendingBreak = false;
    } else {
      closeList();
      if (pendingBreak) parts.push("<br>");
      parts.push(inner);
      pendingBreak = true;
    }
  }
  closeList();
  return parts.join("");
}

/** 任意 HTML → 规范、无害的 HTML。写入 / 读入 / 粘贴一律过它 */
export function sanitizeRichHtml(html: string): string {
  return serializeRichText(parseRichText(html));
}

/** 纯文字（摘要、搜索、pptx 兜底）：段落以换行连接 */
export function richTextToPlain(html: string): string {
  return parseRichText(html)
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join("\n");
}

/** 纯文字 → 规范 HTML（每行一段） */
export function plainToRichHtml(text: string): string {
  return serializeRichText(text.split(/\r?\n/).map((line) => ({ runs: line === "" ? [] : [{ text: line }] })));
}

// ─── 元素规整（宽进严出） ───────────────────────────────────────────────

export interface NormalizeContext {
  canvas: { w: number; h: number };
  theme?: DeckTheme | undefined;
}

const ASPECTS: readonly Aspect[] = ["16:9", "4:3"];
const SHAPES: readonly ShapeKind[] = ["rect", "roundRect", "ellipse", "triangle"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 元素规整失败的原因（agent 工具把它原样回给模型，让它改） */
export class ElementError extends Error {}

/**
 * 一个外来元素 → 规整后的元素。认不出 kind 抛 ElementError。
 * 缺省值：位置 / 尺寸给一个居中的合理框，字号 / 颜色取主题。
 */
export function normalizeElement(raw: unknown, ctx: NormalizeContext): SlideElement {
  const item = record(raw);
  if (item === null) throw new ElementError("元素必须是对象");
  const kind = item["kind"];
  const { canvas } = ctx;
  const textColor = safeColor(ctx.theme?.color, DEFAULT_TEXT_COLOR);
  const id = typeof item["id"] === "string" && /^[\w-]{1,40}$/.test(item["id"]) ? item["id"] : newId();
  const base = {
    id,
    x: finite(item["x"], 80, -canvas.w, canvas.w * 2),
    y: finite(item["y"], 80, -canvas.h, canvas.h * 2),
    w: finite(item["w"], 400, 1, canvas.w * 4),
    h: finite(item["h"], 100, 1, canvas.h * 4),
    ...(typeof item["rotate"] === "number" && Number.isFinite(item["rotate"]) && item["rotate"] !== 0 ? { rotate: item["rotate"] % 360 } : {}),
  };
  switch (kind) {
    case "text": {
      const html = typeof item["html"] === "string" ? sanitizeRichHtml(item["html"]) : typeof item["text"] === "string" ? plainToRichHtml(item["text"]) : "";
      const fontFamily = safeFontFamily(item["fontFamily"]);
      return {
        ...base,
        kind: "text",
        html,
        ...(fontFamily === undefined ? {} : { fontFamily }),
        fontSize: finite(item["fontSize"], 28, 6, 400),
        color: safeColor(item["color"], textColor),
        align: pickEnum(item["align"], ["left", "center", "right"] as const, "left"),
        valign: pickEnum(item["valign"], ["top", "middle", "bottom"] as const, "top"),
      };
    }
    case "image": {
      const src = safeRelativePath(item["src"]);
      if (src === null) throw new ElementError("image.src 必须是相对路径（如 `名字.assets/a.png`），不能含 .. 或协议；用 slides_insert_image 放图");
      return {
        ...base,
        kind: "image",
        src,
        fit: pickEnum(item["fit"], ["cover", "contain"] as const, "contain"),
        ...(typeof item["alt"] === "string" ? { alt: item["alt"].slice(0, 200) } : {}),
      };
    }
    case "table": {
      const rawRows = Array.isArray(item["rows"]) ? item["rows"] : [];
      const rows = rawRows
        .slice(0, 100)
        .map((row) => (Array.isArray(row) ? row.slice(0, 30).map((cell) => (typeof cell === "string" ? cell : typeof cell === "number" ? String(cell) : "")) : []))
        .filter((row) => row.length > 0);
      if (rows.length === 0) throw new ElementError("table.rows 至少要有一行（string[][]）");
      const cols = Math.max(...rows.map((row) => row.length));
      const filled = rows.map((row) => [...row, ...Array.from({ length: cols - row.length }, () => "")]);
      const widths = Array.isArray(item["colWidths"]) ? item["colWidths"].filter((n): n is number => typeof n === "number" && n > 0) : [];
      const sum = widths.reduce((a, b) => a + b, 0);
      return {
        ...base,
        kind: "table",
        rows: filled,
        header: item["header"] !== false,
        ...(widths.length === cols && sum > 0 ? { colWidths: widths.map((n) => n / sum) } : {}),
        fontSize: finite(item["fontSize"], 20, 6, 200),
        color: safeColor(item["color"], textColor),
        headerFill: safeColor(item["headerFill"], "#1f2937"),
        headerColor: safeColor(item["headerColor"], "#ffffff"),
        borderColor: safeColor(item["borderColor"], "#d0d7de"),
      };
    }
    case "shape": {
      return {
        ...base,
        kind: "shape",
        shape: pickEnum(item["shape"], SHAPES, "rect"),
        fill: safePaint(item["fill"], "#e5e7eb"),
        stroke: safePaint(item["stroke"], "none"),
        strokeWidth: finite(item["strokeWidth"], 2, 0, 40),
        ...(typeof item["text"] === "string" && item["text"] !== "" ? { text: item["text"].slice(0, 2000) } : {}),
        fontSize: finite(item["fontSize"], 24, 6, 400),
        color: safeColor(item["color"], textColor),
      };
    }
    case "line": {
      const rawPoints = Array.isArray(item["points"]) ? item["points"] : [];
      const point = (value: unknown, fallback: [number, number]): [number, number] =>
        Array.isArray(value) && value.length >= 2 ? [finite(value[0], fallback[0], -4000, 8000), finite(value[1], fallback[1], -4000, 8000)] : fallback;
      const w = base.w;
      const h = base.h;
      return {
        ...base,
        kind: "line",
        points: [point(rawPoints[0], [0, 0]), point(rawPoints[1], [w, h])],
        startArrow: pickEnum(item["startArrow"], ["none", "arrow"] as const, "none"),
        endArrow: pickEnum(item["endArrow"], ["none", "arrow"] as const, "none"),
        stroke: safeColor(item["stroke"], textColor),
        strokeWidth: finite(item["strokeWidth"], 4, 0.5, 40),
        dash: item["dash"] === true,
      };
    }
    default:
      throw new ElementError(`未知的元素 kind：${typeof kind === "string" ? kind : String(kind)}（可用：text / image / table / shape / line）`);
  }
}

export function normalizeBackground(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const color = safeColor(value, "");
  return color === "" ? undefined : color;
}

function normalizeTheme(value: unknown): DeckTheme | undefined {
  const item = record(value);
  if (item === null) return undefined;
  const fontFamily = safeFontFamily(item["fontFamily"]);
  const color = safeColor(item["color"], "");
  const background = safeColor(item["background"], "");
  const theme: DeckTheme = {
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(color === "" ? {} : { color }),
    ...(background === "" ? {} : { background }),
  };
  return Object.keys(theme).length === 0 ? undefined : theme;
}

export function normalizeSlide(raw: unknown, ctx: NormalizeContext, warnings: string[] = []): Slide {
  const item = record(raw) ?? {};
  const rawElements = Array.isArray(item["elements"]) ? item["elements"] : [];
  const elements: SlideElement[] = [];
  const ids = new Set<string>();
  rawElements.slice(0, SLIDE_MAX_ELEMENTS).forEach((element, index) => {
    try {
      const normalized = normalizeElement(element, ctx);
      // id 在页内必须唯一：重复的换新（复制粘贴 / 手写 JSON 常见）
      const unique = ids.has(normalized.id) ? { ...normalized, id: newId() } : normalized;
      ids.add(unique.id);
      elements.push(unique);
    } catch (cause) {
      warnings.push(`元素 #${index + 1} 已忽略：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  const background = normalizeBackground(item["background"]);
  const id = typeof item["id"] === "string" && /^[\w-]{1,40}$/.test(item["id"]) ? item["id"] : newId();
  return {
    id,
    ...(background === undefined ? {} : { background }),
    elements,
    ...(typeof item["notes"] === "string" && item["notes"] !== "" ? { notes: item["notes"].slice(0, 20000) } : {}),
  };
}

export interface ParsedDeck {
  deck: Deck;
  warnings: string[];
}

/** 文本 → Deck。JSON 都读不出来就抛（调用方把原因告诉用户）；其余字段宽进 */
export function parseDeck(text: string): ParsedDeck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const item = record(raw);
  if (item === null) throw new Error("演示文稿文件的顶层必须是对象");
  const warnings: string[] = [];
  const aspect = pickEnum(item["aspect"], ASPECTS, "16:9");
  const theme = normalizeTheme(item["theme"]);
  const ctx: NormalizeContext = { canvas: CANVAS_SIZE[aspect], theme };
  const rawSlides = Array.isArray(item["slides"]) ? item["slides"] : [];
  const slideIds = new Set<string>();
  const slides = rawSlides.slice(0, DECK_MAX_SLIDES).map((slide) => {
    const normalized = normalizeSlide(slide, ctx, warnings);
    const unique = slideIds.has(normalized.id) ? { ...normalized, id: newId() } : normalized;
    slideIds.add(unique.id);
    return unique;
  });
  return {
    deck: {
      version: DECK_VERSION,
      title: typeof item["title"] === "string" ? item["title"].slice(0, 200) : "",
      aspect,
      ...(theme === undefined ? {} : { theme }),
      slides,
    },
    warnings,
  };
}

/** Deck → 文本。两格缩进：git diff 友好，agent 也读得顺 */
export function serializeDeck(deck: Deck): string {
  return `${JSON.stringify(deck, null, 2)}\n`;
}

export function isDeckPath(path: string): boolean {
  return /\.slides\.json$/i.test(path);
}

/** `<目录>/<名字>.slides.json` → `<名字>.assets`（相对目录名） */
export function assetsDirName(deckPath: string): string {
  const name = deckPath.split(/[\\/]/).pop() ?? deckPath;
  return `${name.replace(/\.slides\.json$/i, "")}.assets`;
}

export function deckTitleFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.slides\.json$/i, "");
}
