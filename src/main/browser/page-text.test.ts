import { test } from "node:test";
import assert from "node:assert/strict";
import { formatExtract, normalizeText, SERIALIZE_TREE_FN } from "./page-text.ts";
import { domToMarkdown, type DomNode } from "./dom-markdown.ts";

const page = { url: "https://example.com/", title: "Example" };

// ── 页内序列化脚本的假 DOM 夹具 ────────────────────────────────────────
// SERIALIZE_TREE_FN 只依赖 this 与节点的形状（nodeType / tagName / childNodes / getAttribute…），
// 不碰 document（this 是元素时那条回落分支不执行），所以在 node --test 里能拿假节点真跑一遍。

interface FakeNode {
  nodeType: number;
  nodeValue?: string;
  tagName?: string;
  hidden?: boolean;
  childNodes: FakeNode[];
  href?: string;
  currentSrc?: string;
  src?: string;
  getAttribute(name: string): string | null;
}

function fakeText(value: string): FakeNode {
  return { nodeType: 3, nodeValue: value, childNodes: [], getAttribute: () => null };
}

function fakeElement(tag: string, childNodes: FakeNode[] = [], attributes: Record<string, string> = {}): FakeNode {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    hidden: Object.prototype.hasOwnProperty.call(attributes, "hidden"),
    childNodes,
    href: attributes["href"],
    currentSrc: attributes["src"],
    src: attributes["src"],
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

/** 在假 DOM 上真跑一遍页内序列化脚本 */
function serialize(root: FakeNode): { root: DomNode | null; truncated: boolean } {
  const serializer = new Function("return " + SERIALIZE_TREE_FN)() as (this: FakeNode) => {
    root: DomNode | null;
    truncated: boolean;
  };
  return serializer.call(root);
}

test("页内序列化：空白文本节点保留（相邻行内元素不会粘成一个词）", () => {
  const body = fakeElement("body", [
    fakeElement("p", [fakeElement("span", [fakeText("a")]), fakeText(" "), fakeElement("span", [fakeText("b")])]),
  ]);
  const tree = serialize(body);
  const paragraph = tree.root?.children?.[0];
  assert.equal(paragraph?.tag, "p");
  assert.deepEqual(paragraph?.children?.map((node) => node.tag), ["span", "#text", "span"]);
  assert.equal(paragraph?.children?.[1]?.text, " ");
});

test("页内序列化：script / style / hidden / 内联 display:none 跳过，正文留下", () => {
  const body = fakeElement("body", [
    fakeElement("script", [fakeText("alert(1)")]),
    fakeElement("style", [fakeText("a{}")]),
    fakeElement("div", [fakeText("hidden 属性")], { hidden: "" }),
    fakeElement("div", [fakeText("内联 display:none")], { style: "display: none" }),
    fakeElement("p", [fakeText("正文")]),
  ]);
  const tree = serialize(body);
  assert.deepEqual(tree.root?.children?.map((node) => node.tag), ["p"]);
  assert.equal(tree.root?.children?.[0]?.children?.[0]?.text, "正文");
});

test("评审阻断样例 1：li 里的行内链接经真实序列化脚本后仍是一句话", () => {
  const body = fakeElement("body", [
    fakeElement("ul", [
      fakeElement("li", [
        fakeText("Read "),
        fakeElement("a", [fakeText("docs")], { href: "https://x.com/" }),
        fakeText(" now"),
      ]),
    ]),
  ]);
  const tree = serialize(body);
  assert.equal(domToMarkdown(tree.root), "- Read [docs](https://x.com/) now");
});

test("评审阻断样例 2：div 里行内内容后接段落，行内那句不被拆开", () => {
  const body = fakeElement("body", [
    fakeElement("div", [
      fakeText("See "),
      fakeElement("a", [fakeText("the docs")], { href: "https://x.com/" }),
      fakeText(" for details."),
      fakeElement("p", [fakeText("Next para")]),
    ]),
  ]);
  const tree = serialize(body);
  assert.equal(domToMarkdown(tree.root), "See [the docs](https://x.com/) for details.\n\nNext para");
});

test("页内序列化：代码块里的缩进 / 换行原样保留", () => {
  const body = fakeElement("body", [
    fakeElement("pre", [fakeElement("code", [fakeText("  const a = 1;\n  const b = 2;")])]),
  ]);
  const tree = serialize(body);
  assert.equal(tree.root?.children?.[0]?.children?.[0]?.children?.[0]?.text, "  const a = 1;\n  const b = 2;");
});

test("normalizeText：空行压一个、行尾空白去掉、CRLF 统一", () => {
  assert.equal(normalizeText("  a  \r\n\r\n\r\n\nb\t\n c "), "a\n\nb\n c");
});

test("整页放得下：标注到页尾，正文包在不可信标签里", () => {
  const out = formatExtract(page, { text: "Hello\n\n\n\nworld", links: [] }, {});
  assert.match(out, /^URL: https:\/\/example\.com\/\nTitle: Example\n/);
  assert.match(out, /characters 0–12 of 12 \(end of page\)/);
  assert.match(out, /<page-text untrusted>\nHello\n\nworld\n<\/page-text>/);
  assert.doesNotMatch(out, /page-links/);
});

test("分段：给出下一段的 offset；offset 越界夹到末尾；maxChars 夹在 1000–50000", () => {
  const text = "x".repeat(5000);
  const first = formatExtract(page, { text, links: [] }, { maxChars: 10 });
  assert.match(first, /characters 0–1000 of 5000\. Call browser_extract with offset 1000/);
  const tail = formatExtract(page, { text, links: [] }, { offset: 99999 });
  assert.match(tail, /characters 5000–5000 of 5000 \(end of page\)/);
  const big = formatExtract(page, { text: "y".repeat(80000), links: [] }, { maxChars: 1e9 });
  assert.match(big, /characters 0–50000 of 80000/);
});

test("空页：说明可能的原因，不输出空的正文标签", () => {
  const out = formatExtract(page, { text: "   \n ", links: [] }, {});
  assert.match(out, /no visible text/);
  assert.doesNotMatch(out, /<page-text/);
});

test("links：列出文字与地址；无文字只列地址；没有链接如实说", () => {
  const out = formatExtract(
    page,
    { text: "t", links: [["Paper A", "https://doi.org/10.1/a"], ["", "https://example.com/x"]] },
    { links: true },
  );
  assert.match(out, /<page-links untrusted count="2">\n- Paper A — https:\/\/doi\.org\/10\.1\/a\n- https:\/\/example\.com\/x\n<\/page-links>/);
  assert.match(formatExtract(page, { text: "t", links: [] }, { links: true }), /No links on the page\./);
});

const tree = (children: DomNode[]): DomNode => ({ tag: "body", children });

/** 一棵小页面：标题、段落、列表、表格、链接 */
function sampleTree(): DomNode {
  return tree([
    { tag: "h1", children: [{ tag: "#text", text: "Title" }] },
    {
      tag: "p",
      children: [
        { tag: "#text", text: "See " },
        { tag: "a", children: [{ tag: "#text", text: "the paper" }], attrs: { href: "https://doi.org/10.1/a" } },
      ],
    },
    { tag: "ul", children: [{ tag: "li", children: [{ tag: "#text", text: "One" }] }] },
    {
      tag: "table",
      children: [
        { tag: "tr", children: [{ tag: "th", children: [{ tag: "#text", text: "A" }] }, { tag: "th", children: [{ tag: "#text", text: "B" }] }] },
        { tag: "tr", children: [{ tag: "td", children: [{ tag: "#text", text: "1" }] }, { tag: "td", children: [{ tag: "#text", text: "2" }] }] },
      ],
    },
  ]);
}

test("markdown：保留标题 / 列表 / 链接 / 表格，正文包在 page-markdown 里", () => {
  const out = formatExtract(page, { text: "", links: [], tree: sampleTree() }, { format: "markdown" });
  assert.match(out, /^URL: https:\/\/example\.com\/\nTitle: Example\nMarkdown: characters 0–/);
  assert.match(out, /<page-markdown untrusted>\n# Title\n\nSee \[the paper\]\(https:\/\/doi\.org\/10\.1\/a\)\n\n- One\n\n\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|\n<\/page-markdown>/);
  assert.doesNotMatch(out, /page-text/);
});

test("markdown：超长内容照旧按 offset / maxChars 分段", () => {
  const long = tree([{ tag: "p", children: [{ tag: "#text", text: "x".repeat(5000) }] }]);
  const first = formatExtract(page, { text: "", links: [], tree: long }, { format: "markdown", maxChars: 10 });
  assert.match(first, /Markdown: characters 0–1000 of 5000\. Call browser_extract with offset 1000/);
  const tail = formatExtract(page, { text: "", links: [], tree: long }, { format: "markdown", offset: 99999 });
  assert.match(tail, /Markdown: characters 5000–5000 of 5000 \(end of page\)/);
});

test("markdown：树被截断时明说；空树回空页说明", () => {
  const cut = formatExtract(page, { text: "", links: [], tree: sampleTree(), treeTruncated: true }, { format: "markdown" });
  assert.match(cut, /only the first part of its structure was converted/);
  const empty = formatExtract(page, { text: "", links: [], tree: null }, { format: "markdown" });
  assert.match(empty, /no visible text/);
  assert.doesNotMatch(empty, /<page-markdown/);
});
