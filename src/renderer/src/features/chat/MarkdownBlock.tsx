import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
// katex 的 CSS 必须与 rehype-katex 实际用的渲染器同版——直装 katex 已锁 0.16.47 对齐
import "katex/dist/katex.min.css";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Component, memo } from "react";
import { MdPre } from "./CodeBlock";
import { closePendingMath } from "./pending-math";
import { remarkDemoteBoundaryMath } from "./math-guard";
import { rehypeBubbleChips } from "./chip-runs.ts";
import { Icon } from "../../shell/Icon";
import { dominantScript } from "./dominant-script";
import { useT } from "../../locale.ts";

/**
 * sanitize 白名单：defaultSchema 之上只放行 `<details>`/`<summary>`，其余标签
 * rehype-raw 解析完照剥。**顺序敏感**（rehypePlugins 数组序）：rehypeRaw →
 * rehypeSanitize → rehypeKatex——sanitize 必须在 katex 前，否则会把 KaTeX 的
 * 输出剥掉；其默认 schema 保留 code 的 language-* class，math 节点能活着走到
 * katex。
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
};

/**
 * assistant 文本块的 markdown 渲染（设计系统 *AssistantText*：读起来像文档，不是聊天记录）。
 *
 * - **memo 按 text 记忆**：流式期间 transcript 每帧都产生新对象，但只有正在流的那条
 *   的 text 真的在变——没变的消息不重新解析 markdown。
 * - **数学公式**：remark-math 把 `$…$` / `$$…$$` 认成 math 节点，rehype-katex 就地
 *   变成 KaTeX HTML。`trust: false` 是安全闸——公式永远只是视觉，`\href` 等带行为
 *   的命令拒绝；`throwOnError: false` 让半截/非法 LaTeX 原地显示源码，由 styles.css
 *   降级成斜体次级灰（流式期间的常态，不是报警）。
 * - 代码块高亮走 shiki（`CodeBlock.tsx` 覆写 pre，双主题 HTML + CSS 变量切换），
 *   配色来自 github-light / github-dark 主题，是设计系统 token 的既定例外。
 * - 链接全部拦给 `window.open`：主进程的 `setWindowOpenHandler` 把网页送进内置浏览器、
 *   mailto 交给系统（`src/main/index.ts` 的 openLink），外链绝不能在应用窗口内导航走。
 * - **图片永不加载**：远程 `<img>` 是隐私洞（模型给出图床 URL 就把用户的 IP 送出去），
 *   渲染成占位链接，点击才去内置浏览器看（ImagePlaceholder）。
 * - **raw HTML 只放行 `<details>`/`<summary>`**：rehype-raw 解析 + rehype-sanitize
 *   白名单剥离，其余标签仍是纯文本。白名单可审计，攻击面有界。
 * - 元素样式在 `styles.css` 的 `.chat-md` 作用域里，走设计系统 token。
 */
/**
 * 气泡内禁掉的元素：标题摊平成文本——`#` 开头在气泡里变成大标题是事故。
 * 其余照全量管线（表格 / 粗体 / 代码块 / 数学都放行——wafo 2026-09-20：
 * 「正文里表格和加粗渲染正确，user message 为什么不一并渲染」）。
 */
const BUBBLE_BANNED = ["h1", "h2", "h3", "h4", "h5", "h6"];

export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  variant = "full",
  streaming = false,
}: {
  text: string;
  /** "bubble"：用户气泡内的轻量渲染——标题摊平成文本；单个换行保留为 <br>
   *（remark-breaks，用户消息里按 Enter 的换行不该被 markdown 吞掉）。 */
  variant?: "full" | "bubble";
  /** 仅流式中的那条消息传 true：尾部未闭合的 `$…` 补上闭合符让公式逐字成形
   *（pending-math.ts）。落定的消息必须 false——已写完的文本里孤立的 `$`（如
   * 「价格 $5 起」）不该被凭空补一个闭合符变成公式（2026-10 事故）。memo 按 prop
   * 浅比较，布尔翻转不引发无关重渲染。 */
  streaming?: boolean;
}) {
  const bubble = variant === "bubble";
  return (
    // data-script：以中文为主还是拉丁为主（dominant-script.ts），Typescript 主题按它换阅读字
    <div className={bubble ? "chat-md bubble-md" : "chat-md"} data-script={dominantScript(text)}>
      <MarkdownErrorBoundary>
        <ReactMarkdown
          remarkPlugins={bubble ? [remarkGfm, remarkMath, remarkBreaks, remarkDemoteBoundaryMath] : [remarkGfm, remarkMath, remarkDemoteBoundaryMath]}
          rehypePlugins={
            bubble
              ? // bubble 变体在 sanitize 之后多挂 rehypeBubbleChips：用户原文里的 /skill: token
                // 就地换成 chip（span.bubble-chip，chip-runs.ts）。必须排在 sanitize 之后
                // ——span 不在白名单里，先换会被剥掉；排在 katex 之前——数学节点是 code，
                // 与 chip 互不碰面
                [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeBubbleChips, [rehypeKatex, { throwOnError: false, strict: false, trust: false }]]
              : [
                  rehypeRaw,
                  [rehypeSanitize, SANITIZE_SCHEMA],
                  [rehypeKatex, { throwOnError: false, strict: false, trust: false }],
                ]
          }
          components={{ a: ExternalAnchor, img: ImagePlaceholder, pre: MdPre, span: ChipSpan }}
          {...(bubble ? { disallowedElements: BUBBLE_BANNED, unwrapDisallowed: true } : {})}
        >
          {streaming ? closePendingMath(text) : text}
        </ReactMarkdown>
      </MarkdownErrorBoundary>
    </div>
  );
});

