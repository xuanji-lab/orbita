import { useLayoutEffect, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkBreaks from "remark-breaks";
import type { DocPaper } from "@shared/settings";
import { splitColumns } from "./slide-columns.ts";
import { useDocPaper } from "./doc-paper.ts";
import { Icon } from "../../shell/Icon";
// 屏幕上用样式表（副作用导入），导出 PDF 时再把同一份源码当字符串塞进 HTML
import "./slide.css";
import slideCss from "./slide.css?inline";

/** 幻灯片的逻辑画布：16:9，1280 × 720 CSS 像素。缩略条 / 当前页 / PDF 都按它排，只是缩放不同 */
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

/**
 * 一页的正文：markdown → 元素，复用聊天里同一条 remark 管线的子集（GFM / CJK 加粗 / 软换行）。
 * 不开 raw HTML（分栏用 `::: columns` … `+++` … `:::`，见 slide-columns.ts）；图片不加载（幻灯片是文字稿，且远程图片是隐私洞）——渲染成它的替代文字；
 * 链接渲染成普通文字（页内不导航）。
 */
export function SlideMarkdown(props: { text: string }) {
  return (
    <>
      {splitColumns(props.text).map((block, index) =>
        block.kind === "md" ? (
          <SlideMarkdownBlock key={index} text={block.text} />
        ) : (
          <div key={index} className="dp-slide-cols" style={{ gridTemplateColumns: `repeat(${block.columns.length}, minmax(0, 1fr))` }}>
            {block.columns.map((column, i) => (
              <div key={i} className="dp-slide-col">
                <SlideMarkdownBlock text={column} />
              </div>
            ))}
          </div>
        ),
      )}
    </>
  );
}

function SlideMarkdownBlock(props: { text: string }) {
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
export function SlideCanvas(props: {
  text: string;
  number: number;
  total: number;
  title: string;
  className?: string;
  /** 给了就在页角标出「内容超出这一页」（当前页预览用；缩略图不标）。导出的 PDF 里没有这个标记 */
  overflowLabel?: string;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const [overflow, setOverflow] = useState(false);
  // 换纸面会换字体字号与页边，超出与否要重算
  const { paper } = useDocPaper();
  // 内容超出 16:9 的页：页体是 overflow:hidden，超出的部分会被静默裁掉——量出来、告诉用户
  useLayoutEffect(() => {
    const body = frameRef.current?.querySelector<HTMLElement>(".dp-slide-body") ?? null;
    setOverflow(body !== null && body.scrollHeight > body.clientHeight + 1);
  }, [props.text, props.number, scale, paper]);
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
      {overflow && props.overflowLabel !== undefined && (
        <span className="dp-slide-overflow" role="status">
          <Icon name="triangle-alert" size={12} strokeWidth={2} />
          {props.overflowLabel}
        </span>
      )}
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
export function resolvedTokenCss(theme?: "light"): string {
  // 指定主题时借设计系统给主题预览卡留的 `[data-theme-preview]` 选择器（tokens/colors.css）：
  // 一个临时的隐藏子树拿到该主题的色值，不动应用自己的主题
  const probe = theme === undefined ? null : document.createElement("div");
  if (probe !== null) {
    probe.setAttribute("data-theme-preview", theme ?? "light");
    probe.style.display = "none";
    document.body.append(probe);
  }
  try {
    const style = getComputedStyle(probe ?? document.documentElement);
    const lines = SLIDE_TOKENS.map((name) => `${name}: ${style.getPropertyValue(name).trim()};`);
    return `:root { ${lines.join(" ")} }`;
  } finally {
    probe?.remove();
  }
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

/**
 * 哪几页的内容超出了 16:9（会被裁掉）：把每页渲染进一个看不见的容器、按当前纸面量页体的滚动高度。
 * 导出 PDF 时用它在完成提示里列出页号（页体是 overflow:hidden，超出的部分在 PDF 里是静默裁掉的）。返回 1 起的页号。
 */
export function overflowPages(pages: readonly string[], paper: DocPaper): number[] {
  const host = document.createElement("div");
  host.setAttribute("data-paper", paper);
  host.style.cssText = "position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none";
  host.innerHTML = pages
    .map((text, index) => renderToStaticMarkup(<SlidePage text={text} number={index + 1} total={pages.length} title="" />))
    .join("");
  document.body.append(host);
  try {
    const found: number[] = [];
    host.querySelectorAll<HTMLElement>(".dp-slide-body").forEach((body, index) => {
      if (body.scrollHeight > body.clientHeight + 1) found.push(index + 1);
    });
    return found;
  } finally {
    host.remove();
  }
}
