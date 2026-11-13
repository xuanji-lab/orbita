import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWrite, createDeck } from "../../../../shared/slides-ops.ts";
import { composeQuotedMessage, parseQuotedMessage } from "../../../../shared/quote.ts";
import { CANVAS_SIZE, normalizeElement, type SlideElement } from "../../../../shared/slides.ts";
import { elementPreview, quoteOfDeckPage } from "./slides-quote.ts";

const { deck } = applyWrite(createDeck({ title: "T" }), [
  { at: 1, elements: [{ kind: "text", id: "a", html: "封面" }] },
  { at: 2, elements: [{ kind: "text", id: "b", html: "<b>自然</b><br>花园" }, { kind: "image", id: "img", src: "x.assets/p.png" }, { kind: "line", id: "l", endArrow: "arrow" }] },
  { at: 3, elements: [] },
]);

describe("quoteOfDeckPage", () => {
  it("整页：带页号、各元素预览；没有 element", () => {
    const q = quoteOfDeckPage({ path: "/w/x.slides.json", deck, page: 2 });
    assert.equal(q?.slide, 2);
    assert.equal(q?.element, undefined);
    assert.match(q?.text ?? "", /自然\n花园\n\[图片 p\.png\]\n\[箭头\]/);
  });
  it("元素：带 element id，正文只含它", () => {
    const q = quoteOfDeckPage({ path: "/w/x.slides.json", deck, page: 2, elementId: "img" });
    assert.equal(q?.element, "img");
    assert.equal(q?.text, "[图片 p.png]");
  });
  it("空白页也能引；越界 null", () => {
    assert.ok((quoteOfDeckPage({ path: "/w/x.slides.json", deck, page: 3 })?.text ?? "").length > 0);
    assert.equal(quoteOfDeckPage({ path: "/w/x.slides.json", deck, page: 9 }), null);
  });
  it("发出去再解析回来：页号与元素 id 都在，模型据此 slides_read", () => {
    const q = quoteOfDeckPage({ path: "/w/花园.slides.json", deck, page: 2, elementId: "img" });
    assert.ok(q !== null);
    const message = composeQuotedMessage([q], "把这张图放大一点", { path: "/w/花园.slides.json", kind: "slides" });
    assert.match(message, /<quoted_file index="1" path="\/w\/花园\.slides\.json" slide="2" element="img">/);
    const parsed = parseQuotedMessage(message);
    assert.equal(parsed.quotes[0]?.slide, 2);
    assert.equal(parsed.quotes[0]?.element, "img");
    assert.equal(parsed.text, "把这张图放大一点");
  });
});

// 形状元素的必填字段交给规整函数补默认值（测试里不手写颜色 / 字号）
const shape = (kind: "rect" | "roundRect" | "ellipse" | "triangle", text?: string): SlideElement =>
  normalizeElement({ kind: "shape", shape: kind, ...(text === undefined ? {} : { text }) }, { canvas: CANVAS_SIZE["16:9"], theme: undefined });

describe("引用正文里元素的人话描述（不露 uuid 文件名与内部类型名）", () => {
  it("图片：有替代文字用替代文字；生成名（uuid / image-1）不露；真文件名照写", () => {
    const base = { kind: "image" as const, id: "i", x: 0, y: 0, w: 1, h: 1, fit: "cover" as const };
    assert.equal(elementPreview({ ...base, src: "d.assets/5bb5fadf-1ee2-4c8d-a3dd-1d47fc46a1ea.png" }), "[图片]");
    assert.equal(elementPreview({ ...base, src: "d.assets/image-3.png" }), "[图片]");
    assert.equal(elementPreview({ ...base, src: "d.assets/5bb5fadf-1ee2-4c8d-a3dd-1d47fc46a1ea.png", alt: "滨海湾夜景" }), "[图片 滨海湾夜景]");
    assert.equal(elementPreview({ ...base, src: "d.assets/hawker.jpg" }), "[图片 hawker.jpg]");
  });
  it("形状用中文名，带文字时接在后面", () => {
    assert.equal(elementPreview(shape("rect")), "[矩形]");
    assert.equal(elementPreview(shape("roundRect", "03 · 经济")), "[圆角矩形] 03 · 经济");
    assert.equal(elementPreview(shape("ellipse")), "[椭圆]");
    assert.equal(elementPreview(shape("triangle")), "[三角形]");
  });
  it("整页引用里不出现 [rect] 之类内部名", () => {
    const { deck: d } = applyWrite(createDeck({ title: "T" }), [
      { at: 1, elements: [{ kind: "shape", id: "r", shape: "rect" }, { kind: "text", id: "t", html: "标题" }] },
    ]);
    const q = quoteOfDeckPage({ path: "/w/x.slides.json", deck: d, page: 1 });
    assert.equal(q?.text, "[矩形]\n标题");
    assert.doesNotMatch(q?.text ?? "", /rect/);
  });
});
