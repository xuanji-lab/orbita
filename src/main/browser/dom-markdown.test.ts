import { test } from "node:test";
import assert from "node:assert/strict";
import { domToMarkdown, normalizeMarkdown, type DomNode } from "./dom-markdown.ts";

/** 构造节点树的小工具：文本节点、元素节点（attrs 可选） */
function text(value: string): DomNode {
  return { tag: "#text", text: value };
}

function el(tag: string, children: DomNode[] = [], attrs?: DomNode["attrs"]): DomNode {
  return attrs === undefined ? { tag, children } : { tag, children, attrs };
}

/** body 包一层，模拟整页取到的根 */
function page(...children: DomNode[]): DomNode {
  return el("body", children);
}

test("标题：h1–h6 映射成对应层级；空标题丢掉", () => {
  const out = domToMarkdown(
    page(
      el("h1", [text("One")]),
      el("h2", [text("Two")]),
      el("h6", [text("Six")]),
      el("h3", [text("   ")]),
    ),
  );
  assert.equal(out, "# One\n\n## Two\n\n###### Six");
});

test("段落与容器：只有行内内容的 div 合成一段，含块级子节点的容器拆成多段", () => {
  const out = domToMarkdown(
    page(
      el("div", [text("Hello "), el("a", [text("world")], { href: "https://example.com/" })]),
      el("section", [el("p", [text("First")]), el("p", [text("Second")])]),
    ),
  );
  assert.equal(out, "Hello [world](https://example.com/)\n\nFirst\n\nSecond");
});

test("行内空白（含换行）折叠成一个空格，块尾 trim", () => {
  assert.equal(domToMarkdown(page(el("p", [text("  a \n   b  ")]))), "a b");
  assert.equal(domToMarkdown(page(el("p", [text("a"), el("br", []), text("b")]))), "a\nb");
});

test("无序与有序列表；嵌套列表缩进到父项文字之下", () => {
  const nested = el("ul", [
    el("li", [text("One")]),
    el("li", [text("Two"), el("ul", [el("li", [text("Two a")]), el("li", [text("Two b")])])]),
  ]);
  assert.equal(domToMarkdown(page(nested)), "- One\n- Two\n  - Two a\n  - Two b");
  assert.equal(domToMarkdown(page(el("ol", [el("li", [text("A")]), el("li", [text("B")])]))), "1. A\n2. B");
});

test("链接：文字与 URL 都在；空文字回落 URL；javascript: 只留文字；含空格的 URL 用尖括号包住", () => {
  const out = domToMarkdown(
    page(
      el("p", [
        el("a", [text("Paper")], { href: "https://doi.org/10.1/a" }),
        text(" "),
        el("a", [], { href: "https://example.com/x" }),
        text(" "),
        el("a", [text("go")], { href: "javascript:alert(1)" }),
        text(" "),
        el("a", [text("search")], { href: "https://example.com/?q=a b" }),
      ]),
    ),
  );
  assert.equal(
    out,
    "[Paper](https://doi.org/10.1/a) https://example.com/x go [search](<https://example.com/?q=a b>)",
  );
});

test("表格：GFM 管道表，缺格补空，单元格里的竖线与换行转义", () => {
  const table = el("table", [
    el("thead", [el("tr", [el("th", [text("Name")]), el("th", [text("Value")])])]),
    el("tbody", [
      el("tr", [el("td", [text("a|b")]), el("td", [text("1")])]),
      el("tr", [el("td", [text("c")])]),
    ]),
  ]);
  assert.equal(domToMarkdown(page(table)), "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c |  |");
});

test("强调、行内代码、代码块与删除线", () => {
  const out = domToMarkdown(
    page(
      el("p", [
        el("strong", [text("bold")]),
        text(" "),
        el("em", [text("italic")]),
        text(" "),
        el("code", [text("a`b")]),
        text(" "),
        el("del", [text("gone")]),
      ]),
      el("pre", [el("code", [text("const a = 1;\nconst b = 2;")])]),
    ),
  );
  assert.equal(out, "**bold** *italic* ``a`b`` ~~gone~~\n\n```\nconst a = 1;\nconst b = 2;\n```");
});

test("图片：正常出 ![alt](src)；data: 内联图只留 alt", () => {
  const out = domToMarkdown(
    page(
      el("p", [el("img", [], { alt: "chart", src: "https://example.com/a.png" })]),
      el("p", [el("img", [], { alt: "inline", src: "data:image/png;base64,AAAA" })]),
    ),
  );
  assert.equal(out, "![chart](https://example.com/a.png)\n\ninline");
});

test("空树、空页、纯空白：回空串", () => {
  assert.equal(domToMarkdown(null), "");
  assert.equal(domToMarkdown(undefined), "");
  assert.equal(domToMarkdown(page()), "");
  assert.equal(domToMarkdown(page(el("p", [text("   \n ")]))), "");
  assert.equal(domToMarkdown(el("div", [el("span", [text("\t")])])), "");
});

test("深层嵌套不炸：200 层 div 包一段文字仍能取到", () => {
  let node: DomNode = el("p", [text("deep")]);
  for (let i = 0; i < 200; i += 1) node = el("div", [node]);
  assert.equal(domToMarkdown(node), "deep");
});

test("normalizeMarkdown：空行压一个、行尾空白去掉、首尾 trim", () => {
  assert.equal(normalizeMarkdown("  a  \n\n\n\n b \n"), "a\n\n b");
});
