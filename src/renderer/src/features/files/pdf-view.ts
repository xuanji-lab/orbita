/**
 * PDF 预览的纯函数（实验功能「PDF 引用」）：页面适宽缩放、引用在文本层上的定位、
 * 高亮矩形的按行合并。PdfView.tsx 连 pdf.js 与 DOM，这里不碰——`node --test` 直接可测。
 */
import {
  findQuote,
  indexPageText,
  normalizeQuote,
  sourceSpan,
  type PageTextIndex,
  type PdfCitation,
  type SourceSpan,
} from "../../../../shared/pdf-quote.ts";

/** 页面四周留白（px）：页与面板边缘、页与页之间 */
export const PDF_PAGE_GAP = 12;

/** 缩放上下限：再小字就糊成一片，再大一页要横向滚好几屏 */
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

/** 适宽缩放：页宽（pt，scale 1 的视口宽）撑满可用宽度，两侧各留一个间隙 */
export function fitScale(containerWidth: number, pageWidth: number): number {
  if (!(containerWidth > 0) || !(pageWidth > 0)) return 1;
  const raw = (containerWidth - PDF_PAGE_GAP * 2) / pageWidth;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, raw));
}

/**
 * 引用在本页文本层上的源区间。先信记录里的偏移（同版本 pdf.js 下归一化串逐字相同）——
 * 偏移处的归一化文字与引文对得上才用；对不上（文件改过、pdf.js 升级）就在本页按原文
 * 重搜。`items` 是文本层的条目串（TextLayer.textContentItemsStr，与 DOM span 一一对应）。
 */
export function locateCitation(items: readonly string[], citation: PdfCitation): SourceSpan | null {
  const index = indexPageText(items.map((str) => ({ str })));
  const want = normalizeQuote(citation.text);
  if (index.norm.slice(citation.start, citation.end) === want) {
    return sourceSpan(index, citation.start, citation.end);
  }
  const hit = findQuote([index], citation.text);
  if (hit.kind !== "exact" && hit.kind !== "approximate") return null;
  return sourceSpan(index, hit.start, hit.end);
}

/** 相对页面左上角的矩形（px） */
export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 同一行的碎矩形合并成一条：pdf.js 的文本层一个条目一个 span，一行里常有好几段，
 * 逐段画会在字间留缝、叠加处颜色加深。判同行：纵向重叠超过较矮者的一半；
 * 只合并横向相接或相隔不超过一个行高的段（双栏的左右两栏不会被连成一条）。
 */
