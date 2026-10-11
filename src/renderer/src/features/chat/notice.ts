import type { CSSProperties } from "react";

/**
 * 提示行（Notice）的文字换行口径——样式抽成纯函数，`notice.test.ts` 锚定几何契约。
 *
 * **根因（2026-10-11 修复「回合失败提示撑出对话列」）**：模型网关的错误原文常带
 * 100+ 字符的无空格片段（如 Cloudflare 502 的整段 JSON）。提示行是
 * `display: flex` 的 `<p>`，文字是 flex 子项，而 flex 子项默认 `min-width: auto`
 * ——最小内容宽度 = 最长无空格片段，收缩不下去，整块红字从对话列右缘伸出
 * （实测溢出约 125px）。`<p>` 自身作为外层 flex 子项同样 `min-width: auto`。
 * 对话区其它块早已统一 `overflow-wrap: anywhere`（如正文 .chat-md），Notice 漏了。
 *
 * 注意 **必须 `anywhere`，不能 `break-word`**：`break-word` 只在实际折行时生效，
 * **不减小 min-content 宽度**——flex 布局量的是 min-content，照样溢出；
 * `anywhere` 让最长无空格片段在 min-content 计算里也允许断开，宽度才收得下去。
 */

/** 图标盒高度：一行行盒。文字继承 body 的 `--line-height-body`（22px），图标盒取同高、内部居中——多行时三角钉在首行，单行时与旧 `align-items: center` 的位置一致。 */
export const noticeIconBoxStyle: CSSProperties = {
  display: "inline-flex",
  flex: "0 0 auto",
  alignItems: "center",
  height: "var(--line-height-body)",
};

/** 文字 wrapper：允许收缩 + 片段内断行（`anywhere`，见上）。 */
export const noticeTextStyle: CSSProperties = {
  minWidth: 0,
  overflowWrap: "anywhere",
};

/** 提示行本体：flex 子项默认 `min-width: auto` 是溢出的另一半根因，显式放开。 */
export function noticeParagraphStyle(bad: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-2)",
    margin: 0,
    padding: "0 var(--space-2)",
    minWidth: 0,
    maxWidth: "100%",
    color: bad ? "var(--color-danger)" : "var(--color-text-secondary)",
    fontSize: "var(--font-size-control)",
  };
}
