/**
 * 文档 → .docx：用 remark 把 markdown（含 Obsidian 语法）解析成 mdast，再逐类映射成 Word 的
 * 段落 / 表格 / 图片 / 文字 run。纯函数 + `docx`（MIT）的 `Packer.toBuffer`，不碰 electron。
 *
 * 映射（第二期：图片、表格、提醒框、OFM）：
 * - 标题 / 段落 / 列表（嵌套、有序重新编号、任务列表）/ 引用 / 围栏代码（一行一段、等宽）/ 分隔线；
 * - 表格 → Word 表格（表头加粗加底色，列对齐照搬）；
 * - 图片（`![](相对路径)` 与 `![[图.png]]`）→ 内嵌图片（按文件头读尺寸，最宽 600px）；读不到 / 格式 Word 不认 → 方括号里写图名；
 * - 提醒框 `> [!warning] 标题` → 带色条的引用块（粗体标题 + 内容）；
 * - 双链 → 纯文字（别名优先）、标签 → 带 # 的文字、高亮 `==x==` → 文字底色；
 * - frontmatter → 文首的属性表；
 * - 链接 → 真超链接。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
} from "docx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkOfm } from "../../shared/ofm/remark-ofm.ts";
import { calloutDefaultTitle, calloutKind, parseCalloutHead } from "../../shared/ofm/syntax.ts";

/** 够用的 mdast 子集（本文件只读，不依赖 @types/mdast） */
interface Md {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  alt?: string | null;
  lang?: string | null;
  align?: (string | null)[] | null;
  children?: Md[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

type Heading = (typeof HeadingLevel)[keyof typeof HeadingLevel];
const HEADINGS: readonly Heading[] = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const ORDERED = "orbita-ordered";
const MONO = "Courier New";
const MAX_IMAGE_PX = 600;

/** 加载好的图片：字节 + Word 认得的格式 + 原始像素尺寸 */
export interface DocxImage {
  bytes: Uint8Array;
  type: "png" | "jpg" | "gif" | "bmp";
  width: number;
  height: number;
}

/**
 * 读一张图：`target` 是文档里的写法（`图.png` / `attachments/a.png`），`kind` 区分 `![[…]]` 与 `![](…)`。
 * 找不到 / 读不了 = null（导出写方括号图名，不整份失败）
 */
export type LoadImage = (target: string, kind: "embed" | "markdown") => Promise<Uint8Array | null>;

export interface DocxOptions {
  loadImage?: LoadImage;
}

/** PNG / JPEG / GIF / BMP 的文件头 → 格式与像素尺寸；认不出（webp / svg / 损坏）= null */
export function sniffImage(bytes: Uint8Array): { type: DocxImage["type"]; width: number; height: number } | null {
  const b = bytes;
  const u32 = (i: number): number => ((b[i] as number) << 24) + ((b[i + 1] as number) << 16) + ((b[i + 2] as number) << 8) + (b[i + 3] as number);
  const u16le = (i: number): number => (b[i] as number) + ((b[i + 1] as number) << 8);
  const u32le = (i: number): number => u16le(i) + u16le(i + 2) * 65536;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "png", width: u32(16), height: u32(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: "gif", width: u16le(6), height: u16le(8) };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { type: "bmp", width: u32le(18), height: Math.abs(u32le(22) | 0) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG：找 SOF 段
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1] as number;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const length = ((b[i + 2] as number) << 8) + (b[i + 3] as number);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpg", height: ((b[i + 5] as number) << 8) + (b[i + 6] as number), width: ((b[i + 7] as number) << 8) + (b[i + 8] as number) };
      }
      i += 2 + length;
    }
  }
  return null;
}

interface Style {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  shade?: boolean;
  link?: boolean;
}

interface Ctx {
  images: Map<Md, DocxImage | null>;
  orderedInstance: number;
}

const PLACEHOLDER = (name: string): string => `[${name}]`;

type Inline = TextRun | ExternalHyperlink | ImageRun;

function run(value: string, style: Style): TextRun {
  return new TextRun({
    text: value,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    ...(style.code ? { font: MONO } : {}),
    ...(style.shade ? { shading: { type: ShadingType.CLEAR, fill: "FFF3A3", color: "auto" } } : {}),
    ...(style.link ? { color: "0563C1", underline: {} } : {}),
  });
}

