import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeckOpError, addSlide, applyEdit, applyWrite, createDeck, duplicateSlide, insertImage, lintSlide, slideTitle, summarizeDeck } from "./slides-ops.ts";

const deck5 = () => {
  const { deck } = applyWrite(createDeck({ title: "新加坡" }), [
    { at: 1, elements: [{ kind: "text", html: "封面", fontSize: 60 }] },
    ...[2, 3, 4, 5].map((at) => ({ at, elements: [{ kind: "text", html: `第${at}页` }] })),
  ]);
  return deck;
};

describe("applyWrite", () => {
  it("createDeck 有 1 页空白；at=1 替换它，其余 append → 5 页", () => {
    const deck = deck5();
    // 上面 at: 2..5 超出 末页+1 的会抛，所以这里验证连续写入是合法的
    assert.equal(deck.slides.length, 5);
  });

  it("at 超出末页 + 1 报错，不悄悄追加", () => {
    assert.throws(() => applyWrite(createDeck({ title: "x" }), [{ at: 5, elements: [] }]), DeckOpError);
  });

  it("省略 elements 只改备注，保留元素", () => {
    const deck = deck5();
    const out = applyWrite(deck, [{ at: 2, notes: "讲稿" }]).deck;
    assert.equal(out.slides[1]?.notes, "讲稿");
    assert.equal(out.slides[1]?.elements.length, 1);
    assert.equal(out.slides[1]?.id, deck.slides[1]?.id);
  });

  it("坏元素报错并带上位置，且不改动原 deck", () => {
    const deck = deck5();
    assert.throws(
      () => applyWrite(deck, [{ at: 1, elements: [{ kind: "image", src: "../x.png" }] }]),
      /slides\[0\]\.elements\[0\]/,
    );
    assert.equal(deck.slides[0]?.elements.length, 1);
  });

  it("append 与整页替换混用，返回写到的页号", () => {
    const out = applyWrite(deck5(), [{ at: 3, elements: [] }, { at: "append", elements: [{ kind: "shape", shape: "ellipse" }] }]);
    assert.deepEqual(out.pages, [3, 6]);
    assert.equal(out.deck.slides.length, 6);
  });
});

describe("applyEdit", () => {
  it("patch 改文字，id / kind 不可改", () => {
    const deck = deck5();
    const id = deck.slides[1]?.elements[0]?.id as string;
    const out = applyEdit(deck, [{ op: "patch", slide: 2, id, patch: { html: "城市长在花园里" } }]);
    assert.match(summarizeDeck(out.deck, 2), /城市长在花园里/);
    assert.throws(() => applyEdit(deck, [{ op: "patch", slide: 2, id, patch: { kind: "image" } }]), /不能改/);
    assert.deepEqual(out.pages, [2]);
  });

  it("元素不存在 / 页号越界给人话", () => {
    const deck = deck5();
    assert.throws(() => applyEdit(deck, [{ op: "delete", slide: 2, id: "nope" }]), /没有元素 nope/);
    assert.throws(() => applyEdit(deck, [{ op: "delete_slide", slide: 9 }]), /没有第 9 页/);
  });

  it("move_slide 调序、delete_slide 至少留一页", () => {
    const deck = deck5();
    const first = deck.slides[0]?.id;
    const out = applyEdit(deck, [{ op: "move_slide", slide: 1, to: 3 }]).deck;
    assert.equal(out.slides[2]?.id, first);
    const one = createDeck({ title: "x" });
    assert.throws(() => applyEdit(one, [{ op: "delete_slide", slide: 1 }]), /至少保留/);
  });

  it("set_deck 改比例后元素不丢", () => {
    const deck = deck5();
    const out = applyEdit(applyEdit(deck, [{ op: "set_deck", aspect: "4:3" }]).deck, [{ op: "set_deck", aspect: "16:9" }]).deck;
    assert.deepEqual(out.slides, deck.slides);
  });

  it("不可变：输入 deck 不被改", () => {
    const deck = deck5();
    const snapshot = JSON.stringify(deck);
    applyEdit(deck, [{ op: "add", slide: 1, element: { kind: "shape" } }]);
    assert.equal(JSON.stringify(deck), snapshot);
  });
});

describe("insertImage", () => {
  it("按原始比例放一个不超半幅的框，居中", () => {
    const deck = deck5();
    const { element } = insertImage(deck, 3, "a.assets/x.jpg", { w: 4000, h: 3000 });
    assert.ok(Math.abs(element.w / element.h - 4 / 3) < 0.01);
    assert.ok(element.w <= 640 && element.h <= 432);
    assert.ok(Math.abs(element.x + element.w / 2 - 640) < 1);
  });

  it("只给宽按比例补高；路径越界拒绝", () => {
    const deck = deck5();
    const { element } = insertImage(deck, 1, "a.assets/x.jpg", { w: 200, h: 100 }, { w: 400 });
    assert.equal(element.h, 200);
    assert.throws(() => insertImage(deck, 1, "../x.jpg", null), /相对路径/);
    assert.throws(() => insertImage(deck, 9, "a.assets/x.jpg", null), /没有第 9 页/);
  });
});

describe("摘要与页管理", () => {
  it("summarizeDeck 含页数、元素种类、箭头与备注", () => {
    const { deck } = applyWrite(createDeck({ title: "T" }), [
      { at: 1, notes: "备注", elements: [{ kind: "line", w: 300, h: 1, endArrow: "arrow" }, { kind: "table", rows: [["a", "b"], ["c", "d"]] }] },
    ]);
    const text = summarizeDeck(deck);
    assert.match(text, /1 slide\(s\)/);
    assert.match(text, /endArrow=arrow/);
    assert.match(text, /table id=\S+ .* 2×2/);
    assert.match(text, /备注/);
  });

  it("addSlide / duplicateSlide：复制换新 id", () => {
    const deck = deck5();
    const added = addSlide(deck, 0);
    assert.equal(added.index, 1);
    assert.equal(added.deck.slides.length, 6);
    const dup = duplicateSlide(deck, 0);
    assert.notEqual(dup.deck.slides[1]?.elements[0]?.id, deck.slides[0]?.elements[0]?.id);
    assert.equal(slideTitle(dup.deck.slides[1] as never), "封面");
  });
});

describe("lintSlide", () => {
  it("文字溢出框与伸出画布会被指出，正常的不报", () => {
    const { deck } = applyWrite(createDeck({ title: "x" }), [
      {
        at: 1,
        elements: [
          { kind: "text", html: "很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长", x: 60, y: 60, w: 200, h: 40, fontSize: 28 },
          { kind: "text", html: "短", x: 60, y: 200, w: 400, h: 60, fontSize: 28 },
          { kind: "shape", x: 1200, y: 600, w: 200, h: 200 },
        ],
      },
    ]);
    const issues = lintSlide(deck, 1);
    assert.equal(issues.length, 2);
    assert.match(issues[0] as string, /probably overflows/);
    assert.match(issues[1] as string, /extends past/);
  });
});
