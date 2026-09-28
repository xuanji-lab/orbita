import { test } from "node:test";
import assert from "node:assert/strict";
import { formatExtract, normalizeText } from "./page-text.ts";

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
