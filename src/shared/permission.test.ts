import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  atMostManual,
  BROWSER_READ_TOOLS,
  CHANNEL_TOOLS,
  COMPUTER_USE_READ_TOOLS,
  COMPUTER_USE_WRITE_TOOLS,
  decidePermission,
  DEFAULT_PERMISSION_MODE,
  isBrowserReadTool,
  isChannelTool,
  isComputerUseReadTool,
  isComputerUseTool,
  isComputerUseWriteTool,
  USER_ACTION_TOOL,
  isReadOnlyTool,
  PERMISSION_MODES,
  READ_ONLY_TOOLS,
} from "./permission.ts";

const MUTATING = ["bash", "write", "edit", "multi_edit", "patch", "powershell"];

describe("DEFAULT_PERMISSION_MODE", () => {
  test("新任务起始档是 skip：开箱即干活，写与 shell 都不拦", () => {
    assert.equal(DEFAULT_PERMISSION_MODE, "skip");
    for (const tool of MUTATING) {
      assert.deepEqual(decidePermission(DEFAULT_PERMISSION_MODE, tool), { behavior: "allow" }, tool);
    }
  });
});

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

describe("沙箱截图与网页读取（COMPUTER_USE_READ_TOOLS）", () => {
  test("三档一律放行：它们只向沙箱要图 / 要文本，不往沙箱里送任何输入", () => {
    for (const tool of COMPUTER_USE_READ_TOOLS) {
      for (const mode of PERMISSION_MODES) {
        assert.deepEqual(decidePermission(mode, tool), { behavior: "allow" }, `${mode} ${tool}`);
      }
    }
    assert.equal(isComputerUseReadTool("computer_click"), false);
    for (const tool of COMPUTER_USE_READ_TOOLS) assert.equal(isReadOnlyTool(tool), false, tool);
  });

  test("点击 / 打字 / 按键 / 滚动 / UIA 动作真的动沙箱，照写操作过闸：plan 拒、manual 问、skip 放", () => {
    // computer_uia 既能列控件（只读）也能 invoke / setValue（写）：审批按**工具**给，
    // 不按参数给，所以它整件走写操作闸门——宁可让 list 也问一次，不能把写动作漏成免审批。
    for (const tool of ["computer_click", "computer_type", "computer_key", "computer_scroll", "computer_uia"]) {
      assert.equal(decidePermission("plan", tool).behavior, "deny", tool);
      assert.equal(decidePermission("manual", tool).behavior, "ask", tool);
      assert.equal(decidePermission("skip", tool).behavior, "allow", tool);
      assert.equal(isComputerUseReadTool(tool), false, tool);
    }
  });

  test("写件单独成桶：两桶合起来才是预算口径，互不重叠", () => {
    for (const tool of COMPUTER_USE_WRITE_TOOLS) {
      assert.equal(isComputerUseWriteTool(tool), true, tool);
      assert.equal(isComputerUseReadTool(tool), false, tool);
      assert.equal(isComputerUseTool(tool), true, tool);
      // 档位判定不受新桶影响：仍是默认写闸门
      assert.equal(decidePermission("plan", tool).behavior, "deny", tool);
      assert.equal(decidePermission("manual", tool).behavior, "ask", tool);
      assert.equal(decidePermission("skip", tool).behavior, "allow", tool);
    }
    for (const tool of COMPUTER_USE_READ_TOOLS) {
      assert.equal(isComputerUseWriteTool(tool), false, tool);
      assert.equal(isComputerUseTool(tool), true, tool);
    }
    assert.equal(isComputerUseWriteTool("bash"), false);
    assert.equal(isComputerUseTool("bash"), false);
  });

  test("写桶覆盖三条车道的写动作：像素四件 + 网页五件 + UIA，一个都不漏", () => {
    // 名字是真源：各自在 computer-tools.ts / sandbox-tools.ts 的工具定义里。漏一个的后果
    // 不是「少问一次」——它同时绕过会话授权、两级预算与急停撤销，三道闸一起失效
    // （2026-10 修：链上新增的 6 件曾全在名单外）。
    const all = [
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "sandbox_navigate",
      "sandbox_click",
      "sandbox_type",
      "sandbox_upload",
      "sandbox_download",
      "computer_uia",
    ];
    for (const tool of all) {
      assert.equal(isComputerUseWriteTool(tool), true, `${tool} 应在写桶里`);
      assert.equal(isComputerUseTool(tool), true, `${tool} 应计入预算`);
      assert.equal(isComputerUseReadTool(tool), false, `${tool} 不应同时是只读`);
    }
    // 名单恰好是这十件：多一个少一个都要在这里显式改（防静默漂移）
    assert.deepEqual([...COMPUTER_USE_WRITE_TOOLS].sort(), [...all].sort());
  });
});

describe("交接（USER_ACTION_TOOL）", () => {
  test("三档一律放行：它本身就是在问用户", () => {
    for (const mode of PERMISSION_MODES) {
      assert.deepEqual(decidePermission(mode, USER_ACTION_TOOL), { behavior: "allow" }, mode);
    }
  });
});

describe("atMostManual（收尾扫描轮与遗留事项开出的新会话首轮，审核 F-4）", () => {
  test("放行压成询问；询问、计划原样（计划更严，不放宽）", () => {
    assert.equal(atMostManual("skip"), "manual");
    assert.equal(atMostManual("manual"), "manual");
    assert.equal(atMostManual("plan"), "plan");
  });

  test("压过之后写类工具一律不再直接放行：要么问、要么拒", () => {
    for (const mode of PERMISSION_MODES) {
      for (const tool of MUTATING) {
        assert.notDeepEqual(decidePermission(atMostManual(mode), tool), { behavior: "allow" }, `${mode} / ${tool}`);
      }
    }
  });
});
