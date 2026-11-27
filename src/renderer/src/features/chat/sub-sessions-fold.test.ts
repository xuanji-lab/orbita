import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFoldBook, SUBSESSION_FOLD_LIMIT, toggleFold, writeFold } from "./sub-sessions-fold.ts";

describe("子会话面板的组开合按母会话记住", () => {
  it("写进去、读回来；坏数据当空", () => {
    const book = writeFold({}, "p1", new Set(["handed"]));
    assert.deepEqual(parseFoldBook(JSON.stringify(book)), { p1: ["handed"] });
    assert.deepEqual(parseFoldBook("{oops"), {});
    assert.deepEqual(parseFoldBook(JSON.stringify({ p1: ["handed", "nope", 3] })), { p1: ["handed"] });
  });
  it("收起过（空集合）也记，不回默认", () => {
    assert.deepEqual(writeFold({ p1: ["handed"] }, "p1", new Set()), { p1: [] });
  });
  it("超过上限丢最早写的；重写的挪到最近", () => {
    let book = {};
    for (let i = 0; i < SUBSESSION_FOLD_LIMIT + 2; i += 1) book = writeFold(book, `p${i}`, new Set(["handed"]));
    assert.equal(Object.keys(book).length, SUBSESSION_FOLD_LIMIT);
    assert.equal("p0" in book, false);
    book = writeFold(book, "p2", new Set());
    assert.equal(Object.keys(book).at(-1), "p2");
  });
  it("翻一组", () => {
    assert.deepEqual([...toggleFold(new Set(["handed"]), "handed")], []);
    assert.deepEqual([...toggleFold(new Set(), "stopped")], ["stopped"]);
  });
});
