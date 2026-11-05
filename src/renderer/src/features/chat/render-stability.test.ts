import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { keepUnlessSettledChanged, sameMap, sameSet, shareStructure } from "./render-stability.ts";

describe("keepUnlessSettledChanged", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c1 = { id: "c", text: "he" };
  const c2 = { id: "c", text: "hello" };

  test("只有末条换了引用（流式逐字增长）：交回上一份", () => {
    const prev = [a, b, c1];
    assert.equal(keepUnlessSettledChanged(prev, [a, b, c2]), prev);
  });

  test("新增条目、前面的条目换了引用、删了条目：交回新的", () => {
    const prev = [a, b, c1];
    const appended = [a, b, c1, c2];
    assert.equal(keepUnlessSettledChanged(prev, appended), appended);
    const midChanged = [a, { id: "b" }, c1];
    assert.equal(keepUnlessSettledChanged(prev, midChanged), midChanged);
    const shorter = [a, b];
    assert.equal(keepUnlessSettledChanged(prev, shorter), shorter);
  });

  test("空数组不当作「只变了末条」", () => {
    const empty: { id: string }[] = [];
    assert.equal(keepUnlessSettledChanged([a], empty), empty);
  });
});

describe("sameMap / sameSet", () => {
  test("键值按引用逐个比", () => {
    const v = { x: 1 };
    assert.equal(sameMap(new Map([["k", v]]), new Map([["k", v]])), true);
    assert.equal(sameMap(new Map([["k", v]]), new Map([["k", { x: 1 }]])), false);
    assert.equal(sameMap(new Map([["k", v]]), new Map([["j", v]])), false);
    assert.equal(sameMap(new Map([["k", undefined]]), new Map([["j", undefined]])), false);
    assert.equal(sameSet(new Set(["a", "b"]), new Set(["b", "a"])), true);
    assert.equal(sameSet(new Set(["a"]), new Set(["a", "b"])), false);
  });
});

describe("shareStructure", () => {
  const item = { role: "user", id: "u1", content: [{ type: "text", text: "hi" }] };

  test("结构相同：整体交回上一份", () => {
    const prev = [{ kind: "user", key: "u1", item }, { kind: "text", key: "a:0", text: "abc" }];
    const next = [{ kind: "user", key: "u1", item }, { kind: "text", key: "a:0", text: "abc" }];
    assert.equal(shareStructure(prev, next), prev);
  });

  test("只有末尾在长：前面的单元换回旧对象，末尾是新的，数组是新的", () => {
    const prev = [{ kind: "user", key: "u1", item }, { kind: "text", key: "a:0", text: "ab" }];
    const next = [{ kind: "user", key: "u1", item }, { kind: "text", key: "a:0", text: "abc" }];
    const shared = shareStructure(prev, next);
    assert.notEqual(shared, prev);
    assert.equal(shared[0], prev[0]);
    assert.equal(shared[1], next[1]);
    assert.deepEqual(shared, next);
  });

  test("嵌套数组（轮 → 步骤）里没变的部分也共享", () => {
    const step = (text: string) => ({ kind: "text", key: text, text });
    const prev = { kind: "turnProcess", steps: [step("a"), step("b")] };
    const next = { kind: "turnProcess", steps: [step("a"), step("b"), step("c")] };
    const shared = shareStructure(prev, next);
    assert.notEqual(shared, prev);
    assert.equal(shared.steps[0], prev.steps[0]);
    assert.equal(shared.steps[1], prev.steps[1]);
  });

  test("带 role 的对象（transcript 条目）按引用比，不换成内容相同的旧对象", () => {
    const clone = structuredClone(item);
    const prev = [{ kind: "user", key: "u1", item }];
    const next = [{ kind: "user", key: "u1", item: clone }];
    const shared = shareStructure(prev, next);
    assert.equal(shared[0]?.item, clone);
  });

  test("多出的键、少了的键都算变化", () => {
    const prev: Record<string, unknown> = { a: 1 };
    const more = { a: 1, b: 2 };
    assert.equal(shareStructure(prev, more), more);
    const fewer = {};
    assert.equal(shareStructure(prev, fewer), fewer);
  });

  test("Map 等非普通对象按引用比", () => {
    const m = new Map([["k", 1]]);
    const prev = { m };
    assert.equal(shareStructure(prev, { m }), prev);
    const m2 = new Map([["k", 1]]);
    assert.equal(shareStructure(prev, { m: m2 }).m, m2);
  });
});