/**
 * 渲染错误的护栏：markdown 管线任何一环抛异常，只降级这一条消息（红字说明），
 * 不许把整棵 React 树掀翻——2026-09-04 插件形状错误导致全应用黑屏的教训。
 * ErrorBoundary 只能用 class 组件实现（React 限制）。
 */
class MarkdownErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  render() {
    if (this.state.error !== null) {
      return <RenderFailed message={this.state.error.message} />;
    }
    return this.props.children;
  }
}

/** 只放行 http(s) 与 mailto；其余协议一律吞掉——绝对不给 javascript: 这类 href 留门。 */
/** 错误边界是类组件，拿不到 hook——失败提示单独成一个函数组件，好取当前语言的文案 */
function RenderFailed(props: { message: string }) {
  const t = useT();
  return (
    <p style={{ color: "var(--color-danger)", fontSize: "var(--font-size-caption)" }}>
      {t.chat.messageRenderFailed} {props.message}
    </p>
  );
}

function ExternalAnchor(props: AnchorProps) {
  const { href, children, node: _node, ...rest } = props;
  const external = href !== undefined && /^(https?:|mailto:)/i.test(href);
  return (
    <a
      {...rest}
      href={external ? href : undefined}
      onClick={
        external
          ? (event) => {
              event.preventDefault();
              window.open(href);
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}

/**
 * 图片占位：永不设 `src`，远程图就不可能被加载。占位本身是个链接——
 * 用户点了才在内置浏览器里看，加载与否、何时加载由用户决定。
 */
function ImagePlaceholder(props: ImageProps) {
  const { src, alt, node: _node } = props;
  const url = typeof src === "string" && src !== "" ? src : undefined;
  return (
    <a
      className="chat-img-placeholder"
      href={url}
      onClick={
        url
          ? (event) => {
              event.preventDefault();
              window.open(url);
            }
          : undefined
      }
    >
      {typeof alt === "string" && alt !== "" ? alt : (url ?? "image")}
    </a>
  );
}

/** react-markdown v10 会多传一个 `node`，不能落到 <img> 的 DOM 属性上 */
type ImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

/** react-markdown v10 会多传一个 `node`，不能落到 <a> 的 DOM 属性上 */
type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

/**
 * 气泡里的句中 chip：chip-runs.ts 的 rehype 变换把 token 塞进
 * `<span class="bubble-chip bubble-chip-<kind>">token</span>`（skill / mcp 同构），
 * react-markdown 把它交到这里换成图标 + 名字的胶囊。图标随 kind：skill 是
 * book-open，mcp 是 plug（与右栏 Skills / MCP 面板同一套词汇）。其余 span（sanitize 白名单
 * 幸存的）原样放行。chip 元素里只有一个文本子节点（chip-runs.ts 放进去的），
 * String(children) 拿到的就是 token 原文。
 */
function ChipSpan(props: ComponentPropsWithoutRef<"span"> & { node?: unknown }) {
  const { className, children, node: _node, ...rest } = props;
  const classes = Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/).filter(Boolean) : [];
  if (!classes.includes("bubble-chip")) {
    return <span className={className}>{children}</span>;
  }
  const token = String(children);
  const mcp = token.startsWith("/mcp:");
  return (
    <span className={classes.join(" ")} title={token}>
      <Icon name={mcp ? "plug" : "book-open"} size={12} strokeWidth={1.8} className="bubble-chip-icon" />
      <span className="bubble-chip-target">{token.replace(/^\/(?:skill|mcp):/, "")}</span>
    </span>
  );
}
