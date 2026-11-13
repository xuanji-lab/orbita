import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWrite, createDeck } from "./slides-ops.ts";
import { renderDeckDocument, renderSlide, SLIDE_CSS } from "./slides-render.ts";

const ctxFor = (deck: ReturnType<typeof createDeck>) => ({
  deck,
  imageUrl: (src: string) => (src.endsWith("missing.png") ? null : `data:image/png;base64,AAAA#${src}`),
});

const sample = () =>
  applyWrite(createDeck({ title: "新加坡 <T>" }), [
    {
      at: 1,
      elements: [
        { kind: "text", html: "<b>标题</b><script>alert(1)</script>", x: 60, y: 40, w: 600, h: 100 },
        { kind: "image", src: "a.assets/p.png", x: 700, y: 100, w: 400, h: 300 },
        { kind: "image", src: "a.assets/missing.png" },
        { kind: "line", x: 100, y: 500, w: 400, h: 60, points: [[0, 60], [400, 0]], endArrow: "arrow", stroke: "#c2410c" },
        { kind: "table", rows: [["菜", "价格"], ["<i>鸡饭</i>", "4.5"]] },
        { kind: "shape", shape: "roundRect", text: "A & B" },
      ],
    },
  ]).deck;

describe("renderSlide", () => {
  const deck = sample();
  const html = renderSlide(deck.slides[0]!, ctxFor(deck));

  it("每种元素都有对应标记，箭头线带 marker-end", () => {
    assert.match(html, /class="sl-text"/);
    assert.match(html, /<img class="sl-img" src="data:image\/png/);
    assert.match(html, /sl-img-missing/);
    assert.match(html, /marker-end="url\(#mk-/);
    assert.match(html, /<table class="sl-table"/);
    assert.match(html, /<rect /);
  });

  it("用户文字被转义，脚本不出现", () => {
    assert.ok(!html.includes("<script"));
    assert.match(html, /A &amp; B/);
    assert.match(html, /&lt;i&gt;鸡饭&lt;\/i&gt;/);
  });

  it("页容器固定画布尺寸", () => {
    assert.match(html, /width:1280px;height:720px/);
  });
});

describe("renderDeckDocument", () => {
  const deck = sample();
  it("web：自包含、带翻页脚本；标题转义", () => {
    const doc = renderDeckDocument(deck, ctxFor(deck), "web");
    assert.match(doc, /<script>\(function/);
    assert.match(doc, /<title>新加坡 &lt;T&gt;<\/title>/);
    assert.ok(!/https?:\/\//.test(doc.replace(/xmlns="[^"]*"/g, "")), "不应引用外部资源");
  });
  it("print：@page 用画布尺寸、无脚本", () => {
    const doc = renderDeckDocument(deck, ctxFor(deck), "print");
    assert.match(doc, /@page\{size:1280px 720px/);
    assert.ok(!doc.includes("<script"));
  });
  it("png：只放指定的一页，整页放大 2 倍", () => {
    const two = applyWrite(deck, [{ at: "append", elements: [] }]).deck;
    const doc = renderDeckDocument(two, ctxFor(two), "png", 1);
    assert.equal((doc.match(/<section class="sl"/g) ?? []).length, 1);
    assert.match(doc, /width:2560px;height:1440px/);
  });
});

describe("居中文字里的列表标记跟着文字走", () => {
  const listDeck = applyWrite(createDeck({ title: "列表" }), [
    {
      at: 1,
      elements: [
        { kind: "text", html: "<ul><li>全年皆宜</li><li>地铁便捷</li></ul>", x: 80, y: 80, w: 800, h: 300, align: "center" },
        { kind: "text", html: "<ol><li>一</li></ol>", x: 80, y: 400, w: 800, h: 100, align: "right" },
        { kind: "text", html: "<ul><li>左对齐</li></ul>", x: 80, y: 520, w: 800, h: 100, align: "left" },
      ],
    },
  ]).deck;
  const html = renderSlide(listDeck.slides[0]!, ctxFor(listDeck));

  it("每个文字块带 data-align，居中 / 右对齐的列表用 inside 并去掉左缩进，左对齐保留悬挂缩进", () => {
    assert.match(html, /class="sl-text" data-align="center"/);
    assert.match(html, /class="sl-text" data-align="right"/);
    assert.match(html, /class="sl-text" data-align="left"/);
    assert.match(
      SLIDE_CSS,
      /\.sl-text\[data-align="center"\] \.sl-rich ul[^{]*\{padding-left:0;list-style-position:inside\}/,
    );
    assert.ok(!/data-align="left"\] \.sl-rich/.test(SLIDE_CSS), "左对齐不该被 inside 规则命中");
    assert.match(SLIDE_CSS, /\.sl-rich ul,\.sl-rich ol\{margin:0;padding-left:1\.3em\}/);
  });
});
