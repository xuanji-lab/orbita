/**
 * 用户气泡里的句中 chip——把气泡正文（markdown 源文本）里的 `/skill:` token
 * 渲染成 chip（图标 + 名字）。
 *
 * 气泡不是 textarea，没有镜像层的对齐约束，chip 可以有横向 padding 与图标，
 * 与输入框里只能逐字符显示 token 原文的 chip 是同一语言的两个形态
 * （差异是 PR 待定项之一，见 PR 描述）。
 *
 * 实现层：rehype 变换器（挂在 sanitize 之后、katex 之前），扫 hast 文本节点，
 * 把 token 段替换成 `<span class="bubble-chip bubble-chip-skill">token</span>`。
 * 之所以在 hast 层做而不是把文本切成多段 MarkdownBlock：token 可能落在表格、
 * 列表、粗体之间，先切文本会把块级 markdown 拦腰斩断。
 *
 * **token 识别复用发送端的 `findSkillTokens`**（src/shared/skill.ts）：气泡里
 * 画成 chip 的，发送时必然被当 token 认。显示侧在 hast 文本节点上逐段扫，
 * 与发送侧扫原始字符串有两处已知近似（都是「显示比发送更保守」，不会出现
 * 发送认了、显示没画的情况）：
 *   - token 在文本节点开头时，前一个兄弟是行内元素（strong/em/code/a）视为
 *     非边界——源文本里那是 `**` 一类标记字符，发送侧同样不认；
 *   - code / pre 里的 token 不画（源文本里发送侧会认，但把代码块里的字面
 *     token 画成 chip 是事故，宁可漏画）。
 */

import { findSkillTokens } from "../../../../shared/skill.ts";

/** 一个文本节点切出来的段：散文，或一个待画成 chip 的 token */
export type ChipRun =
  | { kind: "text"; text: string }
  | { kind: "chip"; text: string; target: string };

/**
 * 切一个文本节点。`boundaryAtStart`：节点第一个字符之前（源文本里）是不是
 * 边界（行首 / 空白）。节点内部的 token 由 findSkillTokens 自查前导字符。
 */
export function splitChipRuns(value: string, boundaryAtStart: boolean): ChipRun[] {
  const tokens = findSkillTokens(value);
  const runs: ChipRun[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start === 0 && !boundaryAtStart) continue;
    if (token.start > cursor) runs.push({ kind: "text", text: value.slice(cursor, token.start) });
    runs.push({ kind: "chip", text: value.slice(token.start, token.end), target: token.target });
    cursor = token.end;
  }
  if (runs.length === 0) return [{ kind: "text", text: value }];
  if (cursor < value.length) runs.push({ kind: "text", text: value.slice(cursor) });
  return runs;
}

/** 够用的 hast 子集：本变换器只读 type/tagName/value/children、替换 children */
export interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

/** 前一个兄弟是这些元素 = 前面是块边界或换行，token 可以从节点头开始 */
const BLOCK_AFTER = new Set([
  "p", "div", "li", "ul", "ol", "blockquote", "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "pre", "details", "summary", "figure", "figcaption",
]);

/** 前一个兄弟元素是块级 → 本节点开头算边界；是行内元素（strong/em/code/a…）→ 不算 */
function boundaryBeforeSibling(siblings: HastNode[], index: number): boolean {
  if (index === 0) return true;
  const prev = siblings[index - 1];
  if (prev?.type === "text") return /\s$/.test(prev.value ?? "");
  if (prev?.type === "element") return BLOCK_AFTER.has(prev.tagName ?? "");
  return false;
}

function chipElement(kind: "skill", text: string): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["bubble-chip", `bubble-chip-${kind}`] },
    children: [{ type: "text", value: text }],
  };
}

function transformChips(node: HastNode, insideCode: boolean): void {
  const children = node.children;
  if (children === undefined) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === undefined) continue;
    if (child.type === "text") {
      if (insideCode) continue;
      const value = child.value ?? "";
      const runs = splitChipRuns(value, boundaryBeforeSibling(children, i));
      if (runs.length === 1 && runs[0]?.kind === "text") continue;
      const replacement = runs.map((run) =>
        run.kind === "chip" ? chipElement("skill", run.text) : { type: "text", value: run.text },
      );
      // splice 后 i 要跳过全部新节点：否则下一轮会踏进 chip 元素内部，把它的文本再包一层
      children.splice(i, 1, ...replacement);
      i += replacement.length - 1;
    } else if (child.children !== undefined) {
      const tag = child.tagName ?? "";
      transformChips(child, insideCode || tag === "code" || tag === "pre");
    }
  }
}

/**
 * unified 插件形状（同 remarkDemoteBoundaryMath 的教训）：**工厂返回变换器，
 * 使用处传工厂本身**——`.use(rehypeBubbleChips)`。
 */
export function rehypeBubbleChips(): (tree: HastNode) => void {
  return (tree) => {
    transformChips(tree, false);
  };
}
