/**
 * 旧版 Marp 风格 `.md` 演示文稿 → v2 的 Deck（「转换成新格式」）。
 * 不要求保真样式：标题 / 列表 / 表格 / 段落 / 图片 / 并排栏转成元素，按一个朴素的纵向版式排好，
 * 用户进编辑器再调。纯函数；图片文件的复制（进 assets）由主进程做，这里只收一张「原路径 → 新相对路径 + 尺寸」的表。
 */
import { parseDeck as parseMarpPages } from "./doc-slides.ts";
import { CANVAS_SIZE, newId, plainToRichHtml, type Deck, type Slide, type SlideElement } from "./slides.ts";
import { estimateTextHeight } from "./slides-ops.ts";

export interface ConvertedImage {
  /** 新的相对路径（`<名字>.assets/x.png`） */
  src: string;
  width: number;
  height: number;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "image"; alt: string; src: string }
  | { kind: "para"; text: string }
  | { kind: "columns"; columns: Block[][] };

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

/** 全文里出现的本地图片路径（不含 http(s) / data:）：主进程据此先把文件复制进 assets */
export function collectMarpImages(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const src = match[1] as string;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) && !src.startsWith("//")) out.add(src);
  }
  return [...out];
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (/^:::\s*columns\s*$/.test(line.trim())) {
      const columns: string[][] = [[]];
      i += 1;
      while (i < lines.length && (lines[i] as string).trim() !== ":::") {
        if ((lines[i] as string).trim() === "+++") columns.push([]);
        else (columns[columns.length - 1] as string[]).push(lines[i] as string);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "columns", columns: columns.map((col) => parseBlocks(col)) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: (heading[1] as string).length, text: (heading[2] as string).trim() });
      i += 1;
      continue;
    }
    const image = IMAGE_LINE.exec(line.trim());
    if (image !== null) {
      blocks.push({ kind: "image", alt: image[1] as string, src: image[2] as string });
      i += 1;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^\s*([-*+]|\d+[.)])\s+/, "").trim());
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).trim().startsWith("|")) {
        const cells = (lines[i] as string).trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i += 1;
      }
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== "" && !/^(#{1,6}\s|:::|\s*([-*+]|\d+[.)])\s|\|)/.test(lines[i] as string) && !IMAGE_LINE.test((lines[i] as string).trim())) {
      para.push((lines[i] as string).trim());
      i += 1;
    }
    if (para.length === 0) i += 1;
    else blocks.push({ kind: "para", text: para.join(" ") });
  }
  return blocks;
}

/** 行内 Markdown → 受限 HTML（粗体 / 斜体；代码、链接留文字） */
function inline(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/__([^_]+)__/g, "<b>$1</b>");
}

function plainOf(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

const MARGIN = 80;

function layout(blocks: readonly Block[], area: { x: number; w: number }, y0: number, images: ReadonlyMap<string, ConvertedImage>, color: string): { elements: SlideElement[]; bottom: number } {
  const elements: SlideElement[] = [];
  let y = y0;
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const size = block.level === 1 ? 52 : block.level === 2 ? 40 : 32;
        const h = Math.ceil(estimateTextHeight(plainOf(block.text), size, area.w)) + 8;
        elements.push({ id: newId(), kind: "text", x: area.x, y, w: area.w, h, html: `<b>${inline(block.text)}</b>`, fontSize: size, color, align: "left", valign: "top" });
        y += h + 16;
        break;
      }
      case "para": {
        const h = Math.ceil(estimateTextHeight(plainOf(block.text), 28, area.w)) + 8;
        elements.push({ id: newId(), kind: "text", x: area.x, y, w: area.w, h, html: inline(block.text), fontSize: 28, color, align: "left", valign: "top" });
        y += h + 14;
        break;
      }
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const h = Math.ceil(block.items.reduce((sum, item) => sum + estimateTextHeight(plainOf(item), 28, area.w - 36) + 8, 0)) + 8;
        elements.push({ id: newId(), kind: "text", x: area.x, y, w: area.w, h, html: `<${tag}>${block.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`, fontSize: 28, color, align: "left", valign: "top" });
        y += h + 14;
        break;
      }
      case "table": {
        const cols = Math.max(...block.rows.map((row) => row.length));
        const h = block.rows.length * 52;
        elements.push({
          id: newId(),
          kind: "table",
          x: area.x,
          y,
          w: area.w,
          h,
          rows: block.rows.map((row) => [...row.map(plainOf), ...Array.from({ length: cols - row.length }, () => "")]),
          header: true,
          fontSize: 22,
          color,
          headerFill: "#1f2937",
          headerColor: "#ffffff",
          borderColor: "#d0d7de",
        });
        y += h + 16;
        break;
      }
      case "image": {
        const found = images.get(block.src);
        if (found === undefined) {
          // 找不到文件：留一行文字说明，别悄悄丢
          const h = 44;
          elements.push({ id: newId(), kind: "text", x: area.x, y, w: area.w, h, html: plainToRichHtml(`[图片未找到：${block.src}]`), fontSize: 22, color, align: "left", valign: "top" });
          y += h + 12;
          break;
        }
        const ratio = found.width > 0 && found.height > 0 ? found.width / found.height : 4 / 3;
        const w = Math.min(area.w, 560 * ratio);
        const h = w / ratio;
        elements.push({ id: newId(), kind: "image", x: area.x, y, w, h, src: found.src, fit: "contain", ...(block.alt === "" ? {} : { alt: block.alt }) });
        y += h + 16;
        break;
      }
      case "columns": {
        const n = Math.max(block.columns.length, 1);
        const gap = 40;
        const colW = (area.w - gap * (n - 1)) / n;
        let bottom = y;
        block.columns.forEach((col, index) => {
          const out = layout(col, { x: area.x + index * (colW + gap), w: colW }, y, images, color);
          elements.push(...out.elements);
          bottom = Math.max(bottom, out.bottom);
        });
        y = bottom;
        break;
      }
    }
  }
  return { elements, bottom: y };
}

export function marpToDeck(text: string, title: string, images: ReadonlyMap<string, ConvertedImage> = new Map()): Deck {
  const canvas = CANVAS_SIZE["16:9"];
  const pages = parseMarpPages(text).pages;
  const color = "#1f2328";
  const slides: Slide[] = pages.map((page) => {
    const blocks = parseBlocks(page.text.split("\n"));
    const hasImage = blocks.some((block) => block.kind === "image");
    // 有图的页：文字占左 55%，图放右侧
    const textBlocks = hasImage ? blocks.filter((block) => block.kind !== "image") : blocks;
    const imageBlocks = hasImage ? blocks.filter((block) => block.kind === "image") : [];
    const textArea = { x: MARGIN, w: hasImage ? canvas.w * 0.55 - MARGIN : canvas.w - MARGIN * 2 };
    const body = layout(textBlocks, textArea, 70, images, color);
    const side = hasImage ? layout(imageBlocks, { x: canvas.w * 0.6, w: canvas.w * 0.4 - MARGIN }, 90, images, color) : { elements: [] as SlideElement[] };
    return { id: newId(), elements: [...body.elements, ...side.elements] };
  });
  return { version: 1, title, aspect: "16:9", slides: slides.length > 0 ? slides : [{ id: newId(), elements: [] }] };
}