function imageRun(image: DocxImage, hintWidth?: number, hintHeight?: number): ImageRun {
  let width = hintWidth ?? image.width;
  let height = hintHeight ?? (hintWidth === undefined ? image.height : Math.round((hintWidth * image.height) / image.width));
  if (width > MAX_IMAGE_PX) {
    height = Math.round((height * MAX_IMAGE_PX) / width);
    width = MAX_IMAGE_PX;
  }
  return new ImageRun({
    type: image.type,
    data: image.bytes,
    transformation: { width: Math.max(1, width), height: Math.max(1, height) },
  });
}

function inlines(nodes: readonly Md[], ctx: Ctx, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        // 软换行（编辑器里看见的换行）在 Word 里也是换行
        (node.value ?? "").split("\n").forEach((line, i) => {
          if (i > 0) out.push(new TextRun({ text: "", break: 1 }));
          if (line !== "") out.push(run(line, style));
        });
        break;
      }
      case "emphasis":
        out.push(...inlines(node.children ?? [], ctx, { ...style, italics: true }));
        break;
      case "strong":
        out.push(...inlines(node.children ?? [], ctx, { ...style, bold: true }));
        break;
      case "delete":
        out.push(...inlines(node.children ?? [], ctx, { ...style, strike: true }));
        break;
      case "inlineCode":
        out.push(run(node.value ?? "", { ...style, code: true }));
        break;
      case "inlineMath":
        out.push(run(node.value ?? "", { ...style, code: true }));
        break;
      case "break":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "link": {
        const children = inlines(node.children ?? [], ctx, { ...style, link: true }).filter((c): c is TextRun => c instanceof TextRun);
        if (/^(https?:|mailto:)/i.test(node.url ?? "") && children.length > 0) {
          out.push(new ExternalHyperlink({ link: node.url as string, children }));
        } else out.push(...inlines(node.children ?? [], ctx, style));
        break;
      }
      case "image":
      case "ofmEmbed": {
        const image = ctx.images.get(node);
        const props = node.data?.hProperties ?? {};
        const name = node.type === "image" ? (node.alt ?? node.url ?? "image") : String(props["data-ofm-embed"] ?? props["alt"] ?? "image");
        if (image !== null && image !== undefined) {
          const width = typeof props["width"] === "number" ? props["width"] : undefined;
          const height = typeof props["height"] === "number" ? props["height"] : undefined;
          out.push(imageRun(image, width, height));
        } else if (node.type === "ofmEmbed" && node.data?.hName === "a") {
          out.push(...inlines(node.children ?? [], ctx, style)); // 非图片嵌入：文字
        } else out.push(run(PLACEHOLDER(name), style));
        break;
      }
      case "ofmHighlight":
        out.push(...inlines(node.children ?? [], ctx, { ...style, shade: true }));
        break;
      case "ofmWikiLink":
      case "ofmTag":
        out.push(...inlines(node.children ?? [], ctx, style));
        break;
      case "html": {
        if (/^<br\s*\/?>$/i.test((node.value ?? "").trim())) out.push(new TextRun({ text: "", break: 1 }));
        break;
      }
      case "footnoteReference":
        out.push(run(`[${node.value ?? ""}]`, style));
        break;
      default:
        if (node.children !== undefined) out.push(...inlines(node.children, ctx, style));
        else if (node.value !== undefined) out.push(run(node.value, style));
    }
  }
  return out;
}

type Block = Paragraph | Table;

interface BlockOpts {
  /** 引用嵌套深度（每层左移 + 灰色竖线） */
  quote: number;
  /** 提醒框着色（覆盖灰色竖线） */
  callout?: { border: string; fill: string };
  /** 列表缩进层级（块内的续段按它缩进） */
  listLevel: number;
}

const CALLOUT_COLORS: Readonly<Record<string, { border: string; fill: string }>> = {
  note: { border: "3B6FD4", fill: "EEF3FD" },
  abstract: { border: "2F9BB5", fill: "ECF7FA" },
  info: { border: "3B6FD4", fill: "EEF3FD" },
  todo: { border: "3B6FD4", fill: "EEF3FD" },
  tip: { border: "2F9E8F", fill: "EAF7F4" },
  success: { border: "3E9B53", fill: "ECF7EF" },
  question: { border: "C98A1B", fill: "FBF3E3" },
  warning: { border: "D9822B", fill: "FCF1E3" },
  failure: { border: "D14B4B", fill: "FBEBEB" },
  danger: { border: "D14B4B", fill: "FBEBEB" },
  bug: { border: "D14B4B", fill: "FBEBEB" },
  example: { border: "8A63D2", fill: "F3EEFB" },
  quote: { border: "9B9B9B", fill: "F4F4F4" },
};

