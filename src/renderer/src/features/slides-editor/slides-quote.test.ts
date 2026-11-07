import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWrite, createDeck } from "../../../../shared/slides-ops.ts";
import { composeQuotedMessage, parseQuotedMessage } from "../../../../shared/quote.ts";
import { quoteOfDeckPage } from "./slides-quote.ts";

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
