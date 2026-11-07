/**
 * 演示文稿 → HTML 字符串（无 DOM、无 node 依赖）。
 *
 * **画布、缩略图、播放模式、网页导出、PDF、PNG 共用这一份渲染**：一个元素长什么样只有一处真源，
 * 不会出现「画布里对、导出来歪」。编辑器把每个元素的 `renderElementInner` 塞进自己的 React 节点
 * （选中框 / 手柄是它的兄弟节点，不污染内容），导出把整页拼成 `<section class="sl">`。
 *
 * 这里输出的是**内容**，不是应用界面：颜色是用户在文稿里选的值（经 safeColor 过白名单），
 * 不走设计系统 token——文稿换主题时不该跟着应用的深浅色变。
 */
import {
  CANVAS_SIZE,
  DEFAULT_BACKGROUND,
  DEFAULT_FONT_FAMILY,
  escapeHtml,
  type Deck,
  type ImageElement,
  type LineElement,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableElement,
  type TextElement,
} from "./slides.ts";

export interface RenderContext {
  deck: Pick<Deck, "aspect" | "theme" | "title">;
  /** 资源路径 → 可加载的 URL；null = 找不到（画占位） */
  imageUrl(src: string): string | null;
}

/** 页容器与元素的基础样式。渲染层注入一次，网页导出内联 */
export const SLIDE_CSS = `
.sl{position:relative;overflow:hidden;box-sizing:border-box;line-height:1.25;-webkit-font-smoothing:antialiased}
.sl *{box-sizing:border-box}
.sl-el{position:absolute}
.sl-text{display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}
.sl-rich{min-height:1em;white-space:pre-wrap}
.sl-rich ul,.sl-rich ol{margin:0;padding-left:1.3em}
.sl-rich li{margin:0}
.sl-table{width:100%;height:100%;border-collapse:collapse;table-layout:fixed}
.sl-table td,.sl-table th{padding:6px 12px;vertical-align:middle;text-align:left;overflow-wrap:anywhere;border-width:1px;border-style:solid}
.sl-table th{font-weight:700}
.sl-svg{display:block;width:100%;height:100%;overflow:visible}
.sl-shape-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:8px 12px;text-align:center;overflow-wrap:anywhere}
.sl-img{display:block;width:100%;height:100%}
.sl-img-missing{display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#e5e7eb;color:#6b7280;font-size:20px}
`;

export function slideBackground(slide: Slide, deck: RenderContext["deck"]): string {
  return slide.background ?? deck.theme?.background ?? DEFAULT_BACKGROUND;
}

