import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GOAL_MAX_CHARS, isBookkeepingTool, parseGoalCall, parseGoalCallLoose } from "./goal.ts";

describe("parseGoalCall（update_goal 的入参校验）", () => {
  test("正常：折叠空白换行、保留用户原话", () => {
    assert.deepEqual(parseGoalCall({ goal: "  把待办模块\n加上排序，  再写 README ", why: "用户改了说法", by: "user" }), {
      goal: "把待办模块 加上排序， 再写 README",
      why: "用户改了说法",
      by: "user",
    });
  });

  test("goal 缺了 / 空白 / 不是字符串：抛错，文案让模型改了重调", () => {
    assert.throws(() => parseGoalCall({}), /requires "goal"/);
    assert.throws(() => parseGoalCall({ goal: "   " }), /requires "goal"/);
    assert.throws(() => parseGoalCall({ goal: 3 }), /requires "goal"/);
    assert.throws(() => parseGoalCall(null), /requires "goal"/);
  });

  test("why / by 写坏了静默丢掉，不拒", () => {
    assert.deepEqual(parseGoalCall({ goal: "x", why: 5, by: "robot" }), { goal: "x", why: null, by: null });
    assert.deepEqual(parseGoalCall({ goal: "x", by: "self" }), { goal: "x", why: null, by: "self" });
  });

  test("超长目标截断到上限、末尾带省略号", () => {
    const call = parseGoalCall({ goal: "字".repeat(GOAL_MAX_CHARS + 50) });
    assert.equal([...call.goal].length, GOAL_MAX_CHARS);
    assert.ok(call.goal.endsWith("…"));
  });

  test("宽松读：坏入参 = null，不抛", () => {
    assert.equal(parseGoalCallLoose({ goal: "" }), null);
    assert.equal(parseGoalCallLoose({ goal: "好" })?.goal, "好");
  });
});

describe("isBookkeepingTool", () => {
  test("update_plan 与 update_goal 是记账，其余不是", () => {
    assert.equal(isBookkeepingTool("update_plan"), true);
    assert.equal(isBookkeepingTool("update_goal"), true);
    assert.equal(isBookkeepingTool("bash"), false);
  });
});
