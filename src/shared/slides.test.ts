import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ElementError,
  normalizeElement,
  parseDeck,
  parseRichText,
  plainToRichHtml,
  richTextToPlain,
  safeColor,
  safeRelativePath,
  sanitizeRichHtml,
  serializeDeck,
} from "./slides.ts";

const ctx = { canvas: { w: 1280, h: 720 } };

describe("sanitizeRichHtml", () => {
  it("<script> 与 <img onerror> 不会原样留下", () => {
    const out = sanitizeRichHtml('hi<script>alert(1)</script><img src=x onerror="alert(2)">there');
    assert.ok(!/script|onerror|<img|alert/i.test(out), out);
    assert.equal(richTextToPlain(out), "hithere");
  });

  it("事件属性、href、class 不透传；span 只留白名单样式", () => {
    const out = sanitizeRichHtml('<span onclick="x()" class="a" style="color:#ff0000;position:fixed;font-size:20px">红</span><a href="javascript:alert(1)">链</a>');
    assert.ok(!/onclick|class=|position|href|javascript/i.test(out), out);
    assert.match(out, /color:#ff0000/);
    assert.match(out, /font-size:20px/);
    assert.equal(richTextToPlain(out), "红链");
  });

  it("颜色里夹带 url() / expression 被拒", () => {
    assert.equal(safeColor("url(javascript:1)", "#000"), "#000");
    assert.equal(safeColor("red;background:url(x)", "#000"), "#000");
    assert.equal(safeColor("#abc", "#000"), "#abc");
    assert.equal(safeColor("rgba(1,2,3,0.5)", "#000"), "rgba(1,2,3,0.5)");
  });

  it("加粗 / 斜体 / 下划线与列表往返不丢", () => {
    const html = "<b>粗</b><br><i>斜</i><u>下</u><ul><li>一</li><li>二</li></ul>";
    const out = sanitizeRichHtml(html);
    assert.equal(out, "<b>粗</b><br><i>斜</i><u>下</u><ul><li>一</li><li>二</li></ul>");
    const paragraphs = parseRichText(out);
    assert.equal(paragraphs.length, 4);
    assert.equal(paragraphs[2]?.list, "bullet");
  });

  it("contenteditable 的 div 行也能读成段落", () => {
    assert.equal(richTextToPlain("第一行<div>第二行</div><div><br></div><div>第四行</div>"), "第一行\n第二行\n\n第四行");
  });

  it("文字里的 < & 被转义而不是变标签", () => {
    const out = sanitizeRichHtml("a &lt; b &amp; c < d");
    assert.equal(richTextToPlain(out), "a < b & c < d");
    assert.ok(!out.includes("< d"));
  });

  it("纯文字多行 → 规范 HTML 再读回一致", () => {
    assert.equal(richTextToPlain(plainToRichHtml("一\n\n三")), "一\n\n三");
  });
});

describe("safeRelativePath", () => {
  it("相对路径放行，越界 / 绝对 / 协议拒绝", () => {
    assert.equal(safeRelativePath("a.assets/x.png"), "a.assets/x.png");
    assert.equal(safeRelativePath("a.assets\\x.png"), "a.assets/x.png");
    for (const bad of ["../../etc/passwd", "a/../../b", "/etc/passwd", "C:\\x.png", "file:///x", "http://x/y.png", "", "a//b", "a\0b"]) {
      assert.equal(safeRelativePath(bad), null, bad);
    }
  });
});

describe("normalizeElement", () => {
  it("image.src 逃出目录 → ElementError", () => {
    assert.throws(() => normalizeElement({ kind: "image", src: "../../x.png" }, ctx), ElementError);
  });

  it("未知 kind / 非对象 → ElementError", () => {
    assert.throws(() => normalizeElement({ kind: "video" }, ctx), ElementError);
    assert.throws(() => normalizeElement(null, ctx), ElementError);
  });

  it("text 补默认值并 sanitize", () => {
    const el = normalizeElement({ kind: "text", html: "<b>x</b><script>1</script>" }, ctx);
    assert.equal(el.kind === "text" && el.html, "<b>x</b>");
    assert.equal(el.kind === "text" && el.fontSize, 28);
  });

  it("表格行长不齐补空、列宽归一化", () => {
    const el = normalizeElement({ kind: "table", rows: [["a", "b", "c"], ["d"]], colWidths: [1, 1, 2] }, ctx);
    assert.ok(el.kind === "table");
    assert.deepEqual(el.rows[1], ["d", "", ""]);
    assert.deepEqual(el.colWidths, [0.25, 0.25, 0.5]);
    assert.throws(() => normalizeElement({ kind: "table", rows: [] }, ctx), ElementError);
  });

  it("line 带箭头头与默认起止点", () => {
    const el = normalizeElement({ kind: "line", x: 10, y: 10, w: 300, h: 1, endArrow: "arrow" }, ctx);
    assert.ok(el.kind === "line");
    assert.equal(el.endArrow, "arrow");
    assert.deepEqual(el.points[1], [300, 1]);
  });

  it("数值夹到范围内、非有限数回默认", () => {
    const el = normalizeElement({ kind: "shape", x: Number.NaN, w: 1e9, strokeWidth: -5 }, ctx);
    assert.equal(el.x, 80);
    assert.equal(el.w, 5120);
    assert.ok(el.kind === "shape" && el.strokeWidth === 0);
  });
});

describe("parseDeck / serializeDeck", () => {
  it("往返稳定", () => {
    const text = JSON.stringify({ version: 1, title: "T", aspect: "4:3", slides: [{ id: "s1", elements: [{ kind: "text", id: "e1", html: "hi" }], notes: "n" }] });
    const { deck } = parseDeck(text);
    assert.equal(deck.aspect, "4:3");
    const again = parseDeck(serializeDeck(deck)).deck;
    assert.deepEqual(again, deck);
  });

  it("坏元素丢弃并警告，文件仍可打开；重复 id 换新", () => {
    const { deck, warnings } = parseDeck(
      JSON.stringify({ title: "x", slides: [{ elements: [{ kind: "nope" }, { kind: "text", id: "a" }, { kind: "text", id: "a" }] }, { id: "dup" }, { id: "dup" }] }),
    );
    assert.equal(warnings.length, 1);
    assert.equal(deck.slides[0]?.elements.length, 2);
    assert.notEqual(deck.slides[0]?.elements[0]?.id, deck.slides[0]?.elements[1]?.id);
    assert.notEqual(deck.slides[1]?.id, deck.slides[2]?.id);
  });

  it("不是 JSON / 不是对象 → 抛", () => {
    assert.throws(() => parseDeck("{oops"), /JSON/);
    assert.throws(() => parseDeck("[]"), /对象/);
  });

  it("空对象也能开（0 页）", () => {
    assert.equal(parseDeck("{}").deck.slides.length, 0);
  });
});