function paragraphOptions(opts: BlockOpts): Pick<IParagraphOptions, "indent" | "border" | "shading"> {
  if (opts.quote === 0 && opts.listLevel === 0) return {};
  const left = opts.quote * 480 + (opts.quote === 0 ? opts.listLevel * 360 : 0);
  return {
    indent: { left },
    ...(opts.quote > 0
      ? {
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: opts.callout?.border ?? "BBBBBB" },
          },
        }
      : {}),
    ...(opts.callout === undefined ? {} : { shading: { type: ShadingType.CLEAR, fill: opts.callout.fill, color: "auto" } }),
  };
}

function plainText(node: Md): string {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(plainText).join("");
}

function tableOf(node: Md, ctx: Ctx): Table {
  const rows = (node.children ?? []).map((row, rowIndex) => {
    const cells = (row.children ?? []).map((cell, col) => {
      const align = node.align?.[col];
      return new TableCell({
        width: { size: 100 / Math.max((row.children ?? []).length, 1), type: WidthType.PERCENTAGE },
        ...(rowIndex === 0 ? { shading: { type: ShadingType.CLEAR, fill: "F0F0F0", color: "auto" } } : {}),
        children: [
          new Paragraph({
            alignment: align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
            children: inlines(cell.children ?? [], ctx, rowIndex === 0 ? { bold: true } : {}),
          }),
        ],
      });
    });
    return new TableRow({ children: cells, tableHeader: rowIndex === 0 });
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function propertiesTable(node: Md, ctx: Ctx): Table {
  const rows = (node.children ?? []).map((row) => {
    const key = plainText(row.children?.[0] ?? { type: "text", value: "" });
    const value = row.children?.[1] ?? { type: "text", value: "" };
    return new TableRow({
      children: [
        new TableCell({
          width: { size: 25, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: "F7F7F7", color: "auto" },
          children: [new Paragraph({ children: [new TextRun({ text: key, color: "666666" })] })],
        }),
        new TableCell({
          width: { size: 75, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: inlines(value.children ?? [], ctx) })],
        }),
      ],
    });
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

/** 提醒框：引用块的第一段以 `[!type]± 标题` 起头 */
function asCallout(node: Md): { type: string; title: string; rest: Md[] } | null {
  const first = node.children?.[0];
  if (first?.type !== "paragraph") return null;
  const lead = first.children?.[0];
  if (lead?.type !== "text" || lead.value === undefined) return null;
  const nl = lead.value.indexOf("\n");
  const head = parseCalloutHead(nl === -1 ? lead.value : lead.value.slice(0, nl));
  if (head === null) return null;
  // 头行之后的文字留在这一段里（`> [!tip]\n> 内容`），头行本身拿掉
  const remain: Md[] = [];
  if (nl !== -1 && lead.value.slice(nl + 1) !== "") remain.push({ type: "text", value: lead.value.slice(nl + 1) });
  remain.push(...(first.children ?? []).slice(1));
  const rest: Md[] = [];
  if (remain.length > 0) rest.push({ type: "paragraph", children: remain });
  rest.push(...(node.children ?? []).slice(1));
  return { type: head.type, title: head.title === "" ? calloutDefaultTitle(head.type) : head.title, rest };
}

function blocks(nodes: readonly Md[], ctx: Ctx, opts: BlockOpts): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        out.push(
          new Paragraph({
            heading: HEADINGS[Math.min(Math.max(node.depth ?? 1, 1), 6) - 1] as Heading,
            children: inlines(node.children ?? [], ctx),
          }),
        );
        break;
      case "paragraph":
        out.push(new Paragraph({ ...paragraphOptions(opts), children: inlines(node.children ?? [], ctx) }));
        break;
      case "blockquote": {
        const callout = asCallout(node);
        if (callout === null) {
          out.push(...blocks(node.children ?? [], ctx, { ...opts, quote: opts.quote + 1 }));
        } else {
          const colors = CALLOUT_COLORS[calloutKind(callout.type)] as { border: string; fill: string };
          const inner: BlockOpts = { ...opts, quote: opts.quote + 1, callout: colors };
          out.push(
            new Paragraph({
              ...paragraphOptions(inner),
              children: [new TextRun({ text: callout.title, bold: true })],
            }),
            ...blocks(callout.rest, ctx, inner),
          );
        }
        break;
      }
      case "list": {
        const ordered = node.ordered === true;
        if (ordered) ctx.orderedInstance += 1;
        const instance = ctx.orderedInstance;
        for (const item of node.children ?? []) {
          const [first, ...rest] = item.children ?? [];
          const check = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
          const level = Math.min(opts.listLevel, 4);
          const lead = first?.type === "paragraph" ? first : null;
          out.push(
            new Paragraph({
              ...(ordered
                ? { numbering: { reference: ORDERED, level, instance } }
                : { bullet: { level } }),
              children: [...(check === "" ? [] : [new TextRun(check)]), ...inlines(lead?.children ?? [], ctx)],
            }),
          );
          const tail = lead === null && first !== undefined ? [first, ...rest] : rest;
          out.push(...blocks(tail, ctx, { ...opts, listLevel: opts.listLevel + 1 }));
        }
        break;
      }
      case "code": {
        const lines = (node.value ?? "").split("\n");
        for (const line of lines.length === 0 ? [""] : lines) {
          out.push(new Paragraph({ ...paragraphOptions(opts), children: [new TextRun({ text: line, font: MONO, size: 20 })] }));
        }
        break;
      }
      case "math":
        for (const line of (node.value ?? "").split("\n")) {
          out.push(new Paragraph({ ...paragraphOptions(opts), children: [new TextRun({ text: line, font: MONO, size: 20 })] }));
        }
        break;
      case "thematicBreak":
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "999999" } } }));
        break;
      case "table":
        out.push(tableOf(node, ctx));
        out.push(new Paragraph({})); // 表格后留一个空段（Word 里两个表格紧挨会并成一个）
        break;
      case "ofmProperties":
        out.push(propertiesTable(node, ctx));
        out.push(new Paragraph({}));
        break;
      case "html":
      case "yaml":
      case "definition":
      case "footnoteDefinition":
        break;
      default:
        if (node.children !== undefined) out.push(...blocks(node.children, ctx, opts));
        else if (node.value !== undefined) out.push(new Paragraph({ children: [new TextRun(node.value)] }));
    }
  }
  return out;
}

