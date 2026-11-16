import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { createToolCallGate, type ToolCallLike } from "./permission.ts";
import { COMMAND_TIMEOUT_DEFAULT_SECONDS } from "../shared/permission.ts";

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallLike {
  return { toolCallId: "c1", toolName, input };
}

describe("createToolCallGate", () => {
  test("不碰受保护路径的调用一律放行（没有档位、不问人）", () => {
    const gate = createToolCallGate(["/userData/sessions"], "/repo", ["/userData/automations.json"]);
    for (const toolName of ["bash", "write", "edit", "read", "mcp__x__y", "browser_click"]) {
      assert.deepEqual(gate(event(toolName, { path: "a.ts", command: "ls" })), {}, toolName);
    }
  });

  test("子会话写父会话的工作台不被路径保护拦（protectedPaths 只锁 sessions/ 与 pi-sessions/）", async () => {
    // 子会话的重要产出要写到父工作台的 subsessions/ 下（本 PR 的产出位置规矩），
    // 这条钉住它不会被会话文件只读锁误拦——不需要任何放行例外
    const gate = createToolCallGate(["/userData/sessions", "/userData/pi-sessions"], "/repo");
    const write = await gate(
      event("write", { path: "/userData/workbenches/parent-1/subsessions/abcd1234-report/report.md", content: "x" }),
    );
    assert.deepEqual(write, {}, "父工作台可写，不该被拦");
    // 对照：sessions/ 里的文件仍全档只读
    const blocked = await gate(event("write", { path: "/userData/sessions/parent-1.jsonl", content: "x" }));
    assert.equal(blocked.block, true);
  });
});

/**
 * 命令超时兜底。背景：pi 的 bash 工具没有系统超时（上限 2147483.647 秒），唯一的时间是
 * 模型自己填的 `timeout`。它经常填保守的小值（60s / 30s / 10s，2026-10-01 统计），
 * 慢命令就被自己的秒表砍掉——白等一分钟再重试。
 *
 * 抬升函数不导出（消费者纪律：测试不算真实调用点），全部经闸门测——顺带连「跑在
 * 早退之前」的顺序也一起被钉住。
 */
/**
 * 自动化记录不可变（2026-11-13 用户裁决）：automations.json 记录「智能体定时做过什么」
 * （任务定义 + 运行记录都在这一个文件里），智能体删改它 = 丢痕迹。与 sessions/ 同一
 * 保护等级：protectedFiles（单文件）在权限档判定**之前**拦，Skip 也抬不掉；防误伤与
 * 顺手，不防蓄意对抗。读不受限（read 工具 / automation_list 能读，可追溯要的正是能读）。
 */
