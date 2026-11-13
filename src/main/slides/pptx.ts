/**
 * Deck → .pptx（pptxgenjs，MIT）。**元素逐类映射**，不是整页截图：
 * text → addText（逐 run 的粗 / 斜 / 下划线 / 颜色 / 字号，列表成真项目符号）、
 * image → addImage（contain / cover 在这里算好几何）、table → addTable、
 * shape → addShape / 带字的 addText({ shape })、line → 线形状（带 head / tail 箭头，起止点翻转）、
 * 备注 → addNotes。映射思路参照 PPTist 的 exportPPTX（AGPL-3.0，本仓同许可）：画布 px → 英寸 ÷96，
 * 字号 px → pt ×0.75。
 *
 * - 保留字体：每个文本的字体取元素 / 主题字体栈的第一个；
 * - 通用字体（basic）：所有 run 一律映射到保底字体——含中日韩字符用 Microsoft YaHei，其余 Arial
 *   （对方机器上一定有的字体，排版不会因缺字体而变形）。
 *
 * 纯模块（不 import electron），可被 node --test 直接测。
 */
import PptxGenJS from "pptxgenjs";
import { IMAGE_MIME, type ImageInfo } from "../../shared/image-size.ts";
import { BASIC_FONTS } from "../../shared/slides-export.ts";
import { footerElement } from "../../shared/slides-footer.ts";
import {
  CANVAS_SIZE,
  DEFAULT_FONT_FAMILY,
  parseRichText,
  type Deck,
  type ImageElement,
  type LineElement,
  type ShapeElement,
  type Slide,
  type TableElement,
  type TextElement,
  type TextParagraph,
} from "../../shared/slides.ts";

export interface PptxAsset {
  bytes: Uint8Array;
  info: ImageInfo | null;
}

export interface PptxOptions {
  /** true = 通用字体版 */
  basicFonts: boolean;
  /** 资源路径 → 图片字节（读不到的不在表里，导出时那张图画占位框 + 文件名） */
  assets: ReadonlyMap<string, PptxAsset>;
}

const PX = 1 / 96;
const PT = 0.75;

const inches = (px: number): number => Math.round(px * PX * 10000) / 10000;

const NAMED: Readonly<Record<string, string>> = {
  white: "FFFFFF",
  black: "000000",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  gray: "808080",
  grey: "808080",
  orange: "FFA500",
  yellow: "FFFF00",
  purple: "800080",
};

/** CSS 颜色 → pptx 颜色（6 位大写 hex，无 #）与透明度（0–100，pptx 的 transparency） */
export function pptxColor(css: string): { color: string; transparency: number } | null {
  const text = css.trim().toLowerCase();
  if (text === "none") return null;
  if (text === "transparent") return { color: "FFFFFF", transparency: 100 };
  const named = NAMED[text];
  if (named !== undefined) return { color: named, transparency: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex !== null) {
    const h = hex[1] as string;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16)) as [number, number, number, number | undefined];
      return { color: toHex(r, g, b), transparency: a === undefined ? 0 : Math.round((1 - a / 255) * 100) };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        color: h.slice(0, 6).toUpperCase(),
        transparency: h.length === 8 ? Math.round((1 - parseInt(h.slice(6, 8), 16) / 255) * 100) : 0,
      };
    }
    return null;
  }
  const func = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (func !== null) {
    const alpha = func[4] === undefined ? 1 : Number(func[4]);
    return { color: toHex(Number(func[1]), Number(func[2]), Number(func[3])), transparency: Math.round((1 - alpha) * 100) };
  }
  return null;
}

