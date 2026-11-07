/**
 * 演示文稿的数据操作函数 —— **一处真源，两个入口**：
 * agent 的 slides_* 工具与编辑器（用户手动操作）调的是同一批纯函数，
 * 所以「agent 能做的」和「用户能做的」不会各写一份、慢慢分叉。
 *
 * 全部不可变：输入的 Deck 不改，返回新 Deck（编辑器的撤销栈直接存快照，未改动的页 / 元素引用不变，
 * 缩略图靠引用相等跳过重画）。页号一律 **1 起**（用户说「第 3 页」），内部下标是 页号 - 1。
 */
import {
  CANVAS_SIZE,
  DECK_MAX_SLIDES,
  ElementError,
  SLIDE_MAX_ELEMENTS,
  normalizeBackground,
  normalizeElement,
  normalizeSlide,
  newId,
  richTextToPlain,
  type Aspect,
  type Deck,
  type DeckTheme,
  type ImageElement,
  type NormalizeContext,
  type Slide,
  type SlideElement,
} from "./slides.ts";

export class DeckOpError extends Error {}

export function ctxOf(deck: Deck): NormalizeContext {
  return { canvas: CANVAS_SIZE[deck.aspect], theme: deck.theme };
}

export function createDeck(input: { title: string; aspect?: Aspect; theme?: DeckTheme }): Deck {
  return {
    version: 1,
    title: input.title.slice(0, 200),
    aspect: input.aspect ?? "16:9",
    ...(input.theme === undefined ? {} : { theme: input.theme }),
    slides: [{ id: newId(), elements: [] }],
  };
}

export function blankSlide(): Slide {
  return { id: newId(), elements: [] };
}

function slideAt(deck: Deck, page: number): { slide: Slide; index: number } {
  if (!Number.isInteger(page) || page < 1 || page > deck.slides.length) {
    throw new DeckOpError(`没有第 ${String(page)} 页（共 ${deck.slides.length} 页，页号从 1 起）`);
  }
  return { slide: deck.slides[page - 1] as Slide, index: page - 1 };
}

function withSlide(deck: Deck, index: number, slide: Slide): Deck {
  return { ...deck, slides: deck.slides.map((each, i) => (i === index ? slide : each)) };
}

// ─── 写页 ───────────────────────────────────────────────────────────────

export interface WriteEntry {
  /** 页号（1 起）或 "append"；缺省 = append */
  at?: number | "append";
  /** 给了就整页替换元素；缺省 = 保留原元素（只改背景 / 备注） */
  elements?: unknown[];
  background?: string;
  notes?: string;
}

export interface WriteResult {
  deck: Deck;
  /** 被写到的页（1 起，写完后的页号） */
  pages: number[];
  warnings: string[];
}

/**
 * 新增或整页替换。`at` 超出「末页 + 1」报错（不悄悄追加到别处）。
 * 单页里一个元素不合格会抛 ElementError 带上页号，让 agent 能对着改；不整页吞掉。
 */
export function applyWrite(deck: Deck, entries: readonly WriteEntry[]): WriteResult {
  let next = deck;
  const pages: number[] = [];
  const warnings: string[] = [];
  entries.forEach((entry, entryIndex) => {
    const at = entry.at ?? "append";
    const ctx = ctxOf(next);
    const append = at === "append" || (typeof at === "number" && at === next.slides.length + 1);
    if (append && next.slides.length >= DECK_MAX_SLIDES) throw new DeckOpError(`页数已到上限 ${DECK_MAX_SLIDES}`);
    const existing = append ? null : slideAt(next, at as number);
    if (entry.elements !== undefined && entry.elements.length > SLIDE_MAX_ELEMENTS) {
      throw new DeckOpError(`单页最多 ${SLIDE_MAX_ELEMENTS} 个元素`);
    }
    const label = `slides[${entryIndex}]`;
    let slide: Slide;
    try {
      const base: Slide = existing?.slide ?? blankSlide();
      const merged = normalizeSlide(
        {
          id: base.id,
          elements: entry.elements ?? base.elements,
          background: entry.background ?? base.background,
          notes: entry.notes ?? base.notes,
        },
        ctx,
        warnings,
      );
      // normalizeSlide 对坏元素是「丢弃 + 警告」；写入口要严格：有警告就当错误告诉 agent
      slide = merged;
    } catch (cause) {
      throw new DeckOpError(`${label}：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (entry.elements !== undefined) {
      // 严格校验一遍：丢弃的元素报错而不是静默
      entry.elements.forEach((element, elementIndex) => {
        try {
          normalizeElement(element, ctx);
        } catch (cause) {
          throw new DeckOpError(`${label}.elements[${elementIndex}]：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      });
    }
    if (existing === null) {
      next = { ...next, slides: [...next.slides, slide] };
      pages.push(next.slides.length);
    } else {
      next = withSlide(next, existing.index, slide);
      pages.push(existing.index + 1);
    }
  });
  // 严格校验后 normalizeSlide 记的「已忽略」警告不会再出现（抛了），清掉避免误导
  return { deck: next, pages, warnings: warnings.filter((w) => !w.includes("已忽略")) };
}

// ─── 改页 ───────────────────────────────────────────────────────────────

export type EditOp =
  | { op: "patch"; slide: number; id: string; patch: Record<string, unknown> }
  | { op: "add"; slide: number; element: unknown }
  | { op: "delete"; slide: number; id: string }
  | { op: "set_slide"; slide: number; background?: string; notes?: string }
  | { op: "delete_slide"; slide: number }
  | { op: "move_slide"; slide: number; to: number }
  | { op: "set_deck"; title?: string; aspect?: Aspect; theme?: DeckTheme };

export interface EditResult {
  deck: Deck;
  /** 受影响的页（1 起，改完后的页号） */
  pages: number[];
}

function findElement(slide: Slide, id: string, page: number): { element: SlideElement; index: number } {
  const index = slide.elements.findIndex((element) => element.id === id);
  if (index < 0) {
    const ids = slide.elements.map((element) => element.id).join(", ");
    throw new DeckOpError(`第 ${page} 页没有元素 ${id}（现有：${ids === "" ? "无" : ids}）`);
  }
  return { element: slide.elements[index] as SlideElement, index };
}

/** 元素打补丁：kind 与 id 不可改；补丁并进去后整个元素重新规整，所以非法值一定被拦 */
export function patchElement(deck: Deck, element: SlideElement, patch: Record<string, unknown>): SlideElement {
  const forbidden = ["id", "kind"].filter((key) => key in patch);
  if (forbidden.length > 0) throw new DeckOpError(`不能改元素的 ${forbidden.join(" / ")}`);
  return normalizeElement({ ...element, ...patch, id: element.id, kind: element.kind }, ctxOf(deck));
}

export function applyEdit(deck: Deck, ops: readonly EditOp[]): EditResult {
  let next = deck;
  const pages = new Set<number>();
  for (const op of ops) {
    switch (op.op) {
      case "patch": {
        const { slide, index } = slideAt(next, op.slide);
        const found = findElement(slide, op.id, op.slide);
        const patched = patchElement(next, found.element, op.patch);
        next = withSlide(next, index, {
          ...slide,
          elements: slide.elements.map((each, i) => (i === found.index ? patched : each)),
        });
        pages.add(op.slide);
        break;
      }
      case "add": {
        const { slide, index } = slideAt(next, op.slide);
        if (slide.elements.length >= SLIDE_MAX_ELEMENTS) throw new DeckOpError(`单页最多 ${SLIDE_MAX_ELEMENTS} 个元素`);
        const element = normalizeElement(op.element, ctxOf(next));
        next = withSlide(next, index, { ...slide, elements: [...slide.elements, element] });
        pages.add(op.slide);
        break;
      }
      case "delete": {
        const { slide, index } = slideAt(next, op.slide);
        const found = findElement(slide, op.id, op.slide);
        next = withSlide(next, index, { ...slide, elements: slide.elements.filter((_, i) => i !== found.index) });
        pages.add(op.slide);
        break;
      }
      case "set_slide": {
        const { slide, index } = slideAt(next, op.slide);
        const background = op.background === undefined ? slide.background : normalizeBackground(op.background);
        const notes = op.notes === undefined ? slide.notes : op.notes;
        const { background: _b, notes: _n, ...rest } = slide;
        next = withSlide(next, index, {
          ...rest,
          ...(background === undefined ? {} : { background }),
          ...(notes === undefined || notes === "" ? {} : { notes }),
        });
        pages.add(op.slide);
        break;
      }
      case "delete_slide": {
        const { index } = slideAt(next, op.slide);
        if (next.slides.length <= 1) throw new DeckOpError("至少保留一页");
        next = { ...next, slides: next.slides.filter((_, i) => i !== index) };
        pages.clear();
        break;
      }
      case "move_slide": {
        const { index } = slideAt(next, op.slide);
        slideAt(next, op.to);
        next = { ...next, slides: moveItem(next.slides, index, op.to - 1) };
        pages.add(op.to);
        break;
      }
      case "set_deck": {
        next = {
          ...next,
          ...(op.title === undefined ? {} : { title: op.title.slice(0, 200) }),
          ...(op.aspect === undefined ? {} : { aspect: op.aspect }),
          ...(op.theme === undefined ? {} : { theme: op.theme }),
        };
        break;
      }
    }
  }
  return { deck: next, pages: [...pages].sort((a, b) => a - b) };
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  if (item === undefined) return copy;
  copy.splice(Math.max(0, Math.min(copy.length, to)), 0, item);
  return copy;
}

