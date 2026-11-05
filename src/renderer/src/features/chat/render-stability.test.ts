import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { keepUnlessSettledChanged, sameMap, sameSet, shareStructure } from "./render-stability.ts";

describe("keepUnlessSettledChanged", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c1 = { id: "c", text: "he" };
  const c2 = { id: "c", text: "hello" };
  const sameId = (x: { id: string }, y: { id: string }): boolean => x.id === y.id;

  test("只有末条换了引用（流式逐字增长）：交回上一份", () => {
    const prev = [a, b, c1];
    assert.equal(keepUnlessSettledChanged(prev, [a, b, c2], sameId), prev);
  });

  test("新增条目、前面的条目换了引用、删了条目：交回新的", () => {
    const prev = [a, b, c1];
    const appended = [a, b, c1, c2];
    assert.equal(keepUnlessSettledChanged(prev, appended, sameId), appended);
    const midChanged = [a, { id: "b" }, c1];
    assert.equal(keepUnlessSettledChanged(prev, midChanged, sameId), midChanged);
    const shorter = [a, b];
    assert.equal(keepUnlessSettledChanged(prev, shorter, sameId), shorter);
  });

  test("空数组不当作「只变了末条」", () => {
    const empty: { id: string }[] = [];
    assert.equal(keepUnlessSettledChanged([a], empty, sameId), empty);
  });

  test("长度 1：换成另一条不同 id 的条目（切到另一条只有一条记录的会话）交回新的", () => {
    // 修前长度 1 的数组一轮循环都不跑，任何替换都被当成「末条在长」而停在旧会话
    // 的那条上——B 的记忆行按 A 的用户 id 配对、引用跳转在 B 里找 A 的消息
    const prev = [a];
    const next = [{ id: "别家的消息" }];
    assert.equal(keepUnlessSettledChanged(prev, next, sameId), next);
  });

  test("长度 1：末条同 id 只换了引用（同一条还在长）交回上一份", () => {
    const prev = [c1];
    assert.equal(keepUnlessSettledChanged(prev, [c2], sameId), prev);
  });

  test("末条整条换成不同 id 的条目：不论长短都交回新的", () => {
    // 长度 >1 时前面每条都同引用、末条却已是另一条——不足「只有末条在长」",
    // 交回新的；未来若出现末条被替换的形态也不误判
    const prev = [a, b, c1];
    const replaced = [a, b, { id: "别家", text: "…" }];
    assert.equal(keepUnlessSettledChanged(prev, replaced, sameId), replaced);
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