function toHex(r: number, g: number, b: number): string {
  return [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const CJK_SPLIT = /([\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+)/;

/** 字体栈里认得的东亚（中日韩）字体名；取栈里第一个当「东亚字体」 */
const EAST_ASIAN_FONTS: readonly string[] = [
  "PingFang SC",
  "PingFang TC",
  "Hiragino Sans GB",
  "Heiti SC",
  "STHeiti",
  "Songti SC",
  "STSong",
  "Noto Sans CJK SC",
  "Noto Serif CJK SC",
  "Noto Sans SC",
  "Noto Serif SC",
  "Source Han Sans SC",
  "Source Han Serif SC",
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "Yu Gothic",
  "Malgun Gothic",
];
const EAST_ASIAN_DEFAULT = "PingFang SC";

/** 字体栈里的东亚字体：栈里第一个认得的 CJK 字体；栈里没有就用 PingFang SC */
export function eastAsianFont(stack: string): string {
  const known = new Set(EAST_ASIAN_FONTS.map((name) => name.toLowerCase()));
  for (const part of stack.split(",")) {
    const name = part.trim().replace(/^["']|["']$/g, "");
    if (known.has(name.toLowerCase())) return name;
  }
  return EAST_ASIAN_DEFAULT;
}

/** 字体栈的第一个字体名（去引号） */
export function firstFont(stack: string): string {
  const first = stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return first === "" ? "Arial" : first;
}

function fontFor(text: string, stack: string, basic: boolean): string {
  if (!basic) return firstFont(stack);
  return CJK.test(text) ? (BASIC_FONTS[1] as string) : (BASIC_FONTS[0] as string);
}

/**
 * 一段文字 → 带字体的片段。保留字体版：只写拉丁字体（栈里第一个，如 Helvetica Neue）时，中文在对方机器上
 * 回落成什么不可预测，所以按字符切开——中日韩字符用栈里的东亚字体（`a:latin` 与 `a:ea` 都写它），其余用拉丁字体；
 * 通用字体版仍是整段一个保底字体（含中日韩 → Microsoft YaHei，否则 Arial，ea 也写它）。
 */
export function fontSegments(text: string, stack: string, basic: boolean): { text: string; fontFace: string }[] {
  if (basic) return [{ text, fontFace: fontFor(text, stack, true) }];
  const latin = firstFont(stack);
  if (!CJK.test(text)) return [{ text, fontFace: latin }];
  const east = eastAsianFont(stack);
  return text
    .split(CJK_SPLIT)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, fontFace: CJK.test(part) ? east : latin }));
}

function fill(css: string): { color: string; transparency?: number } | undefined {
  const parsed = pptxColor(css);
  if (parsed === null) return undefined;
  return { color: parsed.color, ...(parsed.transparency > 0 ? { transparency: parsed.transparency } : {}) };
}

type TextProps = PptxGenJS.TextProps;

function textRuns(paragraphs: readonly TextParagraph[], base: { stack: string; size: number; color: string; basic: boolean }): TextProps[] {
  const runs: TextProps[] = [];
  const list = paragraphs.length > 0 ? paragraphs : [{ runs: [] }];
  list.forEach((paragraph, index) => {
    const last = index === list.length - 1;
    const source = paragraph.runs.length > 0 ? paragraph.runs : [{ text: " " }];
    source.forEach((run, runIndex) => {
      const color = pptxColor(run.color ?? base.color);
      const lastRun = runIndex === source.length - 1;
      const segments = fontSegments(run.text, base.stack, base.basic);
      segments.forEach((segment, segmentIndex) => {
        const options: PptxGenJS.TextPropsOptions = {
          fontFace: segment.fontFace,
          fontSize: Math.round((run.size ?? base.size) * PT * 10) / 10,
          ...(color === null ? {} : { color: color.color }),
          ...(run.bold === true ? { bold: true } : {}),
          ...(run.italic === true ? { italic: true } : {}),
          ...(run.underline === true ? { underline: { style: "sng" as const } } : {}),
          ...(paragraph.list === "bullet" ? { bullet: true } : paragraph.list === "number" ? { bullet: { type: "number" as const } } : {}),
          ...(lastRun && segmentIndex === segments.length - 1 && !last ? { breakLine: true } : {}),
        };
        runs.push({ text: segment.text, options });
      });
    });
  });
  return runs;
}

type Valign = "top" | "middle" | "bottom";

function addText(slide: PptxGenJS.Slide, element: TextElement, deck: Deck, opts: PptxOptions): void {
  const stack = element.fontFamily ?? deck.theme?.fontFamily ?? DEFAULT_FONT_FAMILY;
  const runs = textRuns(parseRichText(element.html), { stack, size: element.fontSize, color: element.color, basic: opts.basicFonts });
  slide.addText(runs, {
    x: inches(element.x),
    y: inches(element.y),
    w: inches(element.w),
    h: inches(element.h),
    align: element.align,
    valign: element.valign as Valign,
    margin: 0,
    fit: "none",
    wrap: true,
    // 段后间距（列表项之间的 paraGap）、行高倍数、字距：版式落出来的文字带这三项，画布与 pptx 要一致
    paraSpaceAfter: element.paraGap === undefined ? 0 : Math.round(element.paraGap * PT * 10) / 10,
    paraSpaceBefore: 0,
    ...(element.lineHeight === undefined ? {} : { lineSpacingMultiple: element.lineHeight / 1.2 }),
    ...(element.letterSpacing === undefined || element.letterSpacing === 0 ? {} : { charSpacing: Math.round(element.letterSpacing * PT * 10) / 10 }),
    ...(element.rotate === undefined ? {} : { rotate: element.rotate }),
  });
}

function placeholderLabel(src: string): string {
  return src.split("/").pop() ?? src;
}

function addImage(slide: PptxGenJS.Slide, element: ImageElement, opts: PptxOptions): void {
  const asset = opts.assets.get(element.src);
  const rotate = element.rotate === undefined ? {} : { rotate: element.rotate };
  if (asset === undefined) {
    slide.addText(placeholderLabel(element.src), {
      x: inches(element.x),
      y: inches(element.y),
      w: inches(element.w),
      h: inches(element.h),
      shape: "rect",
      fill: { color: "E5E7EB" },
      color: "6B7280",
      fontSize: 14,
      fontFace: "Arial",
      align: "center",
      valign: "middle",
      ...rotate,
    });
    return;
  }
  const mime = asset.info === null ? "image/png" : IMAGE_MIME[asset.info.format];
  const data = `${mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
  const natural = asset.info;
  if (natural === null || natural.width <= 0 || natural.height <= 0) {
    slide.addImage({ data, x: inches(element.x), y: inches(element.y), w: inches(element.w), h: inches(element.h), ...rotate });
    return;
  }
  const boxRatio = element.w / element.h;
  const imgRatio = natural.width / natural.height;
  if (element.fit === "contain") {
    // 等比缩进框内、居中（几何在这里算好，pptx 里就是一张普通图片）
    const w = imgRatio > boxRatio ? element.w : element.h * imgRatio;
    const h = imgRatio > boxRatio ? element.w / imgRatio : element.h;
    slide.addImage({
      data,
      x: inches(element.x + (element.w - w) / 2),
      y: inches(element.y + (element.h - h) / 2),
      w: inches(w),
      h: inches(h),
      ...rotate,
    });
    return;
  }
  // cover：铺满框、裁掉多出的部分。pptxgenjs 的 sizing 约定：options.w/h 是「图片自身尺寸」，
  // sizing.x/y/w/h 是在它上面裁出的可见区域，输出的外框 = 可见区域。所以 options 给铺满后的
  // 图片尺寸，sizing 给居中的框大小——出来是标准的 a:srcRect 裁剪，图片本体不重编码，
  // 用户在 PowerPoint 里还能再调裁剪
  const scaledW = imgRatio > boxRatio ? element.h * imgRatio : element.w;
  const scaledH = imgRatio > boxRatio ? element.h : element.w / imgRatio;
  slide.addImage({
    data,
    x: inches(element.x),
    y: inches(element.y),
    w: inches(scaledW),
    h: inches(scaledH),
    sizing: {
      type: "crop",
      x: inches((scaledW - element.w) / 2),
      y: inches((scaledH - element.h) / 2),
      w: inches(element.w),
      h: inches(element.h),
    },
    ...rotate,
  });
}

function addTable(slide: PptxGenJS.Slide, element: TableElement, deck: Deck, opts: PptxOptions): void {
  const stack = deck.theme?.fontFamily ?? DEFAULT_FONT_FAMILY;
  const cols = element.rows[0]?.length ?? 1;
  const widths = element.colWidths ?? Array.from({ length: cols }, () => 1 / cols);
  const border = pptxColor(element.borderColor);
  const rows: PptxGenJS.TableRow[] = element.rows.map((row, rowIndex) =>
    row.map((cell) => {
      const head = element.header && rowIndex === 0;
      const color = pptxColor(head ? element.headerColor : element.color);
      const bg = head ? pptxColor(element.headerFill) : null;
      const options = {
        fontSize: Math.round(element.fontSize * PT * 10) / 10,
        ...(color === null ? {} : { color: color.color }),
        ...(head ? { bold: true } : {}),
        ...(bg === null ? {} : { fill: { color: bg.color } }),
        valign: "middle" as const,
        align: "left" as const,
        margin: [0.04, 0.12, 0.04, 0.12] as [number, number, number, number],
      };
      const segments = fontSegments(cell, stack, opts.basicFonts);
      // 单一字体：整格一个字体；中英混排：按片段切开，中文片段用东亚字体（同文本框的规矩）
      if (segments.length === 1) return { text: cell, options: { ...options, fontFace: (segments[0] as { fontFace: string }).fontFace } };
      return { text: segments.map((segment) => ({ text: segment.text, options: { ...options, fontFace: segment.fontFace } })), options };
    }),
  );
  slide.addTable(rows, {
    x: inches(element.x),
    y: inches(element.y),
    w: inches(element.w),
    h: inches(element.h),
    colW: widths.map((w) => inches(element.w * w)),
    rowH: inches(element.h / element.rows.length),
    ...(border === null ? {} : { border: { type: "solid" as const, pt: 1, color: border.color } }),
  });
}

function shapeTypeOf(pptx: PptxGenJS, shape: ShapeElement["shape"]): PptxGenJS.ShapeType {
  switch (shape) {
    case "ellipse":
      return pptx.ShapeType.ellipse;
    case "triangle":
      return pptx.ShapeType.triangle;
    case "roundRect":
      return pptx.ShapeType.roundRect;
    default:
      return pptx.ShapeType.rect;
  }
}

function addShape(pptx: PptxGenJS, slide: PptxGenJS.Slide, element: ShapeElement, deck: Deck, opts: PptxOptions): void {
  const fillColor = fill(element.fill);
  const stroke = pptxColor(element.stroke);
  const common = {
    x: inches(element.x),
    y: inches(element.y),
    w: inches(element.w),
    h: inches(element.h),
    ...(fillColor === undefined ? {} : { fill: fillColor }),
    line:
      stroke === null || element.strokeWidth <= 0
        ? { type: "none" as const }
        : { color: stroke.color, width: Math.round(element.strokeWidth * PT * 10) / 10 },
    ...(element.shape === "roundRect" ? { rectRadius: 0.14 * Math.min(element.w, element.h) * PX } : {}),
    ...(element.rotate === undefined ? {} : { rotate: element.rotate }),
  };
  const type = shapeTypeOf(pptx, element.shape);
  if (element.text === undefined) {
    slide.addShape(type, common);
    return;
  }
  const stack = deck.theme?.fontFamily ?? DEFAULT_FONT_FAMILY;
  const color = pptxColor(element.color);
  const size = Math.round(element.fontSize * PT * 10) / 10;
  const runs: TextProps[] = fontSegments(element.text, stack, opts.basicFonts).map((segment) => ({
    text: segment.text,
    options: { fontFace: segment.fontFace, fontSize: size, ...(color === null ? {} : { color: color.color }) },
  }));
  slide.addText(runs, {
    ...common,
    shape: type,
    align: "center",
    valign: "middle",
    margin: 4,
  });
}

function addLine(pptx: PptxGenJS, slide: PptxGenJS.Slide, element: LineElement): void {
  const [[x1, y1], [x2, y2]] = element.points;
  const ax = element.x + x1;
  const ay = element.y + y1;
  const bx = element.x + x2;
  const by = element.y + y2;
  const color = pptxColor(element.stroke);
  slide.addShape(pptx.ShapeType.line, {
    x: inches(Math.min(ax, bx)),
    y: inches(Math.min(ay, by)),
    w: inches(Math.abs(bx - ax)),
    h: inches(Math.abs(by - ay)),
    flipH: bx < ax,
    flipV: by < ay,
    line: {
      ...(color === null ? {} : { color: color.color }),
      width: Math.round(element.strokeWidth * PT * 10) / 10,
      ...(element.dash ? { dashType: "dash" as const } : {}),
      beginArrowType: element.startArrow === "arrow" ? "triangle" : "none",
      endArrowType: element.endArrow === "arrow" ? "triangle" : "none",
    },
  });
}

function addSlide(pptx: PptxGenJS, deck: Deck, source: Slide, index: number, opts: PptxOptions): void {
  const slide = pptx.addSlide();
  const background = pptxColor(source.background ?? deck.theme?.background ?? "#ffffff");
  slide.background = { color: background?.color ?? "FFFFFF" };
  for (const element of source.elements) {
    switch (element.kind) {
      case "text":
        addText(slide, element, deck, opts);
        break;
      case "image":
        addImage(slide, element, opts);
        break;
      case "table":
        addTable(slide, element, deck, opts);
        break;
      case "shape":
        addShape(pptx, slide, element, deck, opts);
        break;
      case "line":
        addLine(pptx, slide, element);
        break;
    }
  }
  // 页脚「标题 · 页码」：与画布同一个函数给出的文字元素
  const footer = footerElement(deck, source, index);
  if (footer !== null) addText(slide, footer, deck, opts);
  if (source.notes !== undefined && source.notes !== "") slide.addNotes(source.notes);
}

export async function buildPptx(deck: Deck, opts: PptxOptions): Promise<Buffer> {
  const pptx = new PptxGenJS();
  const canvas = CANVAS_SIZE[deck.aspect];
  pptx.defineLayout({ name: "ORBITA", width: inches(canvas.w), height: inches(canvas.h) });
  pptx.layout = "ORBITA";
  pptx.title = deck.title;
  pptx.company = "Orbita";
  deck.slides.forEach((slide, index) => addSlide(pptx, deck, slide, index, opts));
  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(out as Buffer);
}
