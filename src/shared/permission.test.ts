import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_READ_TOOLS,
  CHANNEL_TOOLS,
  decidePermission,
  isBrowserReadTool,
  isChannelTool,
  USER_ACTION_TOOL,
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

  test("通道三件套（子会话 2026-09-23）：delegate / reply_subsession / report_to_parent 三档全放行", () => {
    for (const mode of PERMISSION_MODES) {
      for (const tool of CHANNEL_TOOLS) {
        assert.deepEqual(decidePermission(mode, tool), { behavior: "allow" }, `${mode}/${tool}`);
      }
    }
  });

  test("通道工具放行不影响其它工具的既有行为", () => {
    assert.deepEqual(decidePermission("plan", "read"), { behavior: "allow" });
    assert.equal(decidePermission("plan", "bash").behavior, "deny");
    assert.deepEqual(decidePermission("manual", "read"), { behavior: "ask" });
    assert.deepEqual(decidePermission("manual", "bash"), { behavior: "ask" });
    assert.deepEqual(decidePermission("skip", "bash"), { behavior: "allow" });
  });
});

describe("isChannelTool", () => {
  test("通道三件套精确命中，其它工具（包括名字相似的）不命中", () => {
    for (const tool of CHANNEL_TOOLS) assert.equal(isChannelTool(tool), true, tool);
    assert.equal(isChannelTool("read_task"), false);
    assert.equal(isChannelTool("bash"), false);
    assert.equal(isChannelTool("delegate_extra"), false);
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

describe("浏览器只读四件（BROWSER_READ_TOOLS）", () => {
  test("三档一律放行，manual 也不问", () => {
    for (const tool of BROWSER_READ_TOOLS) {
      for (const mode of PERMISSION_MODES) {
        assert.deepEqual(decidePermission(mode, tool), { behavior: "allow" }, `${mode} ${tool}`);
      }
    }
  });
  test("不混进 READ_ONLY_TOOLS；名单外的 browser_* 不沾光", () => {
    for (const tool of BROWSER_READ_TOOLS) assert.equal(isReadOnlyTool(tool), false, tool);
    assert.equal(isBrowserReadTool("browser_click"), false);
  });
  test("点击 / 输入 / 按键照写操作过闸：plan 拒、manual 问、skip 放；滚动只是往下读，免审批", () => {
    for (const tool of ["browser_click", "browser_type", "browser_press"]) {
      assert.equal(decidePermission("plan", tool).behavior, "deny", tool);
      assert.equal(decidePermission("manual", tool).behavior, "ask", tool);
      assert.equal(decidePermission("skip", tool).behavior, "allow", tool);
    }
    assert.equal(isBrowserReadTool("browser_scroll"), true);
  });
});

describe("交接（USER_ACTION_TOOL）", () => {
  test("三档一律放行：它本身就是在问用户", () => {
    for (const mode of PERMISSION_MODES) {
      assert.deepEqual(decidePermission(mode, USER_ACTION_TOOL), { behavior: "allow" }, mode);
    }
  });
});
