import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGoalTools, goalReceipt, previousGoalFrom } from "./goal-tools.ts";

/** pi 本子里一条带 update_goal 调用的 assistant 消息 */
const goalEntry = (id: string, goal: unknown) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id, name: "update_goal", arguments: { goal } }] },
});

function setup(branch: unknown[] = []) {
  const [tool] = createGoalTools({ branch: () => branch });
  assert.ok(tool !== undefined);
  const run = (id: string, params: unknown) => tool.execute(id, params as never, undefined, undefined, undefined as never);
  return { tool, run };
}

describe("previousGoalFrom", () => {
  test("倒着找最近一次 update_goal，跳过正在处理的这次自己", () => {
    const branch = [goalEntry("g1", "旧目标"), goalEntry("g2", "新目标")];
    assert.equal(previousGoalFrom(branch, "g3"), "新目标");
    assert.equal(previousGoalFrom(branch, "g2"), "旧目标");
    assert.equal(previousGoalFrom(branch, "g1"), "新目标");
  });

  test("没有 / 坏入参 / 非 assistant 条目 = 跳过；全找不到 = null", () => {
    assert.equal(previousGoalFrom([], "x"), null);
    assert.equal(previousGoalFrom([goalEntry("g1", ""), { type: "message", message: { role: "user", content: "hi" } }, { type: "compaction" }], "x"), null);
  });
});

describe("update_goal 工具", () => {
  test("第一次：回执说明目标挂在进度面板最上面，details 只有 goal", async () => {
    const { run } = setup();
    const out = (await run("c1", { goal: "把待办模块做完" })) as { content: { text: string }[]; details: unknown };
    assert.deepEqual(out.details, { goal: "把待办模块做完" });
    assert.match(out.content[0]?.text ?? "", /Goal saved/);
  });

  test("改了：details 带 previous，回执要求它在正文里说一句、不要用户确认", async () => {
    const { run } = setup([goalEntry("g1", "做排序")]);
    const out = (await run("c2", { goal: "做排序并筛选", why: "用户补充" })) as { content: { text: string }[]; details: unknown };
    assert.deepEqual(out.details, { goal: "做排序并筛选", previous: "做排序" });
    assert.match(out.content[0]?.text ?? "", /in one plain sentence/);
    assert.match(out.content[0]?.text ?? "", /do not ask them to confirm/);
  });

  test("没变：回执只说没变，不让它再说一遍", async () => {
    const { run } = setup([goalEntry("g1", "做排序")]);
    const out = (await run("c2", { goal: "做排序" })) as { content: { text: string }[]; details: unknown };
    assert.equal(out.content[0]?.text, "Goal unchanged.");
    assert.deepEqual(out.details, { goal: "做排序" });
  });

  test("坏入参照样拒（校验在 shared/goal.ts），文案让模型改了重调", async () => {
    const { run } = setup();
    await assert.rejects(() => run("c1", { goal: "  " }), /requires "goal"/);
  });

  test("说明里讲了：用户原话为主、改了要在正文里说、不要用户确认、by 的用法", () => {
    const { tool } = setup();
    assert.match(tool.description, /user's own words/);
    assert.match(tool.description, /never ask them to confirm/);
    assert.match(tool.description, /by="self"/);
    assert.ok((tool.promptGuidelines ?? []).some((line) => /tell them in one sentence/.test(line)));
    const props = (tool.parameters as { properties: Record<string, unknown>; required: string[] }).properties;
    assert.deepEqual(Object.keys(props), ["goal", "why", "by"]);
  });

  test("goalReceipt 三种情形", () => {
    assert.match(goalReceipt(null, "x"), /saved/);
    assert.equal(goalReceipt("x", "x"), "Goal unchanged.");
    assert.match(goalReceipt("x", "y"), /changed/);
  });
});
