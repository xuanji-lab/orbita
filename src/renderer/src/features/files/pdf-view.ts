/**
 * PDF 预览的纯函数（实验功能「PDF 引用」）：页面适宽缩放、引用在文本层上的定位、
 * 高亮矩形的按行合并。PdfView.tsx 连 pdf.js 与 DOM，这里不碰——`node --test` 直接可测。
 */
import {
  findQuote,
  indexPageText,
  normalizeQuote,
  sourceSpan,
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

/**
 * SyncTeX 落点 → 渲染坐标（CSS px）。契约里的矩形是 PDF 点（1/72 英寸、左上原点），
 * 页面元素按 `fitScale` 缩放渲染，scale = 1 时 1 点正好是 1 CSS px（pdf.js 的
 * viewport(width, height) 就是页面点尺寸），所以这里只乘缩放、不换单位。
 * 返回的就是覆盖层的 inline style —— 不要把 scale 乘两遍（PdfPage 的
 * `--total-scale-factor` 只喂给文本层，不作用于这个覆盖元素）。
 */
export function syncRectStyle(
  rect: { left: number; top: number; width: number; height: number },
  scale: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.left * scale,
    top: rect.top * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * 页面上的一次点击（视口 client 坐标）→ PDF 点（左上原点）。
 * `page` 是那一页的 getBoundingClientRect()，`scale` 是它的渲染缩放。
 * 页面外 / 缩放为 0 时回 null：那种点击不该拿去反查（synctex 会用最近的记录
 * 给一个看似正确的答案，比没反应更误导）。
 */
export function clickToPdfPoint(
  page: { left: number; top: number; width: number; height: number },
  scale: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!(scale > 0) || !(page.width > 0) || !(page.height > 0)) return null;
  const x = (clientX - page.left) / scale;
  const y = (clientY - page.top) / scale;
  if (x < 0 || y < 0 || x > page.width / scale || y > page.height / scale) return null;
  return { x, y };
}
