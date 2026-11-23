import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forgetMissing, mergeView, parseBook, parseView, STATUS_VIEW_LIMIT, stringifyBook, writeView, type StatusBook, type StatusView } from "./chat-status-memory.ts";

describe("状态卡视图：规范形", () => {
  it("只留认识的字段，默认值不写", () => {
    const view = parseView({ closed: true, step: "s2", all: true, more: ["s2"], handed: ["s2", "s2"], goal: true, strips: { doc: 320, nope: 5, web: 0 }, scroll: 187.6, junk: 1 });
    assert.deepEqual(view, { closed: true, step: "s2", all: true, more: ["s2"], handed: ["s2"], goal: true, strips: { doc: 320 }, scroll: 188 });
    assert.equal(parseView({ closed: false, all: false, scroll: 0, strips: {}, more: [] }), undefined);
    assert.equal(parseView("x"), undefined);
    assert.equal(parseView([1]), undefined);
  });
  it("手改的坏值丢掉：超长 id、负数、NaN、非数组", () => {
    const view = parseView({ step: "x".repeat(500), scroll: -3, strips: { doc: Number.NaN }, more: "s1", handed: [1, "ok"] });
    assert.deepEqual(view, { handed: ["ok"] });
  });
  it("列表有长度上限", () => {
    const many = Array.from({ length: 100 }, (_, index) => `s${index}`);
    assert.equal(parseView({ more: many })?.more?.length, 40);
  });
});

describe("状态卡视图：改", () => {
  it("给值是设置，给 null 回默认；回到全默认就是 undefined", () => {
    let view: StatusView | undefined = mergeView(undefined, { closed: true });
    assert.deepEqual(view, { closed: true });
    view = mergeView(view, { step: "s3", scroll: 120 });
    assert.deepEqual(view, { closed: true, step: "s3", scroll: 120 });
    view = mergeView(view, { closed: null, step: null, scroll: null });
    assert.equal(view, undefined);
  });
  it("只改被点名的字段，别的原样", () => {
    const view = mergeView({ step: "s1", strips: { doc: 10 } }, { strips: { doc: 10, web: 40 } });
    assert.deepEqual(view, { step: "s1", strips: { doc: 10, web: 40 } });
  });
});

describe("状态卡视图：账本", () => {
  it("写进去、读回来；坏的丢、旧 → 新顺序保持", () => {
    let book: StatusBook = new Map();
    book = writeView(book, "a", { closed: true });
    book = writeView(book, "b", { step: "s1" });
    const back = parseBook(stringifyBook(book));
    assert.deepEqual([...back.keys()], ["a", "b"]);
    assert.deepEqual(back.get("b"), { step: "s1" });
    assert.equal(parseBook("{oops").size, 0);
    assert.equal(parseBook(null).size, 0);
    assert.deepEqual([...parseBook(JSON.stringify({ a: { closed: true }, b: 7, c: {} })).keys()], ["a"]);
  });
  it("没变且已是最近的就原样返回；变了或不是最近的挪到末尾", () => {
    const book = writeView(writeView(new Map(), "a", { closed: true }), "b", { goal: true });
    assert.equal(writeView(book, "b", { goal: true }), book);
    const moved = writeView(book, "a", { closed: true });
    assert.notEqual(moved, book);
    assert.deepEqual([...moved.keys()], ["b", "a"]);
  });
  it("回到全默认就删掉这条", () => {
    const book = writeView(new Map(), "a", { closed: true });
    assert.equal(writeView(book, "a", undefined).size, 0);
    const empty: StatusBook = new Map();
    assert.equal(writeView(empty, "zz", undefined), empty);
  });
  it("超过上限丢最早写的", () => {
    let book: StatusBook = new Map();
    for (let index = 0; index < STATUS_VIEW_LIMIT + 3; index += 1) book = writeView(book, `s${index}`, { goal: true });
    assert.equal(book.size, STATUS_VIEW_LIMIT);
    assert.equal(book.has("s0"), false);
    assert.equal(book.has(`s${STATUS_VIEW_LIMIT + 2}`), true);
  });
  it("会话被删了清掉；没有要清的原样返回", () => {
    const book = writeView(writeView(new Map(), "a", { goal: true }), "b", { goal: true });
    assert.equal(forgetMissing(book, new Set(["a", "b", "c"])), book);
    const next = forgetMissing(book, new Set(["b"]));
    assert.deepEqual([...next.keys()], ["b"]);
  });
});
