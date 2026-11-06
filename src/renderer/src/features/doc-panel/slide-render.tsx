import { useLayoutEffect, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkBreaks from "remark-breaks";
import type { DocPaper } from "@shared/settings";
// 屏幕上用样式表（副作用导入），导出 PDF 时再把同一份源码当字符串塞进 HTML
import "./slide.css";
import slideCss from "./slide.css?inline";

/** 幻灯片的逻辑画布：16:9，1280 × 720 CSS 像素。缩略条 / 当前页 / PDF 都按它排，只是缩放不同 */
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

/**
 * 一页的正文：markdown → 元素，复用聊天里同一条 remark 管线的子集（GFM / CJK 加粗 / 软换行）。
 * 不开 raw HTML；图片不加载（幻灯片是文字稿，且远程图片是隐私洞）——渲染成它的替代文字；
 * 链接渲染成普通文字（页内不导航）。
 */
export function SlideMarkdown(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkBreaks]}
      skipHtml
      components={{
        img: ({ alt }) => <span>{alt ?? ""}</span>,
        a: ({ children }) => <span className="dp-slide-link">{children}</span>,
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

/** 一页（逻辑画布尺寸，未缩放）。页码是第几页（1 起），总页数给「3 / 8」这种写法用；title 是页脚标题（印刷版式才显示） */
export function SlidePage(props: { text: string; number: number; total: number; title: string }) {
  const blank = props.text.trim() === "";
  return (
    <div className="dp-slide" data-blank={blank ? "true" : undefined}>
      <div className="dp-slide-body">{blank ? null : <SlideMarkdown text={props.text} />}</div>
      <div className="dp-slide-foot">
        <span className="dp-slide-title">{props.title}</span>
        <span className="dp-slide-no">
          <span className="dp-slide-no-n">{props.number}</span>
          <span className="dp-slide-no-of">/ {props.total}</span>
        </span>
      </div>
    </div>
  );
}

/** 按容器宽度缩放一页：外框 16:9，里面的 1280 画布 transform: scale(宽 / 1280) */
export function SlideCanvas(props: { text: string; number: number; total: number; title: string; className?: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return undefined;
    const measure = (): void => setScale(frame.clientWidth / SLIDE_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={frameRef} className={`dp-slide-frame${props.className === undefined ? "" : ` ${props.className}`}`}>
      <div className="dp-slide-scaler" style={{ transform: `scale(${scale})` }}>
        <SlidePage text={props.text} number={props.number} total={props.total} title={props.title} />
      </div>
    </div>
  );
}

/** 导出 PDF 时每页之间的换页规则 + 页面尺寸；不在 slide.css 里（那是屏幕上的样式） */
const PRINT_CSS = `
@page { size: ${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin: 0; }
html, body { margin: 0; padding: 0; }
.dp-slide { break-after: page; page-break-after: always; }
.dp-slide:last-child { break-after: auto; page-break-after: auto; }
`;

/** slide.css 用到的 token：导出时把它们此刻的值写进 HTML 的 :root（隐藏窗口里没有 design-system） */
const SLIDE_TOKENS = [
  "--color-bg-panel",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-border-default",
  "--color-bg-muted",
  "--font-family-base",
  "--font-family-brand",
  "--font-family-mono",
  "--font-size-lg",
  "--line-height-ui",
  "--line-height-tight",
] as const;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 把当前主题下 slide.css 要用的 token 值抄成一段 `:root{…}`（所见即所得：导出的页与屏幕上同色） */
export function resolvedTokenCss(root: Element = document.documentElement): string {
  const style = getComputedStyle(root);
  const lines = SLIDE_TOKENS.map((name) => `${name}: ${style.getPropertyValue(name).trim()};`);
  return `:root { ${lines.join(" ")} }`;
}

/**
 * 整份幻灯片 → 自包含的 HTML（每页一个 `.dp-slide`，页数 = 分页数）。给主进程的隐藏窗口
 * `printToPDF` 用；带上当前纸面与主题，导出的页与屏幕上看到的是同一套样式。
 */
export function deckHtml(
  pages: readonly string[],
  opts: { paper: DocPaper; title: string; theme: string; tokens: string },
): string {
  const body = pages
    .map((text, index) =>
      renderToStaticMarkup(<SlidePage text={text} number={index + 1} total={pages.length} title={opts.title} />),
    )
    .join("\n");
  return `<!doctype html><html data-paper="${opts.paper}" data-theme="${escapeHtml(opts.theme)}"><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title><style>${opts.tokens}${slideCss}${PRINT_CSS}</style></head><body>${body}</body></html>`;
}
