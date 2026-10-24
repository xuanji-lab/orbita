/**
 * markdown 顶层分块（markdown-blocks.ts）的最小可执行测试。
 *
 * 盯住两件事：
 * 1. **该切的切**：顶层空行是切点，前面已完成的块字符串不再变（流式 memo 的前提）；
 * 2. **不该切的绝不切**：围栏 / 块级公式 / 缩进续行 / 松散列表 / 跨块引用 / 块级 HTML
 *    ——切开会让「逐块渲染」与「整篇渲染」不等价（每一种都在这里钉一个用例）。
 *
 * 另有一条全局不变量：切出来的块是原文的连续子串，拼接逐字等于原文（空行不归一化）。
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { splitMarkdownBlocks } from "./markdown-blocks.ts";

/** 所有用例共用：块拼接必须逐字还原原文 */
function expectTiles(text: string, blocks: string[]): void {
  equal(blocks.join(""), text, "分块必须逐字拼回原文");
  for (const block of blocks) ok(block !== "", "空块没有意义（空串不该出现在结果里）");
}

describe("splitMarkdownBlocks", () => {
  it("空串不分块", () => {
    deepStrictEqual(splitMarkdownBlocks(""), []);
  });

  it("只有空行：一块（否则丢失内容）", () => {
    deepStrictEqual(splitMarkdownBlocks("\n\n"), ["\n\n"]);
  });

  it("普通段落按顶层空行切开，空行留在前一块里", () => {
    const text = "一\n\n二\n\n三";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["一\n\n", "二\n\n", "三"]);
    expectTiles(text, blocks);
  });

  it("连续多个空行是同一个切点，且不归一化（缩进代码块里的空行数是内容）", () => {
    const text = "一\n\n\n\n二";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["一\n\n\n\n", "二"]);
    expectTiles(text, blocks);
  });

  it("流式增长时前缀块的字符串逐字不变（memo 的前提）", () => {
    const first = splitMarkdownBlocks("前言\n\n尾");
    const second = splitMarkdownBlocks("前言\n\n尾继续");
    equal(first[0], second[0]);
    equal(first.length, second.length);
  });

  it("围栏代码块里的空行不是切点", () => {
    const text = "前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["前言\n\n", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("长围栏里的短围栏行不关闭它（``` 落在 ```` 里面）", () => {
    const text = "````\n```\ninner\n\nstill inner\n````\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["````\n```\ninner\n\nstill inner\n````\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("波浪线围栏里出现反引号不关闭它", () => {
    const text = "~~~\n```\n\nnot a close\n~~~\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["~~~\n```\n\nnot a close\n~~~\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("未闭合的围栏吞到消息末尾（不能把后半段切出去）", () => {
    const text = "前言\n\n```\ncode\n\nmore";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["前言\n\n", "```\ncode\n\nmore"]);
    expectTiles(text, blocks);
  });

  it("行首 ``` 的 info string 里再有反引号不算围栏（CommonMark）", () => {
    const text = "```foo``` 是行内代码\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["```foo``` 是行内代码\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("块级公式 $$ 里的空行不是切点", () => {
    const text = "前言\n\n$$\na\n\nb\n$$\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["前言\n\n", "$$\na\n\nb\n$$\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("同行的 $$x$$ 是行内公式，照常切", () => {
    const text = "钱是 $$x$$ 元\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["钱是 $$x$$ 元\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("未闭合的 $$ 吞到消息末尾", () => {
    const text = "前言\n\n$$\nx\n\nmore";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["前言\n\n", "$$\nx\n\nmore"]);
    expectTiles(text, blocks);
  });

  it("公式关闭行少于开启符数不关闭（$$$ 开的要 $$$ 关）", () => {
    const text = "$$$\nx\n$$\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["$$$\nx\n$$\n\n后记"]);
    expectTiles(text, blocks);
  });

  it("列表项的缩进续行并回它所属的块", () => {
    const text = "- 项目\n\n  续行\n\n  再续\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["- 项目\n\n  续行\n\n  再续\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("嵌套列表并回父列表", () => {
    const text = "1. a\n\n   - b\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["1. a\n\n   - b\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("引用里的松散列表同样是一块", () => {
    const text = "> - a\n\n> - b\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["> - a\n\n> - b\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("引用里的缩进续行并回它所属的列表项", () => {
    const text = "> - a\n\n>   cont\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["> - a\n\n>   cont\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("松散列表（项之间有空行）是一个块", () => {
    const text = "- a\n\n- b\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["- a\n\n- b\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("段落 / 标题后面的缩进块自成一块，缩进代码的后续行再并回去", () => {
    const text = "para\n\n    code\n\n    more\n\npara2";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["para\n\n", "    code\n\n    more\n\n", "para2"]);
    expectTiles(text, blocks);
  });

  it("段落 vs 列表项的缩进续行：只有容器里的续行才并", () => {
    // 段落后的缩进块没有容器可归属，切开与整篇等价；列表项后的缩进是列表内容，必须并
    deepStrictEqual(splitMarkdownBlocks("para\n\n  x"), ["para\n\n", "  x"]);
    deepStrictEqual(splitMarkdownBlocks("- item\n\n  x"), ["- item\n\n  x"]);
  });

  it("表格的表头与表体是一块", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["| a | b |\n|---|---|\n| 1 | 2 |\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("相邻两个空行分隔的引用块各是一块（CommonMark 里本来就是两个引用）", () => {
    const text = "> a\n\n> b\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["> a\n\n", "> b\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("链接引用定义：定义与使用会分处两块，整篇退回单块", () => {
    const text = "见 [x]\n\n[x]: http://a.com\n\n后记";
    deepStrictEqual(splitMarkdownBlocks(text), [text]);
  });

  it("脚注定义同样退回单块", () => {
    const text = "见 [^1]\n\n[^1]: 注\n\n后记";
    deepStrictEqual(splitMarkdownBlocks(text), [text]);
  });

  it("围栏里的 [x]: url 是代码、不是定义，照常切", () => {
    const text = "```md\n[x]: http://a.com\n```\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["```md\n[x]: http://a.com\n```\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("details 跨空行不切（rehype-raw 整篇解析会把内容吞进未闭合标签里）", () => {
    const text = "<details>\n<summary>展开</summary>\n\n正文\n\n</details>\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["<details>\n<summary>展开</summary>\n\n正文\n\n</details>\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("一直没闭合的块级标签吞到消息末尾", () => {
    const text = "<div>\n\n正文\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, [text]);
    expectTiles(text, blocks);
  });

  it("空元素（<br> / <hr>）不入栈，不影响分块", () => {
    const text = "<br>\n\n正文\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["<br>\n\n", "正文\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("跨空的 HTML 注释不切", () => {
    const text = "<!--\n\n-->\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["<!--\n\n-->\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("HTML 块里的行不是 markdown：粘在块级标签后面的围栏不算围栏", () => {
    const text = "</div>\n```ts\na\n```\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    // `</div>` 开的 HTML 块一直到空行都是原始文本，所以里面的 ``` 不是围栏，切点落在空行上
    deepStrictEqual(blocks, ["</div>\n```ts\na\n```\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("HTML 块不能打断段落：段落后面的 <br> 不开 HTML 块，后面的围栏照常", () => {
    const text = "段落\n<br>\n\n```ts\na\n\nb\n```";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["段落\n<br>\n\n", "```ts\na\n\nb\n```"]);
    expectTiles(text, blocks);
  });

  it("HTML 块里的 <!-- 不与后面的 --> 配对（注释块只在顶层开头）", () => {
    const text = "<br>\n<!--\n\n-->\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["<br>\n<!--\n\n", "-->\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("行内代码里的 <div> 不是标签（讲 HTML 语法时最常见）", () => {
    const text = "用 `<div>` 包一层\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["用 `<div>` 包一层\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("泛型的尖括号不触发 HTML 那套（<void> 不是块级标签）", () => {
    const text = "Promise<void> 的返回\n\n后记";
    const blocks = splitMarkdownBlocks(text);
    deepStrictEqual(blocks, ["Promise<void> 的返回\n\n", "后记"]);
    expectTiles(text, blocks);
  });

  it("首尾空行不产生空块，也不丢字符", () => {
    const text = "\n\n前言\n\n后记\n\n";
    const blocks = splitMarkdownBlocks(text);
    expectTiles(text, blocks);
    deepStrictEqual(blocks, ["\n\n前言\n\n", "后记\n\n"]);
  });

  it("一整个长文档：各块拼接逐字还原，且切点数与顶层结构一致", () => {
    const text = [
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
      "$$\n\\frac{a}{b}\n$$",
      "",
      "收尾段落",
      "",
    ].join("\n");
    const blocks = splitMarkdownBlocks(text);
    expectTiles(text, blocks);
    equal(blocks.length, 8);
  });
});
