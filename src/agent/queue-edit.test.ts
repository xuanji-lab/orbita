import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planQueueEdit } from "./queue-edit.ts";

describe("planQueueEdit · cancel", () => {
  test("目标被移出，其余原样重放", () => {
    const plans = planQueueEdit(["s1"], ["f1", "f2"], 0, "s1", "cancel");
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("目标不在队列里：原样重放（不丢别人的消息）", () => {
    const plans = planQueueEdit(["s1"], ["f1"], 5, "别的", "cancel");
    assert.deepEqual(plans, [
      { text: "s1", as: "steer" },
      { text: "f1", as: "followUp" },
    ]);
  });

  test("下标过期但文本还在：按文本找回来，撤回不落空", () => {
    // 与 interrupt 同源的竞态：前面有条目被拿走，后面的下标全前移
    const plans = planQueueEdit([], ["f1", "f2"], 5, "f2", "cancel");
    assert.deepEqual(plans, [{ text: "f1", as: "followUp" }]);
  });

  test("空队列：返回空序列", () => {
    assert.deepEqual(planQueueEdit([], [], 0, "x", "cancel"), []);
  });
});

describe("planQueueEdit · move", () => {
  test("同段内下移：相对顺序按新位置重排", () => {
    const plans = planQueueEdit([], ["f1", "f2", "f3"], 0, "f1", "move", 1);
    assert.deepEqual(plans, [
      { text: "f2", as: "followUp" },
      { text: "f1", as: "followUp" },
      { text: "f3", as: "followUp" },
    ]);
  });

  test("同段内上移", () => {
    const plans = planQueueEdit([], ["f1", "f2", "f3"], 2, "f3", "move", 0);
    assert.deepEqual(plans, [
      { text: "f3", as: "followUp" },
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("挪进 steering 段就变成插队——位置即投递时机，这正是拖过去的目的", () => {
    const plans = planQueueEdit(["s1"], ["f1"], 1, "f1", "move", 0);
    assert.deepEqual(plans, [
      { text: "f1", as: "steer" },
      { text: "s1", as: "followUp" },
    ]);
  });

  test("挪出 steering 段就退回等待", () => {
    const plans = planQueueEdit(["s1", "s2"], ["f1"], 0, "s1", "move", 2);
    assert.deepEqual(plans, [
      { text: "s2", as: "steer" },
      { text: "f1", as: "steer" },
      { text: "s1", as: "followUp" },
    ]);
  });

  test("目标不在队列里：原样重放（挪动落空，不切错人）", () => {
    const plans = planQueueEdit([], ["f1", "f2"], 0, "别人", "move", 1);
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("下标过期但文本还在：按文本找回来，拖拽不落空", () => {
    const plans = planQueueEdit([], ["f1", "f2", "f3"], 9, "f3", "move", 0);
    assert.deepEqual(plans, [
      { text: "f3", as: "followUp" },
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("toIndex 越界：原样重放", () => {
    const plans = planQueueEdit([], ["f1", "f2"], 0, "f1", "move", 9);
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("toIndex 缺席：等价 no-op 重放", () => {
    const plans = planQueueEdit([], ["f1", "f2"], 0, "f1", "move");
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });

  test("挪到原位：序列不变", () => {
    const plans = planQueueEdit([], ["f1", "f2"], 1, "f2", "move", 1);
    assert.deepEqual(plans, [
      { text: "f1", as: "followUp" },
      { text: "f2", as: "followUp" },
    ]);
  });
});
