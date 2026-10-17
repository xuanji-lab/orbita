/**
 * 分块渲染与整篇渲染**必须渲染出同一棵 HTML**——分块只是换组件边界，不是换渲染结果。
 *
 * 这是 markdown-blocks.ts 那套「哪些边界不能切」规则的验收面：切错的表现就是这里的
 * 两串 HTML 不一样（比如 details 的内容漏到盒子外面、一个松散列表被拆成两个列表、
 * 缩进代码被拆成两个代码块）。插件链与 stream-render.ts / MarkdownBlock.tsx 的落定帧
 * 一致（bubble 变体不分块，不在此列）。
 *
 * 两串之间允许的差异只有换行：react-markdown 在块级兄弟之间插 `\n`，逐块渲染时块与块的
 * 接缝上没有它。块级元素之间的空白文本节点不参与排版，所以比较前把 `<pre>` 之外的换行
 * 抹掉（`<pre>` 里面的是代码内容，必须逐字比）。
 */
import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { splitMarkdownBlocks } from "./markdown-blocks.ts";
import { remarkDemoteBoundaryMath } from "./math-guard.ts";
import { rehypePluginsFor, streamRenderPolicy } from "./stream-render.ts";

/** MarkdownBlock 全量变体的 remark 链（引用标记那条实验链不在验收范围） */
const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkMath, remarkDemoteBoundaryMath];
const REHYPE_PLUGINS = rehypePluginsFor(false, streamRenderPolicy(false));

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, children: markdown }),
  );
}

/** 抹掉 `<pre>` 之外的换行（块级元素之间的排版空白，对渲染无影响） */
function normalize(html: string): string {
  return html
    .split(/(<pre[\s\S]*?<\/pre>)/g)
    .map((part) => (part.startsWith("<pre") ? part : part.replace(/\n/g, "")))
    .join("");
}

/** 整篇渲染 vs 逐块渲染：两边都要逐字一致 */
function expectSameHtml(markdown: string): void {
  const blocks = splitMarkdownBlocks(markdown);
  equal(blocks.join(""), markdown, "分块必须拼回原文");
  equal(normalize(blocks.map(render).join("")), normalize(render(markdown)), "分块渲染必须与整篇渲染一致");
}

const EQUIVALENT: Array<[string, string]> = [
  ["段落 + 围栏 + 段落", "前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后记"],
  ["围栏里的假围栏与空行", "````\n```\ninner\n\nstill inner\n````\n\n后记"],
  ["未闭合围栏吞到尾", "前言\n\n```\ncode\n\nmore"],
  ["块级公式跨空行", "前言\n\n$$\na\n\nb\n$$\n\n后记"],
  ["同行的行内公式", "钱是 $$x$$ 元\n\n后记"],
  ["details 跨空行", "<details>\n<summary>展开</summary>\n\n正文\n\n</details>\n\n后记"],
  ["details 不闭合", "<details>\n<summary>展开</summary>\n\n正文"],
  ["未闭合的 div", "<div>\n\n正文\n\n后记"],
  ["松散列表", "- a\n\n- b\n\n后记"],
  ["列表项缩进续行", "- item\n\n  continued\n\n后记"],
  ["嵌套列表续行", "1. a\n\n   - b\n\n后记"],
  ["引用里的松散列表", "> - a\n\n> - b\n\n后记"],
  ["HTML 块里的围栏不是围栏", "</div>\n```ts\na\n```\n\n后记"],
  ["HTML 块不能打断段落", "段落\n<br>\n\n```ts\na\n\nb\n```"],
  ["HTML 块里的注释不跨出块", "<br>\n<!--\n\n-->\n\n后记"],
  ["段落后粘着的 <br> 与围栏", "第一段。\n- item\n  more\n第二段\n<br>\n\n- a\n\n- b"],
  ["缩进代码块（两段）", "para\n\n    code\n\n    more\n\npara2"],
  ["段落后的缩进块", "para\n\n  x\n\npara2"],
  ["两个引用块", "> a\n\n> b\n\n后记"],
  ["表格 + 后记", "| a | b |\n|---|---|\n| 1 | 2 |\n\n后记"],
  ["setext 标题", "标题\n=====\n\n正文"],
  ["链接引用定义（退回单块）", "见 [x]\n\n[x]: http://a.com\n\n后记"],
  ["脚注（退回单块）", "见 [^1]\n\n[^1]: 注\n\n后记"],
  ["任务列表 + 加粗 + 行内代码", "- [ ] 待办 **加粗** `code`\n- [x] 完成\n\n后记"],
  ["fuzz 回归：段落后粘着的 <br> + 表格 + 未闭合围栏", "普通段落 54\n<br>\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n未闭合的围栏\n\n标题\n=====\n"],
  ["fuzz 回归：HTML 块 + 行内代码里的 div 跨块", "<br>\n`<div>` 是行内代码\n\n\n```\n未闭合的围栏\n\n~~~js\nlet x = 1;\n~~~\n"],
  ["fuzz 回归：注释块开在 HTML 块里", "<!--\n\n-->\n\n\n<br>\n<!--\n\n-->\n<br>\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n~~~js\nlet x = 1;\n~~~"],
  ["首尾空行", "\n\n前言\n\n后记\n\n"],
  [
    "长文档混合",
    [
      "# 标题",
      "",
      "第一段，带 `行内代码` 与 $x^2$。",
      "",
      "```python",
      "def f():",
      "",
      "    return 1",
      "```",
      "",
      "> 引用",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- 项一",
      "- 项二",
      "",
      "$$",
      "\\frac{a}{b}",
      "$$",
      "",
      "收尾段落",
      "",
    ].join("\n"),
  ],
];

describe("分块渲染与整篇渲染等价", () => {
  for (const [name, markdown] of EQUIVALENT) {
    it(name, () => {
      expectSameHtml(markdown);
    });
  }

  it("分块确实切开了（对照：长文档不是一块，否则这条测试是空转的）", () => {
    const markdown = EQUIVALENT[EQUIVALENT.length - 1]![1];
    ok(splitMarkdownBlocks(markdown).length > 4);
  });

  it("否定对照：朴素按空行切会让 details 的内容漏到盒子外（证明这条测试不是空转）", () => {
    const markdown = "<details>\n<summary>展开</summary>\n\n正文\n\n</details>\n\n后记";
    const naive = markdown.split(/\n\s*\n/).filter((part) => part !== "");
    ok(normalize(naive.map(render).join("")) !== normalize(render(markdown)));
  });
});