/** 遍历收集全部图片节点（`![](…)` 与 `![[图]]`） */
function collectImages(node: Md, into: Md[]): void {
  if (node.type === "image") into.push(node);
  else if (node.type === "ofmEmbed" && node.data?.hName === "img") into.push(node);
  for (const child of node.children ?? []) collectImages(child, into);
}

export function parseDocument(markdown: string): Md {
  const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm).use(remarkOfm, { properties: true });
  return processor.runSync(processor.parse(markdown.replace(/\r\n?/g, "\n"))) as unknown as Md;
}

export async function markdownToDocx(markdown: string, options: DocxOptions = {}): Promise<Buffer> {
  const tree = parseDocument(markdown);
  const ctx: Ctx = { images: new Map(), orderedInstance: 0 };
  const imageNodes: Md[] = [];
  collectImages(tree, imageNodes);
  if (options.loadImage !== undefined) {
    const load = options.loadImage;
    await Promise.all(
      imageNodes.map(async (node) => {
        const target = node.type === "image" ? (node.url ?? "") : String(node.data?.hProperties?.["data-ofm-embed"] ?? "");
        try {
          const bytes = await load(target, node.type === "image" ? "markdown" : "embed");
          const sniffed = bytes === null ? null : sniffImage(bytes);
          ctx.images.set(node, bytes === null || sniffed === null || sniffed.width < 1 || sniffed.height < 1 ? null : { bytes, ...sniffed });
        } catch {
          ctx.images.set(node, null);
        }
      }),
    );
  }
  const children = blocks(tree.children ?? [], ctx, { quote: 0, listLevel: 0 });
  const doc = new Document({
    creator: "Orbita",
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: Array.from({ length: 5 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
          })),
        },
      ],
    },
    styles: { default: { document: { run: { size: 22 } } } },
    sections: [{ children: children.length > 0 ? children : [new Paragraph({})] }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
