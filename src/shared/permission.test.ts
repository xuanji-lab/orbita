import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decidePermission,
  isReadOnlyTool,
  PERMISSION_MODES,
  READ_ONLY_TOOLS,
} from "./permission.ts";

const MUTATING = ["bash", "write", "edit", "multi_edit", "patch", "powershell"];

describe("decidePermission", () => {
  test("plan：只读放行，其余一律拒绝——bash 在 plan 下不可能被执行", () => {
    for (const tool of READ_ONLY_TOOLS) {
      assert.deepEqual(decidePermission("plan", tool), { behavior: "allow" });
    }
    for (const tool of MUTATING) {
      const decision = decidePermission("plan", tool);
      assert.equal(decision.behavior, "deny", `${tool} 应被拒绝`);
    }
  });

  test("plan 的拒绝理由要能指导模型改道，而不是让它反复重试", () => {
    const decision = decidePermission("plan", "bash");
    assert.equal(decision.behavior, "deny");
    if (decision.behavior !== "deny") return;
    assert.match(decision.message, /Plan mode/);
    assert.match(decision.message, /bash/);
    assert.match(decision.message, /Describe the change/);
  });

  test("manual：全都问，只读也问（用户明确要的语义）", () => {
    for (const tool of [...READ_ONLY_TOOLS, ...MUTATING]) {
      assert.deepEqual(decidePermission("manual", tool), { behavior: "ask" }, tool);
    }
  });

  test("skip：一律放行", () => {
    for (const tool of [...READ_ONLY_TOOLS, ...MUTATING]) {
      assert.deepEqual(decidePermission("skip", tool), { behavior: "allow" }, tool);
    }
  });

  test("未知工具按有副作用处理——默认不安全，而不是默认放行", () => {
    assert.equal(decidePermission("plan", "some_new_tool").behavior, "deny");
    assert.equal(decidePermission("manual", "some_new_tool").behavior, "ask");
  });

  test("read_task（B-1）：跨会话读按只读对待——plan 静默放行（2026-09-18 二次裁决：读取而已）", () => {
    assert.deepEqual(decidePermission("plan", "read_task"), { behavior: "allow" });
    assert.deepEqual(decidePermission("manual", "read_task"), { behavior: "ask" });
    assert.deepEqual(decidePermission("skip", "read_task"), { behavior: "allow" });
  });

  test("三档模式都有定义，没有落空的分支", () => {
    for (const mode of PERMISSION_MODES) {
      assert.ok(["allow", "ask", "deny"].includes(decidePermission(mode, "bash").behavior));
      assert.ok(["allow", "ask", "deny"].includes(decidePermission(mode, "read").behavior));
    }
  });
});

describe("isReadOnlyTool", () => {
  test("只读集合精确，不靠名字猜", () => {
    assert.equal(isReadOnlyTool("read"), true);
    assert.equal(isReadOnlyTool("grep"), true);
    assert.equal(isReadOnlyTool("write"), false);
    assert.equal(isReadOnlyTool("bash"), false);
    // 名字里带 read 但不是只读工具，不能被误判
    assert.equal(isReadOnlyTool("read_and_write"), false);
  });
});
