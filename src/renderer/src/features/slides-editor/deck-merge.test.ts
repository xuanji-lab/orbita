import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, applyWrite, createDeck } from "../../../../shared/slides-ops.ts";
import { serializeDeck, type Deck } from "../../../../shared/slides.ts";
import { mergeDecks, mergeDeckTexts } from "./deck-merge.ts";

const base = (): Deck =>
  applyWrite(createDeck({ title: "T" }), [1, 2, 3, 4].map((n) => ({ at: n, elements: [{ kind: "text", id: `t${n}`, html: `页${n}` }, { kind: "shape", id: `s${n}` }] }))).deck;

const textOf = (deck: Deck, page: number, id: string): string => {
  const el = deck.slides[page - 1]?.elements.find((e) => e.id === id);
  return el?.kind === "text" ? el.html : "";
};

describe("mergeDecks", () => {
  it("只有盘上改了 → 取盘上；只有本地改了 → 取本地", () => {
    const b = base();
    const disk = applyEdit(b, [{ op: "patch", slide: 2, id: "t2", patch: { html: "AGENT" } }]).deck;
    assert.equal(textOf(mergeDecks(b, b, disk), 2, "t2"), "AGENT");
    assert.equal(textOf(mergeDecks(b, disk, b), 2, "t2"), "AGENT");
  });

  it("不同页的改动都留下（用户在第 4 页拖，agent 改第 2 页标题）", () => {
    const b = base();
    const local = applyEdit(b, [{ op: "patch", slide: 4, id: "s4", patch: { x: 500 } }]).deck;
    const disk = applyEdit(b, [{ op: "patch", slide: 2, id: "t2", patch: { html: "城市长在花园里" } }]).deck;
    const merged = mergeDecks(b, local, disk);
    assert.equal(textOf(merged, 2, "t2"), "城市长在花园里");
    assert.equal(merged.slides[3]?.elements[1]?.x, 500);
  });

  it("同一页不同元素：并集；同一元素两边都改：本地优先", () => {
    const b = base();
    const local = applyEdit(b, [{ op: "patch", slide: 1, id: "t1", patch: { html: "LOCAL" } }]).deck;
    const disk = applyEdit(b, [
      { op: "patch", slide: 1, id: "t1", patch: { html: "DISK" } },
      { op: "patch", slide: 1, id: "s1", patch: { fill: "red" } },
    ]).deck;
    const merged = mergeDecks(b, local, disk);
    assert.equal(textOf(merged, 1, "t1"), "LOCAL");
    const shape = merged.slides[0]?.elements.find((e) => e.id === "s1");
    assert.equal(shape?.kind === "shape" && shape.fill, "red");
  });

  it("agent 加了结语页：用户的改动保留，新页在末尾", () => {
    const b = base();
    const local = applyEdit(b, [{ op: "patch", slide: 3, id: "t3", patch: { html: "我改的" } }]).deck;
    const disk = applyWrite(b, [{ elements: [{ kind: "text", id: "end", html: "结语" }] }]).deck;
    const merged = mergeDecks(b, local, disk);
    assert.equal(merged.slides.length, 5);
    assert.equal(textOf(merged, 3, "t3"), "我改的");
    assert.equal(textOf(merged, 5, "end"), "结语");
  });

  it("本地调过页序（拖缩略图）：用本地顺序，盘上的内容改动照并", () => {
    const b = base();
    const local = applyEdit(b, [{ op: "move_slide", slide: 1, to: 3 }]).deck;
    const disk = applyEdit(b, [{ op: "patch", slide: 1, id: "t1", patch: { html: "AGENT 改封面" } }]).deck;
    const merged = mergeDecks(b, local, disk);
    assert.deepEqual(merged.slides.map((s) => s.id), local.slides.map((s) => s.id));
    assert.equal(textOf(merged, 3, "t1"), "AGENT 改封面");
  });

  it("删除：一边删一边没动 = 删；一边删一边改了 = 保留改的", () => {
    const b = base();
    const local = applyEdit(b, [{ op: "delete", slide: 1, id: "s1" }]).deck;
    assert.equal(mergeDecks(b, local, b).slides[0]?.elements.length, 1);
    const disk = applyEdit(b, [{ op: "patch", slide: 1, id: "s1", patch: { fill: "green" } }]).deck;
    assert.equal(mergeDecks(b, local, disk).slides[0]?.elements.length, 2);
  });

  it("备注：本地没动则取盘上，本地改了则本地", () => {
    const b = base();
    const disk = applyEdit(b, [{ op: "set_slide", slide: 2, notes: "agent 备注" }]).deck;
    assert.equal(mergeDecks(b, applyEdit(b, [{ op: "patch", slide: 1, id: "t1", patch: { html: "x" } }]).deck, disk).slides[1]?.notes, "agent 备注");
    const local = applyEdit(b, [{ op: "set_slide", slide: 2, notes: "我的备注" }]).deck;
    assert.equal(mergeDecks(b, local, disk).slides[1]?.notes, "我的备注");
  });

  it("文本版：坏掉的一份文件不抛", () => {
    const b = base();
    const merged = mergeDeckTexts(serializeDeck(b), serializeDeck(b), "{oops");
    assert.equal(merged.slides.length, 4, "盘上那份坏了：本地原样保留，不被清空");
  });
});
