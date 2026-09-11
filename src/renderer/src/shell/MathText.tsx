import katex from "katex";
import { splitMathSegments } from "./math-text.ts";

/**
 * 纯文本 + 数学公式的轻渲染——给**用户输入**用（docs/plans/2026-09-05-用户输入公式渲染.md）。
 *
 * 与 MarkdownBlock（模型输出）刻意不同：这里不解析 markdown，公式之外的一切按原样
 * 显示——用户气泡里 `**加粗**`、`#` 标题仍是打出来的字。切分语义在 `math-text.ts`
 * （金额防误判与流式补全都与模型输出同规则）。
 *
 * KaTeX `trust: false` 是安全闸：公式永远只是视觉，`\href` 这类带行为的命令拒绝；
 * `throwOnError: false` 让非法 LaTeX 原地显示源码而不是报警。katex.min.css 已随
 * MarkdownBlock 模块全局加载；KaTeX 的 HTML 用 currentColor 继承文字颜色，三主题
 * 自动跟随，无需额外样式。
 */
export function MathText(props: { text: string }) {
  return (
    <>
      {splitMathSegments(props.text).map((seg, index) => {
        if (seg.kind === "text") return <span key={index}>{seg.value}</span>;
        const html = katex.renderToString(seg.value, {
          displayMode: seg.kind === "blockMath",
          throwOnError: false,
          trust: false,
          strict: false,
        });
        return seg.kind === "blockMath" ? (
          // 块级公式自成一行居中；宽公式横向滚动，不把气泡撑破
          <span
            key={index}
            style={{
              display: "block",
              textAlign: "center",
              margin: "4px 0",
              overflowX: "auto",
              overflowY: "hidden",
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <span key={index} dangerouslySetInnerHTML={{ __html: html }} />
        );
      })}
    </>
  );
}
