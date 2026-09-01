/**
 * markdown 代码块组件（B-1）：react-markdown 的 `pre` 覆写入口。
 *
 * **为什么覆写 pre 而不是 code**：fence 块在 hast 里是 `pre > code.language-x`，
 * 在 pre 这一层能同时拿到语言 class 与原始文本，整棵子树自己重画——shiki 的
 * HTML 自带 `<pre class="shiki">`，直接放行 react-markdown 的 pre 会得到双层嵌套。
 * 行内 code（不在 pre 里）不经这里，继续走 styles.css 的芯片样式。
 *
 * **异步就绪**：引擎预热完成前（应用启动后的头一瞬）先渲染无色块，
 * `highlighterReady` resolve 后 setState 触发一次重渲上色；就绪之后
 * `highlightBlock` 同步返回（缓存命中），流式增长不再闪无色帧。
 */
import { useEffect, useState, isValidElement } from "react";
import type { ReactNode } from "react";
import { highlightBlock, highlighterReady } from "./highlight";

/** react-markdown 的 pre 元素 */
export function MdPre(props: { children?: ReactNode }) {
  const child = Array.isArray(props.children) ? props.children[0] : props.children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return <pre>{props.children}</pre>;
  }
  const className = child.props.className ?? "";
  const lang = /^language-(\S+)$/.exec(className)?.[1];
  const text = nodeText(child.props.children);
  if (lang === undefined) return <PlainFence text={text} />;
  return <FenceBlock lang={lang} text={text} />;
}

/** 已知语言：shiki 双主题 HTML；未就绪期间先无色 */
function FenceBlock(props: { lang: string; text: string }) {
  // warm 只是重渲触发器（引擎就绪那一刻）；HTML 每次渲染都同步取，缓存命中代价是一次 Map.get
  const [, setWarm] = useState(false);
  useEffect(() => {
    void highlighterReady.then(() => setWarm(true));
  }, []);
  const html = highlightBlock(props.text, props.lang);
  if (html === null) return <PlainFence text={props.text} />;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 无色兜底：语言未预置 / 引擎未就绪。结构与 shiki 输出对齐（pre > code），
 * 让 styles.css 里同一份 `.chat-md pre` 规则管住两种形态。 */
function PlainFence(props: { text: string }) {
  return (
    <pre>
      <code>{props.text}</code>
    </pre>
  );
}

/** hast 文本子节点 → 字符串（react-markdown 的 code 子节点正常就是纯字符串，递归只是防手抖） */
function nodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return "";
}
