/**
 * 演示文稿的数据操作函数 —— **一处真源，两个入口**：
 * agent 的 slides_* 工具与编辑器（用户手动操作）调的是同一批纯函数，
 * 所以「agent 能做的」和「用户能做的」不会各写一份、慢慢分叉。
 *
 * 全部不可变：输入的 Deck 不改，返回新 Deck（编辑器的撤销栈直接存快照，未改动的页 / 元素引用不变，
 * 缩略图靠引用相等跳过重画）。页号一律 **1 起**（用户说「第 3 页」），内部下标是 页号 - 1。
 */
import { DEFAULT_SHAPE_FILL, DEFAULT_SHAPE_STROKE, SLIDE_DEFAULT_TEXT, SLIDE_TABLE_BORDER, SLIDE_TABLE_HEADER_FILL } from "./slides-palette.ts";
import {
  CANVAS_SIZE,
  DECK_MAX_SLIDES,
  ElementError,
  SLIDE_MAX_ELEMENTS,
  normalizeBackgroundBound,
  normalizeElement,
  normalizeSlide,
  newId,
  plainToRichHtml,
  richTextToPlain,
  type Aspect,
  type Deck,
  type DeckTheme,
  type ImageElement,
  type LineElement,
  type NormalizeContext,
  type Slide,
  type SlideElement,
} from "./slides.ts";
import { buildLayout, isLayoutName, LAYOUT_NAMES, LayoutError, type LayoutImage } from "./slides-layouts.ts";
import { estimateTextHeight } from "./slides-measure.ts";
import { BINDABLE_FIELDS, DEFAULT_THEME_ID, presetTheme, resolveTheme, tokenName, tokenValue, type BindField, type ElementBindings } from "./slides-theme.ts";

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
  /** 给了就整页替换元素；缺省 = 保留原元素（只改背景 / 备注）。与 layout 二选一 */
  elements?: unknown[];
  /** 版式名（slides-layouts）+ 内容槽位：由版式落成元素，不用给坐标 */
  layout?: string;
  slots?: Record<string, unknown>;
  /** 版式里的图片槽位 → 已落进 assets 的图（工具层先处理 "attached" / 路径） */
  images?: Readonly<Record<string, LayoutImage | undefined>>;
  /** css 颜色或 `$token`（`$surface`、`$accent`…） */
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
    const append = at === "append" || (typeof at === "number" && at === next.slides.length + 1);
    if (append && next.slides.length >= DECK_MAX_SLIDES) throw new DeckOpError(`页数已到上限 ${DECK_MAX_SLIDES}`);
    const existing = append ? null : slideAt(next, at as number);
    const pageNo = existing === null ? next.slides.length + 1 : existing.index + 1;
    if (entry.elements !== undefined && entry.elements.length > SLIDE_MAX_ELEMENTS) {
      throw new DeckOpError(`单页最多 ${SLIDE_MAX_ELEMENTS} 个元素`);
    }
    const label = `slides[${entryIndex}]`;
    // 版式：先落成元素。没有主题的老文稿第一次写版式页时补上默认主题（版式的颜色 / 字号都是 token，没有主题没处解析）
    let elements = entry.elements;
    let background = entry.background;
    let layout: string | undefined;
    let footer: Slide["footer"];
    if (entry.layout !== undefined) {
      if (entry.elements !== undefined) throw new DeckOpError(`${label}: give either layout + slots or elements, not both`);
      if (!isLayoutName(entry.layout)) throw new DeckOpError(`${label}: unknown layout "${entry.layout}" (available: ${LAYOUT_NAMES.join(", ")})`);
      if (next.theme === undefined || next.theme.palette === undefined) {
        next = { ...next, theme: presetTheme(next.theme?.id ?? DEFAULT_THEME_ID) as DeckTheme };
      }
      try {
        const built = buildLayout({ layout: entry.layout, slots: entry.slots ?? {}, aspect: next.aspect, theme: next.theme, ...(entry.images === undefined ? {} : { images: entry.images }) }, `slide ${pageNo}`);
        elements = built.elements;
        background = background ?? built.background;
        footer = built.footer;
        layout = entry.layout;
        warnings.push(...built.warnings);
      } catch (cause) {
        if (cause instanceof LayoutError) throw new DeckOpError(`${label}: ${cause.message}`);
        throw cause;
      }
    }
    const ctx = ctxOf(next);
    let slide: Slide;
    try {
      const base: Slide = existing?.slide ?? blankSlide();
      // 只改背景 / 备注时，页的版式名 / 页脚 / 背景绑定要带过去；整页换元素则版式名作废（手写元素不再是那个版式）
      const keepShape = entry.elements === undefined && entry.layout === undefined;
      const merged = normalizeSlide(
        {
          id: base.id,
          elements: elements ?? base.elements,
          background: background ?? base.background,
          ...(background === undefined && base.bind !== undefined ? { bind: base.bind } : {}),
          layout: layout ?? (keepShape ? base.layout : undefined),
          footer: footer ?? base.footer,
          notes: entry.notes ?? base.notes,
        },
        ctx,
        warnings,
      );
      slide = merged;
    } catch (cause) {
      throw new DeckOpError(`${label}：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (elements !== undefined) {
      // 严格校验一遍：丢弃的元素报错而不是静默
      elements.forEach((element, elementIndex) => {
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

/**
 * 元素打补丁：kind 与 id 不可改；补丁并进去后整个元素重新规整，所以非法值一定被拦。
 * 补丁里**不是 `$token`** 的可绑定字段（color / fontSize …）= 手动指定具体值 → 拆掉该字段的主题绑定，换主题时它保持不变；
 * 补丁写 `$token` 则（重新）绑定。
 */
export function patchElement(deck: Deck, element: SlideElement, patch: Record<string, unknown>): SlideElement {
  const forbidden = ["id", "kind"].filter((key) => key in patch);
  if (forbidden.length > 0) throw new DeckOpError(`不能改元素的 ${forbidden.join(" / ")}`);
  const bind: ElementBindings = { ...(element.bind ?? {}) };
  for (const key of Object.keys(patch)) {
    if (key in BINDABLE_FIELDS && tokenName(patch[key]) === null) delete bind[key as BindField];
  }
  const { bind: _old, ...rest } = element;
  return normalizeElement({ ...rest, ...patch, ...(Object.keys(bind).length === 0 ? {} : { bind }), id: element.id, kind: element.kind }, ctxOf(deck));
}

/** 编辑器改了元素的某些字段后调：值变了的绑定字段拆掉绑定（手改的值不再跟主题走） */
export function unbindChanged(before: SlideElement, after: SlideElement): SlideElement {
  if (after.bind === undefined) return after;
  const bind: ElementBindings = { ...after.bind };
  let dropped = false;
  for (const field of Object.keys(bind) as BindField[]) {
    if ((before as unknown as Record<string, unknown>)[field] !== (after as unknown as Record<string, unknown>)[field]) {
      delete bind[field];
      dropped = true;
    }
  }
  if (!dropped) return after;
  const { bind: _drop, ...rest } = after;
  return (Object.keys(bind).length === 0 ? rest : { ...rest, bind }) as SlideElement;
}

/**
 * 换主题：只重算「绑定了 token」的颜色 / 字号 / 字体与页背景；手动改过的值（没有绑定）原样保留。
 * 没动的页 / 元素保持引用相等（缩略图靠它跳过重画）。
 */
export function applyTheme(deck: Deck, theme: DeckTheme | undefined): Deck {
  const rt = resolveTheme(theme);
  const slides = deck.slides.map((slide) => {
    let changed = false;
    let background = slide.background;
    const bgToken = slide.bind?.background;
    if (bgToken !== undefined) {
      const value = tokenValue(rt, "fill", bgToken);
      if (typeof value === "string" && value !== background) {
        background = value;
        changed = true;
      }
    }
    const elements = slide.elements.map((element) => {
      if (element.bind === undefined) return element;
      let patched: Record<string, unknown> | null = null;
      for (const [field, token] of Object.entries(element.bind) as [BindField, string][]) {
        const value = tokenValue(rt, field, token);
        if (value !== undefined && (element as unknown as Record<string, unknown>)[field] !== value) {
          patched = patched ?? { ...element };
          patched[field] = value;
        }
      }
      if (patched === null) return element;
      changed = true;
      return patched as unknown as SlideElement;
    });
    return changed ? { ...slide, ...(background === undefined ? {} : { background }), elements } : slide;
  });
  const { theme: _old, ...rest } = deck;
  return { ...rest, ...(theme === undefined ? {} : { theme }), slides };
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
        const bound = op.background === undefined ? undefined : normalizeBackgroundBound(op.background, next.theme);
        const background = op.background === undefined ? slide.background : bound?.color;
        const bindToken = op.background === undefined ? slide.bind?.background : bound?.token;
        const notes = op.notes === undefined ? slide.notes : op.notes;
        const { background: _b, notes: _n, bind: _bind, ...rest } = slide;
        next = withSlide(next, index, {
          ...rest,
          ...(background === undefined ? {} : { background }),
          ...(bindToken === undefined ? {} : { bind: { background: bindToken } }),
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
        };
        if (op.theme !== undefined) next = applyTheme(next, op.theme);
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
      const role = element.bind?.fontSize === undefined ? "" : `($${element.bind.fontSize})`;
      return `text id=${element.id} ${geo} size=${element.fontSize}${role} "${text}"`;
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
  const themeNote = deck.theme?.id === undefined ? "" : ` · theme ${deck.theme.id}`;
  const head = `Deck "${deck.title}" · ${deck.aspect} (canvas ${canvas.w}×${canvas.h})${themeNote} · ${deck.slides.length} slide(s)`;
  const pages = page === undefined ? deck.slides.map((_, i) => i + 1) : [slideAt(deck, page).index + 1];
  const body = pages.map((n) => {
    const slide = deck.slides[n - 1] as Slide;
    const lines = [`Slide ${n} id=${slide.id}${slide.layout === undefined ? "" : ` layout=${slide.layout}`}${slide.background === undefined ? "" : ` background=${slide.background}`} · ${slide.elements.length} element(s)`];
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
        : { ...slide, elements: slide.elements.map((element) => (ids.has(element.id) ? unbindChanged(element, update(element)) : element)) },
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
      const need = estimateTextHeight(richTextToPlain(element.html), element.fontSize, element.w, { lineHeight: element.lineHeight ?? 1.25, letterSpacing: element.letterSpacing ?? 0 });
      if (need > element.h * 1.15 + 4) {
        out.push(`slide ${page}: text ${element.id} probably overflows its box (needs ≈${Math.round(need)}px, box h=${Math.round(element.h)}) — enlarge h, shorten the text or reduce fontSize`);
      }
    }
    const right = element.x + element.w;
    const bottom = element.y + element.h;
    // 没字的色块 / 圆是有意出血的装饰；图片满版也常出血——只管会丢字的元素
    const bleed = (element.kind === "shape" && element.text === undefined);
    if (element.kind !== "line" && !bleed && (element.x < -4 || element.y < -4 || right > canvas.w + 4 || bottom > canvas.h + 4)) {
      out.push(`slide ${page}: ${element.kind} ${element.id} extends past the ${canvas.w}×${canvas.h} canvas (x=${Math.round(element.x)} y=${Math.round(element.y)} right=${Math.round(right)} bottom=${Math.round(bottom)})`);
    }
  }
  return out;
}

// ─── 编辑器新建元素的默认外观（画布 / 粘贴 / 插表格共用，一处真源） ──────

export type DrawTool = "text" | "rect" | "roundRect" | "ellipse" | "triangle" | "line" | "arrow";

export interface DrawBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 线元素：两个端点（画布坐标）→ 框与相对点；框至少 1px 厚 */
export function lineGeometry(a: [number, number], b: [number, number]): Pick<LineElement, "x" | "y" | "w" | "h" | "points"> {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return {
    x,
    y,
    w: Math.max(Math.abs(b[0] - a[0]), 1),
    h: Math.max(Math.abs(b[1] - a[1]), 1),
    points: [[a[0] - x, a[1] - y], [b[0] - x, b[1] - y]],
  };
}

/** 工具画出的新元素：拖出了框就用框，只点了一下就用默认大小 */
export function newDrawnElement(tool: DrawTool, box: DrawBox, textColor: string, dragged: boolean): SlideElement {
  const id = newId();
  switch (tool) {
    case "text":
      return { id, kind: "text", x: box.x, y: box.y, w: dragged ? Math.max(box.w, 80) : 420, h: dragged ? Math.max(box.h, 48) : 80, html: "", fontSize: 32, color: textColor, align: "left", valign: "top" };
    case "line":
    case "arrow":
      return { id, kind: "line", ...lineGeometry([box.x, box.y], [box.x + box.w, box.y + box.h]), startArrow: "none", endArrow: tool === "arrow" ? "arrow" : "none", stroke: textColor, strokeWidth: 5, dash: false };
    default:
      return {
        id,
        kind: "shape",
        shape: tool,
        x: box.x,
        y: box.y,
        w: dragged ? Math.max(box.w, 16) : 240,
        h: dragged ? Math.max(box.h, 16) : tool === "triangle" ? 200 : 160,
        fill: DEFAULT_SHAPE_FILL,
        stroke: DEFAULT_SHAPE_STROKE,
        strokeWidth: 2,
        fontSize: 28,
        color: textColor,
      };
  }
}

/** 居中的 3×3 空表格 */
export function newTableElement(deck: Deck): SlideElement {
  const canvas = CANVAS_SIZE[deck.aspect];
  return {
    id: newId(),
    kind: "table",
    x: (canvas.w - 720) / 2,
    y: (canvas.h - 300) / 2,
    w: 720,
    h: 300,
    rows: [["", "", ""], ["", "", ""], ["", "", ""]],
    header: true,
    fontSize: 24,
    color: deck.theme?.color ?? SLIDE_DEFAULT_TEXT,
    headerFill: SLIDE_TABLE_HEADER_FILL,
    headerColor: "#ffffff",
    borderColor: SLIDE_TABLE_BORDER,
  };
}

/** 粘贴进来的纯文字 → 文字框（每行一段） */
export function newTextBoxFromPlain(text: string, color: string): SlideElement {
  return { id: newId(), kind: "text", x: 80, y: 80, w: 640, h: 160, html: plainToRichHtml(text), fontSize: 28, color, align: "left", valign: "top" };
}