// ─── 插图 ───────────────────────────────────────────────────────────────

export interface ImagePlacement {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fit?: "cover" | "contain";
  alt?: string;
}

/**
 * 在第 page 页放一张图。没给尺寸：按图片原始比例放一个「不超过半幅画布」的框，居中。
 * naturalW/H 缺席（读不出尺寸）时放一个 4:3 的框——能显示，用户再拉。
 */
export function insertImage(
  deck: Deck,
  page: number,
  src: string,
  natural: { w: number; h: number } | null,
  placement: ImagePlacement = {},
): { deck: Deck; element: ImageElement } {
  const { slide, index } = slideAt(deck, page);
  const canvas = CANVAS_SIZE[deck.aspect];
  const ratio = natural !== null && natural.w > 0 && natural.h > 0 ? natural.w / natural.h : 4 / 3;
  let w = placement.w;
  let h = placement.h;
  if (w === undefined && h === undefined) {
    const maxW = canvas.w * 0.5;
    const maxH = canvas.h * 0.6;
    w = Math.min(maxW, maxH * ratio);
    h = w / ratio;
  } else if (w === undefined) {
    w = (h as number) * ratio;
  } else if (h === undefined) {
    h = w / ratio;
  }
  const x = placement.x ?? (canvas.w - (w as number)) / 2;
  const y = placement.y ?? (canvas.h - (h as number)) / 2;
  const element = normalizeElement(
    { kind: "image", src, x, y, w, h, fit: placement.fit ?? "contain", ...(placement.alt === undefined ? {} : { alt: placement.alt }) },
    ctxOf(deck),
  ) as ImageElement;
  return { deck: withSlide(deck, index, { ...slide, elements: [...slide.elements, element] }), element };
}

// ─── 摘要（slides_read） ────────────────────────────────────────────────

function elementLine(element: SlideElement): string {
  const geo = `x=${Math.round(element.x)} y=${Math.round(element.y)} w=${Math.round(element.w)} h=${Math.round(element.h)}`;
  switch (element.kind) {
    case "text": {
      const plain = richTextToPlain(element.html).replace(/\s+/g, " ").trim();
      const text = plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
      return `text id=${element.id} ${geo} size=${element.fontSize} "${text}"`;
    }
    case "image":
      return `image id=${element.id} ${geo} src=${element.src} fit=${element.fit}`;
    case "table":
      return `table id=${element.id} ${geo} ${element.rows.length}×${element.rows[0]?.length ?? 0} header=${element.header} first-row=${JSON.stringify(element.rows[0] ?? [])}`;
    case "shape":
      return `shape id=${element.id} ${element.shape} ${geo} fill=${element.fill}${element.text === undefined ? "" : ` text="${element.text.slice(0, 40)}"`}`;
    case "line":
      return `line id=${element.id} ${geo} points=${JSON.stringify(element.points)} startArrow=${element.startArrow} endArrow=${element.endArrow}`;
  }
}

/** 给模型看的文本摘要：页数、每页元素（kind / 位置 / 文字前 80 字）、备注。page = 只看那一页 */
export function summarizeDeck(deck: Deck, page?: number): string {
  const canvas = CANVAS_SIZE[deck.aspect];
  const head = `Deck "${deck.title}" · ${deck.aspect} (canvas ${canvas.w}×${canvas.h}) · ${deck.slides.length} slide(s)`;
  const pages = page === undefined ? deck.slides.map((_, i) => i + 1) : [slideAt(deck, page).index + 1];
  const body = pages.map((n) => {
    const slide = deck.slides[n - 1] as Slide;
    const lines = [`Slide ${n} id=${slide.id}${slide.background === undefined ? "" : ` background=${slide.background}`} · ${slide.elements.length} element(s)`];
    for (const element of slide.elements) lines.push(`  - ${elementLine(element)}`);
    if (slide.notes !== undefined) lines.push(`  notes: ${JSON.stringify(slide.notes.length > 300 ? `${slide.notes.slice(0, 300)}…` : slide.notes)}`);
    return lines.join("\n");
  });
  return [head, ...body].join("\n");
}

