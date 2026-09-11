/**
 * 拖拽落点语义：落到谁身上就占谁的位置（与 Providers 的 reorderIds 同义）；
 * 与 moveQueued 组合后，源≠目标必然换位，且源最终落在目标原来的下标上。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dropPlacement } from "./queue-drop.ts";
import { createSessionStates, enqueue, moveQueued, type SessionStates } from "./session-states.ts";

describe("dropPlacement —— 源与目标的相对位置定 before/after", () => {
  test("源在上方：after（目标前移一格，源占目标原下标）", () => {
    assert.equal(dropPlacement(0, 2), "after");
    assert.equal(dropPlacement(0, 1), "after");
  });

  test("源在下方：before", () => {
    assert.equal(dropPlacement(2, 0), "before");
    assert.equal(dropPlacement(1, 0), "before");
  });

  test("拖到自己身上：null", () => {
    assert.equal(dropPlacement(1, 1), null);
  });
});

describe("dropPlacement × moveQueued —— 源落到目标原来的下标上", () => {
  const seed = (): SessionStates => {
    let states = createSessionStates();
    states = enqueue(states, "A", { id: "1", kind: "text", text: "甲" });
    states = enqueue(states, "A", { id: "2", kind: "text", text: "乙" });
    states = enqueue(states, "A", { id: "3", kind: "text", text: "丙" });
    states = enqueue(states, "A", { id: "4", kind: "text", text: "丁" });
    return states;
  };
  const ids = (states: SessionStates): string[] =>
    (states.get("A")?.queued ?? []).map((item) => item.id);

  test("穷举 4 条队列全部 (源, 目标) 组合：源≠目标必然换位，且源落在目标原下标", () => {
    const states = seed();
    const queue = ids(states);
    for (let s = 0; s < 4; s += 1) {
      for (let t = 0; t < 4; t += 1) {
        const placement = dropPlacement(s, t);
        const source = queue[s] as string;
        const target = queue[t] as string;
        if (placement === null) {
          assert.equal(s, t);
          continue;
        }
        const next = moveQueued(states, "A", source, target, placement);
        assert.notEqual(next, states, `(${s}→${t}) 没变`);
        assert.equal(ids(next)[t], source, `(${s}→${t}) 源没落在目标原下标 ${t}`);
        assert.equal(ids(next).length, 4);
      }
    }
  });

  test("相邻行上拖 / 下拖都换位——不再有死区", () => {
    assert.deepEqual(ids(moveQueued(seed(), "A", "3", "2", dropPlacement(2, 1) as "before")), ["1", "3", "2", "4"]);
    assert.deepEqual(ids(moveQueued(seed(), "A", "2", "3", dropPlacement(1, 2) as "after")), ["1", "3", "2", "4"]);
  });
});
