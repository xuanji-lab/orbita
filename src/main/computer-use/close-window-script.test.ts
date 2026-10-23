/**
 * 关窗脚本的测试。两条硬要求，都是真机咬过的：
 *  ① 必须带「前台 PID 校验」的护栏——否则 Enter 会打到用户正在用的窗口上；
 *  ② 必须**纯 ASCII**——PowerShell 5.1 按 ANSI 读带中文的 -Command，会直接解析失败
 *     （上一版「优雅关窗永远超时」的根因之一）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCloseSandboxWindowScript } from "./close-window-script.ts";

describe("buildCloseSandboxWindowScript", () => {
  test("脚本带目标 pid、先 CloseMainWindow 再激活，最后按 Enter 确认", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("$target = 4300"), "目标 pid 要写进脚本");
    assert.ok(script.includes("CloseMainWindow()"), "先按用户点 X 的语义关窗");
    assert.ok(script.includes("AppActivate($target)"), "要把确认框带到前台，键才收得到");
    assert.ok(script.includes("SendWait('{ENTER}')"), "Ok 是默认按钮，发 Enter");
    // 顺序：关窗 → 等确认框 → 激活 → 校验 → 发键
    const close = script.indexOf("CloseMainWindow()");
    const activate = script.indexOf("AppActivate($target)");
    const guard = script.indexOf("if ($foreground -ne $target) { exit 2 }");
    const enter = script.indexOf("SendWait('{ENTER}')");
    assert.ok(close < activate && activate < guard && guard < enter, "四步的顺序不能乱");
  });

  test("护栏：前台 PID 不等于目标就退出（exit 2），且这一步在发键之前", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(/if \(\$foreground -ne \$target\) \{ exit 2 \}/.test(script));
    assert.ok(script.indexOf("exit 2") < script.indexOf("SendWait"));
    // 取前台 PID 用的是 P/Invoke，不是靠进程名猜
    assert.ok(script.includes("GetForegroundWindow()"));
    assert.ok(script.includes("GetWindowThreadProcessId"));
  });

  test("纯 ASCII：整段脚本不许出现非 ASCII 字符（PS 5.1 按 ANSI 读会炸）", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.match(script, /^[\x00-\x7F]*$/, `脚本里有非 ASCII 字符：${script.replace(/[\x00-\x7F]+/g, " <<HERE>> ")}`);
  });

  test("非法 pid 直接拒绝（拼进脚本会变成命令注入 / 无意义的目标）", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => buildCloseSandboxWindowScript(bad), /正整数 PID/);
    }
  });
});
