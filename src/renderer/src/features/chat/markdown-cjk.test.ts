/**
 * CJK 加粗（2026-10-14 用户报的两例）：CommonMark 的右侧定界规则在中文里判反——
 * `**标题一般是加粗对象： **` 的收尾 `**` 前是空白；`**说明：**后文` 的收尾 `**`
 * 前是中文标点、后是汉字，两条都算不成「右侧定界」，于是整段不加粗。ChatView 用
 * react-markdown，修法是挂 remark-cjk-friendly（MarkdownBlock 的三条插件链都挂）。
 * 本文件用同一套管线（unified + remark-parse）钉死行为；代码块与行内代码不受影响。
 */
import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { normalizeEmphasisInnerSpace } from "./emphasis-space.ts";

interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

/** 按开关走 MarkdownBlock 的同款管线：normalize = 定界内侧空白规整，cjk = 插件挂否 */
const parse = (markdown: string, options: { cjk: boolean; normalize?: boolean }): Node => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(options.cjk ? [remarkCjkFriendly] : []);
  const text = options.normalize === false ? markdown : normalizeEmphasisInnerSpace(markdown);
  return processor.parse(text) as unknown as Node;
};

/** 树里（不含 code / inlineCode）有没有 strong，以及它的文字 */
const strongTexts = (node: Node, insideCode = false): string[] => {
  if (node.type === "code" || node.type === "inlineCode") return [];
  if (node.type === "strong") return [(node.children ?? []).map((child) => child.value ?? "").join("")];
  return (node.children ?? []).flatMap((child) => strongTexts(child, insideCode));
};

/** 指定类型节点的文本（找代码块 / 行内代码的原文用） */
const valuesOf = (node: Node, type: string): string[] => {
  if (node.type === type) return [node.value ?? ""];
  return (node.children ?? []).flatMap((child) => valuesOf(child, type));
};

describe("remark-cjk-friendly：中文加粗", () => {
  it("收尾 ** 前是空白（`**标题一般是加粗对象： **`）——原管线不加粗；规整后加粗", () => {
    const markdown = "**标题一般是加粗对象： **后文";
    deepStrictEqual(
      strongTexts(parse(markdown, { cjk: true, normalize: false })),
      [],
      "CommonMark（含 cjk 插件）下这不该加粗（复现 bug：插件不管空白）",
    );
    deepStrictEqual(strongTexts(parse(markdown, { cjk: true })), ["标题一般是加粗对象："]);
  });

  it("收尾 ** 前是中文标点、后紧接汉字（`**说明：**后文`）——插件修好（空白规整不参与）", () => {
    const markdown = "**说明：**后文继续";
    deepStrictEqual(
      strongTexts(parse(markdown, { cjk: false, normalize: false })),
      [],
      "CommonMark 下这不该加粗（复现 bug）",
    );
    deepStrictEqual(strongTexts(parse(markdown, { cjk: true, normalize: false })), ["说明："]);
  });

  it("普通加粗（中英）不受影响", () => {
    deepStrictEqual(strongTexts(parse("**加粗**", { cjk: true })), ["加粗"]);
    deepStrictEqual(strongTexts(parse("**bold**", { cjk: true })), ["bold"]);
    // 正文**中段**的空白不收——只动定界内侧
    deepStrictEqual(strongTexts(parse("**加 粗 文本**", { cjk: true })), ["加 粗 文本"]);
  });

  it("代码块与行内代码里的 `**…**` 原样保留，不被插件改动", () => {
    const markdown = [
      "前文 `**说明： **` 行内代码",
      "",
      "```text",
      "**说明： **不是加粗",
      "```",
      "",
      "**真正的加粗：**",
    ].join("\n");
    const tree = parse(markdown, { cjk: true });
    deepStrictEqual(valuesOf(tree, "inlineCode"), ["**说明： **"]);
    deepStrictEqual(valuesOf(tree, "code"), ["**说明： **不是加粗"]);
    deepStrictEqual(strongTexts(tree), ["真正的加粗："]);
  });
});
