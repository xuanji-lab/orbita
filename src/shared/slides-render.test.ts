import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWrite, createDeck } from "./slides-ops.ts";
import { renderDeckDocument, renderSlide } from "./slides-render.ts";

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