/** 一页的标题（缩略图说明、引用芯片、卡的副标题）：第一个有字的文字元素的第一行 */
export function slideTitle(slide: Slide): string {
  for (const element of slide.elements) {
    if (element.kind === "text") {
      const line = richTextToPlain(element.html).split("\n").find((l) => l.trim() !== "");
      if (line !== undefined) return line.trim().slice(0, 60);
    }
  }
  return "";
}

// ─── 编辑器用的小函数（同一处真源） ─────────────────────────────────────

export function addSlide(deck: Deck, afterIndex: number | null): { deck: Deck; index: number } {
  if (deck.slides.length >= DECK_MAX_SLIDES) throw new DeckOpError(`页数已到上限 ${DECK_MAX_SLIDES}`);
  const at = afterIndex === null ? deck.slides.length : afterIndex + 1;
  const slides = [...deck.slides];
  slides.splice(at, 0, blankSlide());
  return { deck: { ...deck, slides }, index: at };
}

/** 复制页：元素 id 全部换新（页内 id 唯一的前提不依赖页间） */
export function duplicateSlide(deck: Deck, index: number): { deck: Deck; index: number } {
  const source = deck.slides[index];
  if (source === undefined) return { deck, index };
  const copy: Slide = { ...source, id: newId(), elements: source.elements.map((element) => ({ ...element, id: newId() })) };
  const slides = [...deck.slides];
  slides.splice(index + 1, 0, copy);
  return { deck: { ...deck, slides }, index: index + 1 };
}

export function updateElements(
  deck: Deck,
  slideId: string,
  update: (element: SlideElement) => SlideElement,
  ids: ReadonlySet<string>,
): Deck {
  return {
    ...deck,
    slides: deck.slides.map((slide) =>
      slide.id !== slideId
        ? slide
        : { ...slide, elements: slide.elements.map((element) => (ids.has(element.id) ? update(element) : element)) },
    ),
  };
}

export function removeElements(deck: Deck, slideId: string, ids: ReadonlySet<string>): Deck {
  return {
    ...deck,
    slides: deck.slides.map((slide) =>
      slide.id !== slideId ? slide : { ...slide, elements: slide.elements.filter((element) => !ids.has(element.id)) },
    ),
  };
}

export function appendElements(deck: Deck, slideId: string, elements: readonly SlideElement[]): Deck {
  return {
    ...deck,
    slides: deck.slides.map((slide) =>
      slide.id !== slideId ? slide : { ...slide, elements: [...slide.elements, ...elements].slice(0, SLIDE_MAX_ELEMENTS) },
    ),
  };
}

export { ElementError };

// ─── 写完后的体检（回给 agent，让它自己修） ─────────────────────────────

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 估算一段文字在宽 width 的框里要多高（px）：CJK 字宽 ≈ 字号，拉丁 ≈ 0.55 字号，行高 1.25 */
export function estimateTextHeight(plain: string, fontSize: number, width: number): number {
  const usable = Math.max(width, fontSize);
  let lines = 0;
  for (const line of plain.split("\n")) {
    let used = 0;
    let count = 1;
    for (const ch of line) {
      const step = CJK_CHAR.test(ch) ? fontSize : fontSize * 0.55;
      if (used + step > usable) {
        count += 1;
        used = step;
      } else used += step;
    }
    lines += count;
  }
  return lines * fontSize * 1.25;
}

/**
 * 一页的体检：文字溢出框、元素伸出画布。只报**大概率是问题**的（宽松阈值，免得吓到模型反复改），
 * 每条带页号与元素 id，模型能直接 slides_edit 修。
 */
export function lintSlide(deck: Deck, page: number): string[] {
  const slide = deck.slides[page - 1];
  if (slide === undefined) return [];
  const canvas = CANVAS_SIZE[deck.aspect];
  const out: string[] = [];
  for (const element of slide.elements) {
    if (element.kind === "text") {
      const need = estimateTextHeight(richTextToPlain(element.html), element.fontSize, element.w);
      if (need > element.h * 1.15 + 4) {
        out.push(`slide ${page}: text ${element.id} probably overflows its box (needs ≈${Math.round(need)}px, box h=${Math.round(element.h)}) — enlarge h, shorten the text or reduce fontSize`);
      }
    }
    const right = element.x + element.w;
    const bottom = element.y + element.h;
    if (element.kind !== "line" && (element.x < -4 || element.y < -4 || right > canvas.w + 4 || bottom > canvas.h + 4)) {
      out.push(`slide ${page}: ${element.kind} ${element.id} extends past the ${canvas.w}×${canvas.h} canvas (x=${Math.round(element.x)} y=${Math.round(element.y)} right=${Math.round(right)} bottom=${Math.round(bottom)})`);
    }
  }
  return out;
}
