import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// katex 的 CSS 必须与 rehype-katex 实际用的渲染器同版——直装 katex 已锁 0.16.47 对齐
import "katex/dist/katex.min.css";
import type { ComponentPropsWithoutRef } from "react";
import { MdPre } from "./CodeBlock";
import { closePendingMath } from "./pending-math";
import { demoteBoundaryMath } from "./math-guard";

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
 * - 链接全部拦给 `window.open`：主进程的 `setWindowOpenHandler` 会把它送去系统浏览器
 *   （`src/main/index.ts`），外链绝不能在应用窗口内导航走。
 * - **图片永不加载**：远程 `<img>` 是隐私洞（模型给出图床 URL 就把用户的 IP 送出去），
 *   渲染成占位链接，点击才去系统浏览器看（ImagePlaceholder）。
 * - **raw HTML 只放行 `<details>`/`<summary>`**：rehype-raw 解析 + rehype-sanitize
 *   白名单剥离，其余标签仍是纯文本。白名单可审计，攻击面有界。
 * - 元素样式在 `styles.css` 的 `.chat-md` 作用域里，走设计系统 token。
 */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, demoteBoundaryMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, trust: false }]]}
        components={{ a: ExternalAnchor, img: ImagePlaceholder, pre: MdPre }}
      >
        {closePendingMath(text)}
      </ReactMarkdown>
    </div>
  );
});

/** 只放行 http(s) 与 mailto；其余协议一律吞掉——绝对不给 javascript: 这类 href 留门。 */
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
 * 用户点了才在系统浏览器里看，加载与否、何时加载由用户决定。
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