export function mergeLineRects(rects: readonly PageRect[]): PageRect[] {
  const out: PageRect[] = [];
  for (const rect of rects) {
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    let merged: PageRect = { ...rect };
    // 新段可能把此前两段连起来（先右后左地到达），所以并入后继续找，直到没有可并的
    for (let i = 0; i < out.length; ) {
      const other = out[i]!;
      const overlap =
        Math.min(other.top + other.height, merged.top + merged.height) - Math.max(other.top, merged.top);
      const sameLine = overlap > Math.min(other.height, merged.height) / 2;
      // 双向间隙：谁在左都一样量；重叠时为负
      const gap = Math.max(merged.left - (other.left + other.width), other.left - (merged.left + merged.width));
      if (sameLine && gap <= Math.max(other.height, merged.height)) {
        const left = Math.min(other.left, merged.left);
        const top = Math.min(other.top, merged.top);
        const right = Math.max(other.left + other.width, merged.left + merged.width);
        const bottom = Math.max(other.top + other.height, merged.top + merged.height);
        merged = { left, top, width: right - left, height: bottom - top };
        out.splice(i, 1);
        i = 0;
        continue;
      }
      i += 1;
    }
    out.push(merged);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

/* ------------------------------------------------------------------------- *
 * 缩放 · 翻页 · 搜索 · 缩略图偏好（L2）
 *
 * 这一层的约定：**一切以「页在滚动内容里的几何」算**，不读 DOM。理由是同一份
 * 数字要回答四个问题——当前在第几页、跳页该滚到哪、Ctrl+滚轮之后页面高了多少、
 * 缩略图点哪一张——四个地方各自量一遍 DOM 迟早会分叉。缩放比例、页间间隙、
 * 顶部留白是唯一输入，节点位置由它们派生。
 * ------------------------------------------------------------------------- */

/** 缩放档：适宽 / 适页 / 自定义百分比 */
export type PdfZoomMode = "fit-width" | "fit-page" | "custom";

/**
 * 100% 的基准：CSS px per PDF pt。96 dpi ÷ 72 pt/in = 4/3，与 pdf.js 自己的
 * CSS_UNITS 同一个数——否则「100%」在阅读器里会与其它 PDF 阅读器差一截。
 */
export const PDF_ZOOM_UNIT = 4 / 3;

/** 自定义缩放的区间与步长（Ctrl+滚轮与 ± 键共用） */
export const PDF_PERCENT_MIN = 50;
export const PDF_PERCENT_MAX = 400;
export const PDF_PERCENT_STEP = 10;

/**
 * 一页在滚动内容里的位置。**top 以第一页的顶端为 0，由 DOM 实测**（PdfView 读
 * `.pdf-page` 的 offsetTop / offsetHeight）。
 *
 * 为什么不是「页高 × 缩放」算出来的：fit-width 的比例是逐页的实数（45.3%），
 * 页高乘出来带小数，87 页累加能差出 40 像素——跳页时算出的 scrollTop 落在
 * 上一页末尾附近，页码就显示成前一页（真机实测 88 → 87）。浏览器排版完的
 * offsetTop 是最终事实，纯函数只负责在它上面做判断。
 */
export interface PageBox {
  /** 第一页顶端为 0 */
  top: number;
  height: number;
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(PDF_PERCENT_MAX, Math.max(PDF_PERCENT_MIN, Math.round(percent)));
}

/** 缩放比例 → 界面上的百分比（四舍五入） */
export function percentOfScale(scale: number): number {
  return Math.round((scale / PDF_ZOOM_UNIT) * 100);
}

/** 百分比 → 缩放比例（先夹区间：界面里的数字与真正画的尺寸必须同一个值） */
export function scaleOfPercent(percent: number): number {
  return (clampPercent(percent) / 100) * PDF_ZOOM_UNIT;
}

/** 一次 ± 一档（Ctrl+滚轮一格、点一次 ± 都是它）；到头就停在端点，不回绕 */
export function stepPercent(percent: number, direction: 1 | -1): number {
  return clampPercent(clampPercent(percent) + direction * PDF_PERCENT_STEP);
}

/**
 * 适页：把文档里**最大的一页**（宽与高分别取最大）整个塞进可用区域。
 *
 * 不用「每页自己的尺寸」：混排尺寸的 PDF（封面、插页）会让每页宽度各不相同，
 * 滚动时页面左右跳。取一页作参考，所有页同一个比例。
 */
export function fitPageScale(
  containerWidth: number,
  containerHeight: number,
  pageWidth: number,
  pageHeight: number,
): number {
  if (!(containerWidth > 0) || !(containerHeight > 0) || !(pageWidth > 0) || !(pageHeight > 0)) return 1;
  const raw = Math.min(
    (containerWidth - PDF_PAGE_GAP * 2) / pageWidth,
    (containerHeight - PDF_PAGE_GAP * 2) / pageHeight,
  );
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, raw));
}

/**
 * scrollTop → 当前页（1 基）。取「顶边已经越过**参考线**」的最后一页。
 *
 * `lead` 是参考线在视口内的高度（调用方传视口高度的 1/4）。为什么不是精确的视口
 * 上沿：搜索命中与引用高亮会被滚到「视口上部三分之一」，那时目标页的顶端其实在
 * 视口上沿之下几十像素，视口顶部还是上一页的下边缘——按上沿判会把页码显示成上一页
 * （实测：跳到第 100 页、命中在页首，页码却停在 99）。四分之一处是阅读时真正的
 * 「视线落点」，与 PDF.js 自己的做法一致。
 *
 * 1 像素的容差吃掉亚像素滚动位置（触控板 / 高 DPI 上 scrollTop 可以带小数）。
 */
export function currentPageOf(boxes: readonly PageBox[], scrollTop: number, lead = 0): number {
  let current = 1;
  for (let index = 0; index < boxes.length; index += 1) {
    if ((boxes[index]?.top ?? 0) <= scrollTop + lead + 1) current = index + 1;
    else break;
  }
  return current;
}

/** 跳到第 page 页时该设的 scrollTop（第一页顶端为 0）；越界夹到首尾 */
export function scrollTopForPage(boxes: readonly PageBox[], page: number, offset = 0): number {
  if (boxes.length === 0) return 0;
  const index = Math.min(boxes.length - 1, Math.max(0, Math.round(page) - 1));
  return Math.max(0, (boxes[index]?.top ?? 0) - offset);
}

/** 一页里的一处命中：归一化串上的 [start, end)（与引用高亮同一把尺子） */
export interface PdfMatch {
  start: number;
  end: number;
}

/** 单页命中上限：坏文档里搜一个字母会有上万处，画出来只会把页面糊住 */
const MAX_MATCHES_PER_PAGE = 500;

