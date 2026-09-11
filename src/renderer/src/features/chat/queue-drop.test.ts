/**
 * 拖拽落点语义：鼠标半行决定 before/after（与 Proma 同源）；落进源自己的缝返回 null；
 * 与 moveQueued 组合后，非 null 的落点必然换位（不再有「画了线松手却不动」）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dropPlacement } from "./queue-drop.ts";
import { createSessionStates, enqueue, moveQueued, type SessionStates } from "./session-states.ts";

describe("dropPlacement —— 鼠标半行定语义，源自己的缝为 null", () => {
  test("跨行：上半 before、下半 after，原样透传", () => {
    assert.equal(dropPlacement(2, 0, "before"), "before");
    assert.equal(dropPlacement(2, 0, "after"), "after");
    assert.equal(dropPlacement(0, 2, "before"), "before");
    assert.equal(dropPlacement(0, 2, "after"), "after");
  });

  test("拖到自己身上：null", () => {
    assert.equal(dropPlacement(1, 1, "before"), null);
    assert.equal(dropPlacement(1, 1, "after"), null);
  });

  test("源的上缝——悬在上一行的下半：null（丙在乙下面，丙拖到乙下半 = 丙本来的位置）", () => {
    assert.equal(dropPlacement(2, 1, "after"), null);
    // 同一行的上半是真的移动
    assert.equal(dropPlacement(2, 1, "before"), "before");
  });

  test("源的下缝——悬在下一行的上半：null（甲在乙上面，甲拖到乙上半 = 甲本来的位置）", () => {
    assert.equal(dropPlacement(0, 1, "before"), null);
    // 同一行的下半是真的移动
    assert.equal(dropPlacement(0, 1, "after"), "after");
  });
});

describe("dropPlacement × moveQueued —— 非 null 的落点必然换位", () => {
  const seed = (): SessionStates => {
    let states = createSessionStates();
    states = enqueue(states, "A", { id: "1", kind: "text", text: "甲" });
    states = enqueue(states, "A", { id: "2", kind: "text", text: "乙" });
    states = enqueue(states, "A", { id: "3", kind: "text", text: "丙" });
    return states;
  };
  const ids = (states: SessionStates): string[] =>
    (states.get("A")?.queued ?? []).map((item) => item.id);

  test("穷举 3 条队列的全部 (源, 目标, 半行) 组合：null ⇔ moveQueued 短路", () => {
    const states = seed();
    const queue = ids(states);
    for (let s = 0; s < 3; s += 1) {
      for (let t = 0; t < 3; t += 1) {
        for (const half of ["before", "after"] as const) {
          const placement = dropPlacement(s, t, half);
          const source = queue[s] as string;
          const target = queue[t] as string;
          const next = moveQueued(states, "A", source, target, half);
          if (placement === null) {
            assert.equal(next, states, `(${s},${t},${half}) 判 null 但 moveQueued 变了`);
          } else {
            assert.notEqual(next, states, `(${s},${t},${half}) 判 ${placement} 但 moveQueued 没变`);
          }
        }
      }
    }
  });

  test("五条队列：想把 E 放到 A、B 之间，悬 A 下半或 B 上半都行（表达力不丢）", () => {
    assert.equal(dropPlacement(4, 0, "after"), "after");
    assert.equal(dropPlacement(4, 1, "before"), "before");
  });
});
