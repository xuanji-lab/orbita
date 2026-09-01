import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planQueueEdit } from "./queue-edit.ts";

describe("planQueueEdit", () => {
  test("promote：followUp 段的目标提到 steer，其余各归各位", () => {
    const plans = planQueueEdit(["s1"], ["f1", "f2"], 2, "f2", "promote");
    assert.deepEqual(plans, [
      { text: "s1", as: "steer" },
      { text: "f1", as: "followUp" },
      { text: "f2", as: "steer" },
    ]);
  });

  test("cancel：目标被移出，其余原样重放", () => {
    const plans = planQueueEdit(["s1"], ["f1", "f2"], 0, "s1", "cancel");
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("promote 打在 steering 段上是 no-op（已在插队）", () => {
    const plans = planQueueEdit(["s1", "s2"], ["f1"], 1, "s2", "promote");
    assert.deepEqual(plans, [
      { text: "s1", as: "steer" },
      { text: "s2", as: "steer" },
      { text: "f1", as: "followUp" },
    ]);
  });

  test("index/text 与队列不符：原样重放（不丢别人的消息）", () => {
    const plans = planQueueEdit(["s1"], ["f1"], 5, "别的", "cancel");
    assert.deepEqual(plans, [
      { text: "s1", as: "steer" },
      { text: "f1", as: "followUp" },
    ]);
  });

  test("空队列编辑：返回空序列", () => {
    assert.deepEqual(planQueueEdit([], [], 0, "x", "cancel"), []);
  });
});
