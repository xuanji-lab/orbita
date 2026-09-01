import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentPropsWithoutRef } from "react";
import { MdPre } from "./CodeBlock";

/**
 * assistant 文本块的 markdown 渲染（设计系统 *AssistantText*：读起来像文档，不是聊天记录）。
 *
 * - **memo 按 text 记忆**：流式期间 transcript 每帧都产生新对象，但只有正在流的那条
 *   的 text 真的在变——没变的消息不重新解析 markdown。
 * - 代码块高亮走 shiki（`CodeBlock.tsx` 覆写 pre，双主题 HTML + CSS 变量切换），
 *   配色来自 github-light / github-dark 主题，是设计系统 token 的既定例外。
 * - 链接全部拦给 `window.open`：主进程的 `setWindowOpenHandler` 会把它送去系统浏览器
 *   （`src/main/index.ts`），外链绝不能在应用窗口内导航走。
 * - 默认不渲染 raw HTML（react-markdown 的缺省行为），模型输出里夹 HTML 也无害
 *   ——代码块的 shiki HTML 是我们自己生成的，不受此限。
 * - 元素样式在 `styles.css` 的 `.chat-md` 作用域里，走设计系统 token。
 */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ExternalAnchor, pre: MdPre }}
      >
        {text}
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

/** react-markdown v10 会多传一个 `node`，不能落到 <a> 的 DOM 属性上 */
type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };
