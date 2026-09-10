import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planQueueCancel } from "./queue-cancel.ts";

describe("planQueueCancel", () => {
  test("steering 段的条目被移出，其余原样重放", () => {
    const plans = planQueueCancel(["s1"], ["f1", "f2"], 0, "s1");
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("followUp 段的条目被移出，steering 保持插队", () => {
    const plans = planQueueCancel(["s1", "s2"], ["f1"], 2, "f1");
    assert.deepEqual(plans, [
      { text: "s1", as: "steer" },
      { text: "s2", as: "steer" },
    ]);
  });

  test("index/text 与队列不符：原样重放（不丢别人的消息）", () => {
    const plans = planQueueCancel(["s1"], ["f1"], 5, "别的");
    assert.deepEqual(plans, [
      { text: "s1", as: "steer" },
      { text: "f1", as: "followUp" },
    ]);
  });

  test("空队列取消：返回空序列", () => {
    assert.deepEqual(planQueueCancel([], [], 0, "x"), []);
  });
});
