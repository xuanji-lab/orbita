import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPlanTools, planReceipt } from "./plan-tools.ts";
import { decidePermission } from "../shared/permission.ts";

describe("update_plan", () => {
  test("回执：几步做完 + 当前在做", () => {
    assert.equal(
      planReceipt([{ text: "a", status: "done" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }]),
      "Plan updated: 1/3 done. Now: b",
    );
    assert.equal(planReceipt([{ text: "a", status: "done" }]), "Plan updated: 1/1 done. All steps done.");
  });

  test("执行：回执给模型，整张计划进 details；坏入参照样拒（校验在 shared/plan.ts）", async () => {
    const [tool] = createPlanTools();
    assert.ok(tool !== undefined);
    const out = await tool.execute("c1", { items: [{ text: "a", status: "in_progress" }] }, undefined, undefined, undefined as never);
    assert.deepEqual((out as { details: unknown }).details, { plan: [{ text: "a", status: "in_progress" }] });
    await assert.rejects(() => tool.execute("c2", { items: [] }, undefined, undefined, undefined as never), /requires "items"/);
  });

  test("三档权限一律放行（plan 档也能写计划）", () => {
    for (const mode of ["plan", "manual", "skip"] as const) {
      assert.deepEqual(decidePermission(mode, "update_plan"), { behavior: "allow" });
    }
  });
});
