import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  atMostManual,
  AUTOMATION_TOOLS,
  BROWSER_READ_TOOLS,
  CHANNEL_TOOLS,
  COMPUTER_USE_CONFINED_WRITE_TOOLS,
  COMPUTER_USE_ESCAPING_WRITE_TOOLS,
  COMPUTER_USE_READ_TOOLS,
  COMPUTER_USE_WRITE_TIERS,
  COMPUTER_USE_WRITE_TOOLS,
  computerUseWriteTier,
  decidePermission,
  DEFAULT_PERMISSION_MODE,
  isBrowserReadTool,
  isChannelTool,
  isComputerUseEscapingTool,
  isComputerUseReadTool,
  isComputerUseTool,
  isComputerUseWriteTool,
  isSelfConfirmingTool,
  PLUGIN_BOARD_TOOL,
  PLUGIN_DRAFT_TOOL,
  SELF_CONFIRMING_TOOLS,
  USER_ACTION_TOOL,
  isReadOnlyTool,
  MEMORY_TOOLS,
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

  test("记忆三件套（2026-10-29 用户：不想去确认记忆）：memory_search / revise / retire 三档全放行", () => {
    for (const mode of PERMISSION_MODES) {
      for (const tool of MEMORY_TOOLS) {
        assert.deepEqual(decidePermission(mode, tool), { behavior: "allow" }, `${mode}/${tool}`);
      }
    }
    // 名字相似的不沾光
    assert.equal(decidePermission("plan", "memory_delete").behavior, "deny");
  });

  test("自动化四件套（含只改权限档的 automation_update）：三档全放行，闸在主进程；名字相似的不沾光", () => {
    for (const mode of PERMISSION_MODES) {
      for (const tool of AUTOMATION_TOOLS) {
        assert.deepEqual(decidePermission(mode, tool), { behavior: "allow" }, `${mode}/${tool}`);
      }
    }
    assert.equal(decidePermission("plan", "automation_enable").behavior, "deny");
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
    assert.equal(isChannelTool("model_costs"), true); // 派发前查价，delegate 的前置一步
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

  test("写桶覆盖三条车道的写动作：像素四件 + 网页六件 + UIA，一个都不漏", () => {
    // 名字是真源：各自在 computer-tools.ts / sandbox-tools.ts 的工具定义里。漏一个的后果
    // 不是「少问一次」——它同时绕过会话授权、两级预算与急停撤销，三道闸一起失效
    // （2026-10 修：链上新增的 6 件曾全在名单外；同月又发现 sandbox_tabs 在名单外）。
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
      "sandbox_tabs",
      "computer_uia",
    ];
    for (const tool of all) {
      assert.equal(isComputerUseWriteTool(tool), true, `${tool} 应在写桶里`);
      assert.equal(isComputerUseTool(tool), true, `${tool} 应计入预算`);
      assert.equal(isComputerUseReadTool(tool), false, `${tool} 不应同时是只读`);
    }
    // 名单恰好是这十一件：多一个少一个都要在这里显式改（防静默漂移）
    assert.deepEqual([...COMPUTER_USE_WRITE_TOOLS].sort(), [...all].sort());
  });
});