describe("自动化记录文件不可变（protectedFiles）", () => {
  const AUTOMATION_FILE = "/userData/automations.json";

  function gateForFiles() {
    return createToolCallGate(["/userData/sessions", "/userData/pi-sessions"], "/repo", [AUTOMATION_FILE]);
  }

  test("write / edit 命中文件本身：skip 档也拦，理由里带自动化工具的改道指引", async () => {
    const gate = gateForFiles();
    const write = await gate(event("write", { path: AUTOMATION_FILE, content: "{}" }));
    assert.equal(write.block, true);
    assert.match(write.reason ?? "", /automation_create/);
    const edit = await gate(event("edit", { path: AUTOMATION_FILE }));
    assert.equal(edit.block, true);
    assert.match(edit.reason ?? "", /Automations panel/);
  });

  test("原子写临时文件与坏文件隔离的兄弟同护（store 的落盘足迹：`<file>.<hex>.tmp` / `<file>.bad-<ts>`）", async () => {
    const gate = gateForFiles();
    for (const sibling of ["/userData/automations.json.a1b2c3d4.tmp", "/userData/automations.json.bad-1763000000000"]) {
      const result = await gate(event("write", { path: sibling, content: "x" }));
      assert.equal(result.block, true, sibling);
    }
    // 命令里出现临时文件名也要拦：`mv automations.json.<hex>.tmp automations.json` 这条绕过路
    const mv = await gate(event("bash", { command: `mv /userData/automations.json.a1b2c3d4.tmp ${AUTOMATION_FILE}` }));
    assert.equal(mv.block, true);
  });

  test("不误伤：同目录别的文件、工作台与技能目录照常可写", async () => {
    const gate = gateForFiles();
    // 相邻名字（不是本文件也不是它的 `.tmp`/`.bad-` 兄弟）不拦
    for (const path of [
      "/userData/automations-log.json",
      "/userData/settings.json",
      "/userData/workbenches/parent-1/subsessions/abcd1234-report/report.md",
      "/userData/skills/global/my-skill/SKILL.md",
      "/userData/mcp.json",
    ]) {
      const result = await gate(event("write", { path, content: "x" }));
      assert.deepEqual(result, {}, path);
    }
  });

  test("bash 命令串里出现该路径就拦：rm / 重定向 / mv / sed -i / 引号写法", async () => {
    const gate = gateForFiles();
    const commands = [
      `rm -f ${AUTOMATION_FILE}`,
      `echo '{}' > ${AUTOMATION_FILE}`,
      `mv /tmp/fake ${AUTOMATION_FILE}`,
      `sed -i 's/"enabled": true/"enabled": false/' ${AUTOMATION_FILE}`,
      `rm "${AUTOMATION_FILE}"`,
      `cat ${AUTOMATION_FILE} | jq '.automations = []' > ${AUTOMATION_FILE}`,
    ];
    for (const command of commands) {
      const result = await gate(event("bash", { command }));
      assert.equal(result.block, true, command);
    }
  });

  test("powershell 同拦（Set-Content / Remove-Item）", async () => {
    const gate = gateForFiles();
    const set = await gate(event("powershell", { command: `Set-Content -Path ${AUTOMATION_FILE} -Value '{}'` }));
    assert.equal(set.block, true);
    const remove = await gate(event("powershell", { command: `Remove-Item ${AUTOMATION_FILE}` }));
    assert.equal(remove.block, true);
  });

  test("路径边界：相邻前缀是另一个文件，不拦", async () => {
    const gate = gateForFiles();
    const write = await gate(event("write", { path: "/userData/automations.jsonx", content: "x" }));
    assert.deepEqual(write, {});
    const cmd = await gate(event("bash", { command: "cat /userData/automations-json" }));
    assert.deepEqual(cmd, {});
  });

  test("读不受限：read 工具照常能读（可追溯要的是能读）；shell 里 cat 也拦但理由里给读的改道", async () => {
    const gate = gateForFiles();
    assert.deepEqual(await gate(event("read", { path: AUTOMATION_FILE })), {});
    const cat = await gate(event("bash", { command: `cat ${AUTOMATION_FILE}` }));
    assert.equal(cat.block, true, "字面量分不出读写，与 sessions 同口径");
    assert.match(cat.reason ?? "", /automation_list|read tool/);
  });

  test("~ 引用家目录下的同一文件也拦（此前 ~ 形式字面对不上；会话目录同缺口一并修）", async () => {
    const file = join(homedir(), "orbita-test-protected", "automations.json");
    const gate = createToolCallGate([], "/repo", [file]);
    const rm = await gate(event("bash", { command: `rm -f ~/orbita-test-protected/automations.json` }));
    assert.equal(rm.block, true);
    const redirect = await gate(event("bash", { command: `echo '{}' > ~/orbita-test-protected/automations.json` }));
    assert.equal(redirect.block, true);
    const quoted = await gate(event("bash", { command: `rm ~/'orbita-test-protected'/automations.json` }));
    assert.equal(quoted.block, true);
  });

  test("会话目录的 ~ 引用同享这条展开（共享一条代码路，钉一条）", async () => {
    const dir = join(homedir(), "orbita-test-protected", "sessions");
    const gate = createToolCallGate([dir], "/repo");
    const blocked = await gate(event("bash", { command: "cat ~/orbita-test-protected/sessions/a.jsonl" }));
    assert.equal(blocked.block, true);
  });

  test("反斜杠转义空格的路径也拦（真 userData 路径带 `Application Support` 空格的常见写法）", async () => {
    const file = join(homedir(), "orbita test protected", "automations.json");
    const gate = createToolCallGate([], "/repo", [file]);
    const escaped = await gate(event("bash", { command: `echo '{}' > ~/orbita\\ test\\ protected/automations.json` }));
    assert.equal(escaped.block, true);
  });

  test("Windows 折叠：大小写与反斜杠也命中（foldPath 口径；platform 临时折成 win32 测）", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      // write 走 resolve，而 macOS 的 posix resolve 不认盘符路径，用正斜杠绝对路径
      // 折叠语义（大小写 + 反斜杠 + 收拢斜杠）照样被真实踩到
      const writeGate = createToolCallGate(
        [],
        "/repo",
        ["/UserData/automations.json"],
      );
      const write = await writeGate(event("write", { path: "/USERDATA\\\\Automations.JSON", content: "x" }));
      assert.equal(write.block, true);
      const sibling = await writeGate(event("write", { path: "/UserData/automations.jsonx", content: "x" }));
      assert.deepEqual(sibling, {});
      // 命令串比对不 resolve，盘符写法可以真测
      const cmdGate = createToolCallGate(
        [],
        "C:\\repo",
        ["C:/UserData/automations.json"],
      );
      const cmd = await cmdGate(event("bash", { command: 'del "C:\\UserData\\AUTOMATIONS.JSON"' }));
      assert.equal(cmd.block, true);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

});

describe("命令超时兜底（经 createToolCallGate）", () => {
  /** 只看 `timeout` 一个键，其余原样返回，断言好写。放行时 input 被原地抬 */
  async function clampedTimeout(toolName: string, timeout: unknown): Promise<unknown> {
    const gate = createToolCallGate();
    const input: Record<string, unknown> = { command: "bun run test" };
    if (timeout !== undefined) input["timeout"] = timeout;
    await gate({ toolCallId: "c1", toolName, input });
    return input["timeout"];
  }

  test("填了但太小 → 抬到下限 600 秒", async () => {
    assert.equal(await clampedTimeout("bash", 60), 600);
    assert.equal(await clampedTimeout("bash", 30), 600);
    assert.equal(await clampedTimeout("bash", 1), 600);
    assert.equal(await clampedTimeout("bash", 599), 600);
  });

  test("powershell 同一条兜底（Windows 上一样会自伤）", async () => {
    assert.equal(await clampedTimeout("powershell", 10), 600);
  });

  test("不填 → 补默认上限 1 小时：以前不填就永远不停，命令自己卡死时整轮挂住（461c6fce）", async () => {
    assert.equal(await clampedTimeout("bash", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
    assert.equal(COMMAND_TIMEOUT_DEFAULT_SECONDS, 3600);
    assert.equal(await clampedTimeout("powershell", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
  });

  test("显式 null 不当「不填」：那是非法值，留给 pi 报错，不偷偷补成 1 小时", async () => {
    assert.equal(await clampedTimeout("bash", null), null);
  });

  test("非命令工具不填 timeout 也不补", async () => {
    assert.equal(await clampedTimeout("read", undefined), undefined);
  });

  test("填得比下限大就尊重模型自己的判断", async () => {
    assert.equal(await clampedTimeout("bash", 600), 600);
    assert.equal(await clampedTimeout("bash", 900), 900);
    assert.equal(await clampedTimeout("bash", 120000), 120000);
  });

  test("非法值不在这里修：pi 自己会报 Invalid timeout，不替它做第二套校验", async () => {
    assert.equal(await clampedTimeout("bash", 0), 0);
    assert.equal(await clampedTimeout("bash", -5), -5);
    assert.equal(await clampedTimeout("bash", Number.NaN), Number.NaN);
    assert.equal(await clampedTimeout("bash", "60"), "60");
    assert.equal(await clampedTimeout("bash", null), null);
  });

  test("只动命令类工具：read 带上同名字段不碰", async () => {
    assert.equal(await clampedTimeout("read", 5), 5);
    assert.equal(await clampedTimeout("mcp__fs__read", 5), 5);
  });

  test("放行时也抬", () => {
    const gate = createToolCallGate();
    const e = event("bash", { command: "bun run test", timeout: 60 });
    gate(e);
    assert.equal(e.input["timeout"], 600);
  });

  test("protectedPaths 拦住的那条早退也先抬（否则拒绝理由里带的是旧值）", async () => {
    const gate = createToolCallGate(
      // 用正斜杠的绝对路径：两平台字面一致。写成 C:\\secrets 只在 Windows 上成立
      // （反斜杠与大小写的折叠只在 win32 做），macOS 上这条会误红
      ["/secrets"],
      "/work",
    );
    const e = event("bash", { command: "cat /secrets/a.json", timeout: 30 });
    const result = await gate(e);
    assert.equal(result.block, true, "受保护路径本就该拒");
    assert.equal(e.input["timeout"], 600, "拒绝这条路上也要先抬");
  });
});
