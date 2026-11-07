import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPlanTools, parsePlan, planReceipt } from "./plan-tools.ts";
import { decidePermission } from "../shared/permission.ts";

describe("update_plan", () => {
  test("整张清单解析：去空白、保留顺序", () => {
    assert.deepEqual(parsePlan({ items: [{ text: " 读代码 ", status: "done" }, { text: "改", status: "in_progress" }] }), [
      { text: "读代码", status: "done" },
      { text: "改", status: "in_progress" },
    ]);
  });

  test("坏入参抛错，文案能让模型改了重调", () => {
    assert.throws(() => parsePlan({}), /requires "items"/);
    assert.throws(() => parsePlan({ items: [{ text: "", status: "done" }] }), /Step 1 has no text/);
    assert.throws(() => parsePlan({ items: [{ text: "a", status: "doing" }] }), /pending, in_progress or done/);
    assert.throws(
      () => parsePlan({ items: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }] }),
      /Only one step/,
    );
    assert.throws(() => parsePlan({ items: Array.from({ length: 13 }, () => ({ text: "x", status: "pending" })) }), /at most 12/);
  });

  test("回执：几步做完 + 当前在做", () => {
    assert.equal(
      planReceipt([{ text: "a", status: "done" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }]),
      "Plan updated: 1/3 done. Now: b",
    );
    assert.equal(planReceipt([{ text: "a", status: "done" }]), "Plan updated: 1/1 done. All steps done.");
  });

  test("执行：回执给模型，整张计划进 details", async () => {
    const [tool] = createPlanTools();
    assert.ok(tool !== undefined);
    const out = await tool.execute("c1", { items: [{ text: "a", status: "in_progress" }] }, undefined, undefined, undefined as never);
    assert.deepEqual((out as { details: unknown }).details, { plan: [{ text: "a", status: "in_progress" }] });
  });

  test("三档权限一律放行（plan 档也能写计划）", () => {
    for (const mode of ["plan", "manual", "skip"] as const) {
      assert.deepEqual(decidePermission(mode, "update_plan"), { behavior: "allow" });
    }
  });
});