/**
 * 一页里的所有命中。**大小写、空白、标点都不敏感**：查询与页面文本走同一套
 * `normalizeQuote`（只留字母/数字/组合符，NFKC + 小写），所以「Double  Buffering」
 * 能命中跨行断开的 "double buf-fering"，中文里的全角空格也不会挡路。
 * 归一化后为空的查询（纯标点）直接回空，不做「匹配一切」。
 */
export function searchPageItems(items: readonly string[], query: string): PdfMatch[] {
  return searchIndex(indexPageText(items.map((str) => ({ str }))), query);
}

/** 同上，但对着已经建好的页索引搜（搜索语料只建一次，查询换一个不该重建索引） */
export function searchIndex(index: PageTextIndex, query: string): PdfMatch[] {
  const want = normalizeQuote(query);
  if (want === "") return [];
  const out: PdfMatch[] = [];
  let from = 0;
  while (out.length < MAX_MATCHES_PER_PAGE) {
    const at = index.norm.indexOf(want, from);
    if (at < 0) break;
    out.push({ start: at, end: at + want.length });
    // 不重叠推进：搜 "aa" 在 "aaaa" 里命中两处，不是三处
    from = at + want.length;
  }
  return out;
}

/**
 * 搜索落定后默认选中哪一处：从读者正在看的那一页往后找第一处命中，找不到再从头来。
 * 全篇从第一页开始选会让「搜一个术语」的人被拽回封面。
 */
export function firstMatchFrom(counts: readonly number[], page: number): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return -1;
  const start = Math.min(Math.max(1, Math.round(page)), Math.max(1, counts.length));
  let index = 0;
  for (let p = 0; p < counts.length; p += 1) {
    const count = counts[p] ?? 0;
    if (p >= start - 1 && count > 0) return index;
    index += count;
  }
  return 0;
}

/** 每页命中数（界面上的 n/m 与页旁小计都从它派生） */
export function matchCounts(perPage: readonly (readonly PdfMatch[])[]): number[] {
  return perPage.map((matches) => matches.length);
}

/**
 * 在**全局命中序号**上移动一步。`current = -1` 表示还没有选中（刚搜完）：
 * 往下走取第一处，往上走取最后一处（与浏览器查找一致）。
 */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
  const next = current + direction;
  if (next < 0) return total - 1;
  if (next >= total) return 0;
  return next;
}

/**
 * 全局第 index 处命中落在哪一页的第几处（都从 0/1 起）。`counts` 是每页命中数。
 * 越界回 null——搜索语料与页面文本层可能不同步（文件刚被重写），调用方据此
 * 放弃这一处高亮，而不是画到别的页上。
 */
export function locateMatch(
  counts: readonly number[],
  index: number,
): { page: number; ordinal: number } | null {
  if (index < 0) return null;
  let remaining = index;
  for (let page = 0; page < counts.length; page += 1) {
    const count = counts[page] ?? 0;
    if (remaining < count) return { page: page + 1, ordinal: remaining };
    remaining -= count;
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * 预览偏好：缩放档与缩略图侧栏的收起状态要跨标签、跨重启记住
 * ------------------------------------------------------------------------- */

export interface PdfViewPrefs {
  zoom: PdfZoomMode;
  /** 自定义档的百分比（适宽/适页时也记着，切回来就是上一次的值） */
  percent: number;
  /** 缩略图侧栏是否展开 */
  thumbnails: boolean;
}

/** localStorage 键。**渲染层本地偏好**：与哪台机器无关、不进 settings.json */
export const PDF_PREFS_KEY = "orbita.pdf.view";

export const DEFAULT_PDF_PREFS: PdfViewPrefs = { zoom: "fit-width", percent: 100, thumbnails: false };

/** 存储里的脏值逐项退回默认：一个坏掉的 percent 不该让预览打不开 */
export function parsePdfPrefs(raw: string | null): PdfViewPrefs {
  if (raw === null) return { ...DEFAULT_PDF_PREFS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PDF_PREFS };
  }
  if (typeof value !== "object" || value === null) return { ...DEFAULT_PDF_PREFS };
  const record = value as Record<string, unknown>;
  const zoom = record["zoom"];
  return {
    zoom: zoom === "fit-width" || zoom === "fit-page" || zoom === "custom" ? zoom : DEFAULT_PDF_PREFS.zoom,
    percent:
      typeof record["percent"] === "number" ? clampPercent(record["percent"]) : DEFAULT_PDF_PREFS.percent,
    thumbnails: record["thumbnails"] === true,
  };
}

export function serializePdfPrefs(prefs: PdfViewPrefs): string {
  return JSON.stringify({ zoom: prefs.zoom, percent: clampPercent(prefs.percent), thumbnails: prefs.thumbnails });
}