function fontOf(element: { fontFamily?: string }, deck: RenderContext["deck"]): string {
  return element.fontFamily ?? deck.theme?.fontFamily ?? DEFAULT_FONT_FAMILY;
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** 元素外框的 style（位置 / 尺寸 / 旋转）。编辑器与导出共用 */
export function elementBoxStyle(element: SlideElement): string {
  const rotate = element.rotate !== undefined && element.rotate !== 0 ? `;transform:rotate(${n(element.rotate)}deg)` : "";
  return `left:${n(element.x)}px;top:${n(element.y)}px;width:${n(element.w)}px;height:${n(element.h)}px${rotate}`;
}

function textInner(element: TextElement, deck: RenderContext["deck"]): string {
  const justify = element.valign === "middle" ? "center" : element.valign === "bottom" ? "flex-end" : "flex-start";
  const style = `justify-content:${justify};text-align:${element.align};font-family:${escapeHtml(fontOf(element, deck))};font-size:${n(element.fontSize)}px;color:${element.color}`;
  // html 已在写入 / 读入时 sanitize；这里不再二次转义（那会把 <b> 变成文字）
  return `<div class="sl-text" style="${style}"><div class="sl-rich">${element.html}</div></div>`;
}

function imageInner(element: ImageElement, ctx: RenderContext): string {
  const url = ctx.imageUrl(element.src);
  if (url === null) return `<div class="sl-img-missing">${escapeHtml(element.src.split("/").pop() ?? "")}</div>`;
  return `<img class="sl-img" src="${escapeHtml(url)}" alt="${escapeHtml(element.alt ?? "")}" draggable="false" style="object-fit:${element.fit}">`;
}

function tableInner(element: TableElement, deck: RenderContext["deck"]): string {
  const cols = element.rows[0]?.length ?? 0;
  const widths = element.colWidths ?? Array.from({ length: cols }, () => 1 / Math.max(cols, 1));
  const colgroup = `<colgroup>${widths.map((w) => `<col style="width:${n(w * 100)}%">`).join("")}</colgroup>`;
  const rows = element.rows
    .map((row, rowIndex) => {
      const head = element.header && rowIndex === 0;
      const tag = head ? "th" : "td";
      const style = head
        ? `background:${element.headerFill};color:${element.headerColor};border-color:${element.borderColor}`
        : `color:${element.color};border-color:${element.borderColor}`;
      return `<tr>${row.map((cell) => `<${tag} style="${style}">${escapeHtml(cell)}</${tag}>`).join("")}</tr>`;
    })
    .join("");
  return `<table class="sl-table" style="font-family:${escapeHtml(fontOf({}, deck))};font-size:${n(element.fontSize)}px">${colgroup}${rows}</table>`;
}

function shapeSvg(element: ShapeElement): string {
  const { w, h, fill, stroke, strokeWidth, shape } = element;
  const inset = stroke === "none" ? 0 : strokeWidth / 2;
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${n(stroke === "none" ? 0 : strokeWidth)}" stroke-linejoin="round"`;
  let body: string;
  switch (shape) {
    case "ellipse":
      body = `<ellipse cx="${n(w / 2)}" cy="${n(h / 2)}" rx="${n(Math.max(w / 2 - inset, 0))}" ry="${n(Math.max(h / 2 - inset, 0))}" ${common}/>`;
      break;
    case "triangle":
      body = `<polygon points="${n(w / 2)},${n(inset)} ${n(w - inset)},${n(h - inset)} ${n(inset)},${n(h - inset)}" ${common}/>`;
      break;
    case "roundRect": {
      const radius = Math.min(w, h) * 0.14;
      body = `<rect x="${n(inset)}" y="${n(inset)}" width="${n(Math.max(w - inset * 2, 0))}" height="${n(Math.max(h - inset * 2, 0))}" rx="${n(radius)}" ry="${n(radius)}" ${common}/>`;
      break;
    }
    default:
      body = `<rect x="${n(inset)}" y="${n(inset)}" width="${n(Math.max(w - inset * 2, 0))}" height="${n(Math.max(h - inset * 2, 0))}" ${common}/>`;
  }
  return `<svg class="sl-svg" viewBox="0 0 ${n(w)} ${n(h)}" preserveAspectRatio="none">${body}</svg>`;
}

function shapeInner(element: ShapeElement, deck: RenderContext["deck"]): string {
  const text =
    element.text === undefined
      ? ""
      : `<div class="sl-shape-text" style="font-family:${escapeHtml(fontOf({}, deck))};font-size:${n(element.fontSize)}px;color:${element.color}">${escapeHtml(element.text)}</div>`;
  return `${shapeSvg(element)}${text}`;
}

function lineInner(element: LineElement): string {
  const [[x1, y1], [x2, y2]] = element.points;
  const markerId = `mk-${element.id}`;
  const needMarker = element.startArrow === "arrow" || element.endArrow === "arrow";
  const marker = needMarker
    ? `<defs><marker id="${markerId}" viewBox="0 0 4 4" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L4,2 L0,4 z" fill="${element.stroke}"/></marker></defs>`
    : "";
  const dash = element.dash ? ` stroke-dasharray="${n(element.strokeWidth * 2.5)} ${n(element.strokeWidth * 2)}"` : "";
  const start = element.startArrow === "arrow" ? ` marker-start="url(#${markerId})"` : "";
  const end = element.endArrow === "arrow" ? ` marker-end="url(#${markerId})"` : "";
  return `<svg class="sl-svg" viewBox="0 0 ${n(element.w)} ${n(element.h)}" preserveAspectRatio="none">${marker}<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${element.stroke}" stroke-width="${n(element.strokeWidth)}" stroke-linecap="round"${dash}${start}${end}/></svg>`;
}

/** 元素内部的 HTML（不含外框）：编辑器把它塞进自己的节点 */
export function renderElementInner(element: SlideElement, ctx: RenderContext): string {
  switch (element.kind) {
    case "text":
      return textInner(element, ctx.deck);
    case "image":
      return imageInner(element, ctx);
    case "table":
      return tableInner(element, ctx.deck);
    case "shape":
      return shapeInner(element, ctx.deck);
    case "line":
      return lineInner(element);
  }
}

export function renderElement(element: SlideElement, ctx: RenderContext): string {
  return `<div class="sl-el" data-id="${escapeHtml(element.id)}" style="${elementBoxStyle(element)}">${renderElementInner(element, ctx)}</div>`;
}

/** 一整页：固定在画布逻辑尺寸，缩放交给外层（CSS transform / zoom / 页面尺寸） */
export function renderSlide(slide: Slide, ctx: RenderContext): string {
  const { w, h } = CANVAS_SIZE[ctx.deck.aspect];
  const style = `width:${w}px;height:${h}px;background:${slideBackground(slide, ctx.deck)};font-family:${escapeHtml(ctx.deck.theme?.fontFamily ?? DEFAULT_FONT_FAMILY)}`;
  return `<section class="sl" style="${style}">${slide.elements.map((element) => renderElement(element, ctx)).join("")}</section>`;
}

export type DocumentMode = "web" | "print" | "png";

/**
 * 整份可独立打开的 HTML 文档。
 * - web：单文件网页（带翻页脚本：← → / 空格 / 点击，自动缩放到窗口，页码）；
 * - print：每页一张，`@page` 用画布尺寸，给 printToPDF（隐藏窗口里脚本是关的，所以不依赖脚本）；
 * - png：只放一页，整页放大 2 倍（窗口宽 = 画布宽 × 2），给 capturePage。
 * imageUrl 由调用方定：导出时把图片内联成 data URI，文件因此自包含。
 */
export function renderDeckDocument(deck: Deck, ctx: RenderContext, mode: DocumentMode, onlyIndex?: number): string {
  const { w, h } = CANVAS_SIZE[deck.aspect];
  const slides = mode === "png" ? [deck.slides[onlyIndex ?? 0] as Slide] : deck.slides;
  const title = escapeHtml(deck.title === "" ? "演示文稿" : deck.title);
  const pages = slides.map((slide) => renderSlide(slide, ctx));
  const base = `html,body{margin:0;padding:0}${SLIDE_CSS}`;
  if (mode === "print") {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>${base}@page{size:${w}px ${h}px;margin:0}.sl{page-break-after:always;break-after:page}.sl:last-child{page-break-after:auto;break-after:auto}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${pages.join("")}</body></html>`;
  }
  if (mode === "png") {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>${base}body{width:${w * 2}px;height:${h * 2}px;overflow:hidden}.sl{transform:scale(2);transform-origin:0 0}</style></head><body>${pages.join("")}</body></html>`;
  }
  const script = `(function(){var s=[].slice.call(document.querySelectorAll('.sl-wrap'));var i=0;var W=${w},H=${h};var c=document.getElementById('c');function fit(){var k=Math.min(innerWidth/W,(innerHeight-28)/H);s.forEach(function(e){e.firstChild.style.transform='scale('+k+')';e.style.width=W*k+'px';e.style.height=H*k+'px'})}function show(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach(function(e,j){e.style.display=j===i?'block':'none'});c.textContent=(i+1)+' / '+s.length;location.hash='#'+(i+1)}addEventListener('resize',fit);addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '||e.key==='PageDown'){e.preventDefault();show(i+1)}else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();show(i-1)}else if(e.key==='Home')show(0);else if(e.key==='End')show(s.length-1)});document.getElementById('stage').addEventListener('click',function(e){show(e.clientX>innerWidth/2?i+1:i-1)});fit();show((parseInt(location.hash.slice(1),10)||1)-1)})();`;
  const wrapped = pages.map((page) => `<div class="sl-wrap" style="position:relative;overflow:hidden;display:none;box-shadow:0 8px 40px rgba(0,0,0,.45)"><div style="transform-origin:0 0;width:${w}px;height:${h}px">${page}</div></div>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${base}body{background:#111;height:100vh;overflow:hidden;font-family:system-ui,sans-serif}#stage{height:calc(100vh - 28px);display:flex;align-items:center;justify-content:center;cursor:pointer}#c{height:28px;line-height:28px;text-align:center;color:#9ca3af;font-size:13px}</style></head><body><div id="stage">${wrapped}</div><div id="c"></div><script>${script}</script></body></html>`;
}
