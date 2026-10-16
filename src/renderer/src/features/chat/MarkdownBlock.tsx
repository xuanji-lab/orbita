import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// CJK 加粗（2026-10-14 用户报的两例）：CommonMark 的定界规则下 `**标题： **`
// 的收尾 ** 前是空白、`**说明：**后文` 的收尾 ** 前是中文标点且后是汉字，都算
// 不成右侧定界。remark-cjk-friendly（2.3.2，MIT，作者 tats-u，remark 生态的
// 活跃维护者）放宽这两条对 CJK 的判定；数学 / 引用插件不动。
import remarkCjkFriendly from "remark-cjk-friendly";
import { normalizeEmphasisInnerSpace } from "./emphasis-space.ts";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
// katex 的 CSS 必须与 rehype-katex 实际用的渲染器同版——直装 katex 已锁 0.16.47 对齐
import "katex/dist/katex.min.css";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Component, memo, useMemo, useContext } from "react";
import { MdPre } from "./CodeBlock";
import { remarkDemoteBoundaryMath } from "./math-guard";
import { rehypePluginsFor, streamRenderPolicy } from "./stream-render.ts";
import { Icon } from "../../shell/Icon";
import { dominantScript } from "./dominant-script";
import { useT } from "../../locale.ts";
import { useExperimentalFeature } from "../../experimental.ts";
import { citationIdOfHref, citationTitle, remarkCitationMarkers } from "./citation-markers.ts";
import { CitationOpenContext, CitationTableContext } from "./citation-context.ts";

/**
 * assistant 文本块的 markdown 渲染（设计系统 *AssistantText*：读起来像文档，不是聊天记录）。
 *
 * - **memo 按 text 记忆**：流式期间 transcript 每帧都产生新对象，但只有正在流的那条
 *   的 text 真的在变——没变的消息不重新解析 markdown。
 * - **数学公式**：remark-math 把 `$…$` / `$$…$$` 认成 math 节点，rehype-katex 就地
 *   变成 KaTeX HTML（KATEX 选项见 stream-render.ts）。非法 LaTeX 由 styles.css
 *   降级成斜体次级灰，不是报警。流式帧不挂 katex，公式暂以 markdown 的原样显示
 *   （行内是等宽的 LaTeX 片段、块级是无色代码块）。
 * - 代码块高亮走 shiki（`CodeBlock.tsx` 覆写 pre，双主题 HTML + CSS 变量切换），
 *   配色来自 github-light / github-dark 主题，是设计系统 token 的既定例外。
 * - **流式帧省掉两件贵的渲染**（KaTeX 排版 + shiki 高亮，决策在 stream-render.ts）：
 *   落定后 streaming 翻 false，memo 浅比较失效自动重渲一次补上。
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
  /** 仅流式中的那条消息传 true：本帧不挂 rehype-katex、不跑 shiki，公式按源码、
   *代码块按无色显示（比每帧全量重排便宜一个量级，见 stream-render.ts）。落定的消息
   *必须 false——落定帧才把公式与高亮补渲上。memo 按 prop 浅比较，布尔翻转正好触发
   *那一次补渲，且不引发无关重渲染。 */
  streaming?: boolean;
}) {
  const bubble = variant === "bubble";
  const policy = streamRenderPolicy(streaming);
  // pre 覆写的闭包按「跑不跑 shiki」记忆：react-markdown 不把自定义 prop 交给
  // components 映射里的组件，只能在这里闭住 policy.highlight。身份只在流式翻落定
  // 那一刻变一次（正是要补渲的时刻）；流式期间每帧同一身份，代码块子树不重挂。
  const pre = useMemo(
    () => (preProps: { children?: ReactNode }) => <MdPre {...preProps} highlight={policy.highlight} />,
    [policy.highlight],
  );
  // PDF 引用标记（实验功能「PDF 引用」）只在 assistant 正文里认：用户气泡里打出来的
  // `[^c4k2]` 是用户的字，不是 agent 核验过的引用；开关关着时标记退回纯文本
  const citations = useExperimentalFeature("pdf-citations") && !bubble;
  const remarkPlugins = bubble
    ? [remarkGfm, remarkCjkFriendly, remarkMath, remarkBreaks, remarkDemoteBoundaryMath]
    : citations
      ? [remarkGfm, remarkCjkFriendly, remarkMath, remarkDemoteBoundaryMath, remarkCitationMarkers]
      : [remarkGfm, remarkCjkFriendly, remarkMath, remarkDemoteBoundaryMath];
  return (
    // data-script：以中文为主还是拉丁为主（dominant-script.ts），Typescript 主题按它换阅读字
    <div className={bubble ? "chat-md bubble-md" : "chat-md"} data-script={dominantScript(text)}>
      <MarkdownErrorBoundary>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePluginsFor(bubble, policy)}
          components={{ a: ExternalAnchor, img: ImagePlaceholder, pre, span: ChipSpan }}
          {...(bubble ? { disallowedElements: BUBBLE_BANNED, unwrapDisallowed: true } : {})}
        >
          {/* 强调定界内侧空白先收掉（emphasis-space.ts）：`**… **` 这类在
              CommonMark 下整段不算强调，用户写它就是要加粗 */}
          {normalizeEmphasisInnerSpace(text)}
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
    <p style={{ color: "var(--color-danger)", fontSize: "var(--font-size-sm)" }}>
      {t.chat.messageRenderFailed} {props.message}
    </p>
  );
}

function ExternalAnchor(props: AnchorProps) {
  const { href, children, node: _node, ...rest } = props;
  const citeId = citationIdOfHref(href);
  if (citeId !== null) return <CitationAnchor id={citeId} label={children} />;
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
 * PDF 引用编号（remarkCitationMarkers 切出来的 `#orbita-cite-<id>` 锚点）：上标小号，
 * 悬停给页码与原文，点开在文件面板里跳到 PDF 原文处。编号在本会话的引用表里查不到
 * （模型写错了编号、引用所在的历史被压缩掉）就原样显示 `[^c4k2]`——写错的编号对
 * 用户可见，而不是悄悄消失。
 */
function CitationAnchor(props: { id: string; label: ReactNode }) {
  const citation = useContext(CitationTableContext).get(props.id);
  const open = useContext(CitationOpenContext);
  if (citation === undefined) return <>{`[^${props.id}]`}</>;
  const title = citationTitle(citation.page, citation.text);
  if (open === null) {
    return (
      <sup className="chat-cite" title={title}>
        {props.label}
      </sup>
    );
  }
  return (
    <sup className="chat-cite">
      <a
        href={`#${props.id}`}
        title={title}
        onClick={(event) => {
          event.preventDefault();
          open(citation);
        }}
      >
        {props.label}
      </a>
    </sup>
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
    // 非 chip 的 span 原样透传全部属性：KaTeX 的上下标靠 vlist 上的内联 style（top / height）
    // 定位、MathML 副本靠 aria-hidden——吞掉 rest 时 x^2 的 2 掉到下面变成下标
    return (
      <span className={className} {...rest}>
        {children}
      </span>
    );
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
