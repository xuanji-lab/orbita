import { test } from "node:test";
import assert from "node:assert/strict";
import { formatExtract, normalizeText } from "./page-text.ts";
import type { DomNode } from "./dom-markdown.ts";

const page = { url: "https://example.com/", title: "Example" };

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