describe("写件分档（沙箱内 / 能逸出）", () => {
  test("判据落表：沙箱内 9 件、能逸出 2 件，合起来恰好是写桶、互不重叠", () => {
    assert.deepEqual(
      [...COMPUTER_USE_CONFINED_WRITE_TOOLS].sort(),
      [
        "computer_click",
        "computer_key",
        "computer_scroll",
        "computer_type",
        "computer_uia",
        "sandbox_click",
        "sandbox_navigate",
        "sandbox_tabs",
        "sandbox_type",
      ],
    );
    // 只能逸出的就这两件：host→guest 的文件内容（upload）与 guest→host 的落盘（download）。
    // 别的写工具有一天被塞进来，这条测试会先红——那时要先想清楚它是不是真的跨了边界。
    assert.deepEqual([...COMPUTER_USE_ESCAPING_WRITE_TOOLS].sort(), ["sandbox_download", "sandbox_upload"]);
    for (const tool of COMPUTER_USE_CONFINED_WRITE_TOOLS) {
      assert.equal(isComputerUseEscapingTool(tool), false, tool);
      assert.equal(computerUseWriteTier(tool), "confined", tool);
    }
    for (const tool of COMPUTER_USE_ESCAPING_WRITE_TOOLS) {
      assert.equal(isComputerUseEscapingTool(tool), true, tool);
      assert.equal(computerUseWriteTier(tool), "escaping", tool);
      assert.equal((COMPUTER_USE_CONFINED_WRITE_TOOLS as readonly string[]).includes(tool), false, tool);
    }
    assert.deepEqual(COMPUTER_USE_WRITE_TIERS.confined, COMPUTER_USE_CONFINED_WRITE_TOOLS);
    assert.deepEqual(COMPUTER_USE_WRITE_TIERS.escaping, COMPUTER_USE_ESCAPING_WRITE_TOOLS);
    // 读件与无关工具都不是任何一档
    for (const tool of COMPUTER_USE_READ_TOOLS) assert.equal(computerUseWriteTier(tool), null, tool);
    assert.equal(computerUseWriteTier("bash"), null);
    assert.equal(computerUseWriteTier("browser_click"), null);
  });

  test("分档只改确认频率，不改三档判定：两档都还是 plan 拒 / manual 问 / skip 放", () => {
    for (const tool of COMPUTER_USE_WRITE_TOOLS) {
      assert.equal(decidePermission("plan", tool).behavior, "deny", tool);
      assert.equal(decidePermission("manual", tool).behavior, "ask", tool);
      assert.equal(decidePermission("skip", tool).behavior, "allow", tool);
    }
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

describe("update_goal（会话级目标）", () => {
  test("三档一律放行：它只是把目标记在转录里，plan 档也要能定目标", () => {
    for (const mode of PERMISSION_MODES) {
      assert.deepEqual(decidePermission(mode, "update_goal"), { behavior: "allow" }, mode);
    }
  });
});

describe("插件工具", () => {
  test("list_plugins 是只读：plan 放行、manual 问、skip 放（与 read 同待遇）", () => {
    assert.equal(isReadOnlyTool("list_plugins"), true);
    assert.deepEqual(decidePermission("plan", "list_plugins"), { behavior: "allow" });
    assert.deepEqual(decidePermission("manual", "list_plugins"), { behavior: "ask" });
    assert.deepEqual(decidePermission("skip", "list_plugins"), { behavior: "allow" });
  });

  test("install_plugin 自带确认（对话里那一行）：manual 不再弹一次审批（那一行就是询问），skip 放行，plan 照拒", () => {
    assert.deepEqual(SELF_CONFIRMING_TOOLS, ["install_plugin"]);
    assert.equal(isSelfConfirmingTool("install_plugin"), true);
    assert.deepEqual(decidePermission("manual", "install_plugin"), { behavior: "allow" });
    assert.deepEqual(decidePermission("skip", "install_plugin"), { behavior: "allow" });
    const plan = decidePermission("plan", "install_plugin");
    assert.equal(plan.behavior, "deny");
    if (plan.behavior === "deny") assert.match(plan.message, /install_plugin/);
  });

  test("preview_plugin 只扫描、让右栏显示草稿：三档一律放行（含 plan 与 manual）", () => {
    for (const mode of PERMISSION_MODES) {
      assert.deepEqual(decidePermission(mode, PLUGIN_DRAFT_TOOL), { behavior: "allow" }, mode);
    }
    assert.equal(isReadOnlyTool(PLUGIN_DRAFT_TOOL), false);
  });

  test("show_plugin_board 只显示插件已写好的卡：三档一律放行（manual 也不问），不进只读名单", () => {
    assert.equal(PLUGIN_BOARD_TOOL, "show_plugin_board");
    for (const mode of PERMISSION_MODES) {
      assert.deepEqual(decidePermission(mode, PLUGIN_BOARD_TOOL), { behavior: "allow" }, mode);
    }
    assert.equal(isReadOnlyTool(PLUGIN_BOARD_TOOL), false);
    // 名字相近的不沾光
    assert.deepEqual(decidePermission("manual", "show_plugin_boards"), { behavior: "ask" });
  });

  test("自带确认不是通用后门：名字相近的工具、create_skill 都照写操作过闸；不混进只读名单", () => {
    assert.equal(isSelfConfirmingTool("install_plugins"), false);
    assert.equal(isReadOnlyTool("install_plugin"), false);
    assert.equal(decidePermission("manual", "create_skill").behavior, "ask");
    assert.equal(decidePermission("manual", "add_mcp_server").behavior, "ask");
  });
});
