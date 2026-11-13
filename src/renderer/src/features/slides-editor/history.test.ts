import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COALESCE_MS, HISTORY_LIMIT, createHistory, pushState, redo, replacePresent, undo } from "./history.ts";

describe("history", () => {
  it("推入 / 撤销 / 重做；新改动清空重做栈", () => {
    let h = createHistory("a");
    h = pushState(h, "b", 0);
    h = pushState(h, "c", 10);
    h = undo(h);
    assert.equal(h.present, "b");
    h = redo(h);
    assert.equal(h.present, "c");
    h = undo(undo(h));
    assert.equal(h.present, "a");
    h = pushState(h, "z", 20);
    assert.deepEqual(h.future, []);
    assert.equal(undo(h).present, "a");
  });
  it("到头不动", () => {
    const h = createHistory("a");
    assert.equal(undo(h), h);
    assert.equal(redo(h), h);
  });
  it("同引用不入栈", () => {
    const h = createHistory({ n: 1 });
    assert.equal(pushState(h, h.present, 0), h);
  });
  it("同键连续改动合并成一步；超时或换键不合并", () => {
    let h = createHistory(0);
    h = pushState(h, 1, 0, "nudge");
    h = pushState(h, 2, 100, "nudge");
    h = pushState(h, 3, 200, "nudge");
    assert.equal(h.past.length, 1);
    assert.equal(undo(h).present, 0);
    h = pushState(h, 4, 200 + COALESCE_MS + 1, "nudge");
    assert.equal(h.past.length, 2);
    h = pushState(h, 5, 200 + COALESCE_MS + 2, "other");
    assert.equal(h.past.length, 3);
  });
  it("上限", () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) h = pushState(h, i, i * 10_000);
    assert.equal(h.past.length, HISTORY_LIMIT);
  });
  it("外部改动入栈后可撤销", () => {
    let h = createHistory("local");
    h = replacePresent(h, "agent");
    assert.equal(undo(h).present, "local");
  });
});
