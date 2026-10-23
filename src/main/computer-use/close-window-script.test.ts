/**
 * 关窗脚本的测试。三条硬要求，都是真机咬过的：
 *  ① 确认要点的是 UI Automation 的 Invoke——真机实测 AppActivate + SendKeys('{ENTER}')
 *     按不掉那个确认框（键发出去了，框还在）；
 *  ② 兜底那一段必须保留「前台 PID 校验」——否则 Enter 会打到用户正在用的窗口上；
 *  ③ 必须**纯 ASCII**——PowerShell 5.1 按 ANSI 读带中文的 -Command 会直接解析失败
 *     （第一版「优雅关窗永远超时」的根因之一），所以「确定」只能用 char 码拼。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCloseSandboxWindowScript } from "./close-window-script.ts";

describe("buildCloseSandboxWindowScript", () => {
  test("脚本带目标 pid：先 CloseMainWindow 弹确认框，再用 UIA 找 Ok 直接 Invoke", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("$target = 4300"), "目标 pid 要写进脚本");
    assert.ok(script.includes("CloseMainWindow()"), "先按用户点 X 的语义关窗");
    assert.ok(script.includes("Add-Type -AssemblyName UIAutomationClient"));
    assert.ok(script.includes("Add-Type -AssemblyName UIAutomationTypes"));
    assert.ok(script.includes("AutomationElement"), "要按 UI Automation 找元素");
    assert.ok(script.includes("ProcessIdProperty"), "只在这只沙箱的窗口树里找");
    assert.ok(script.includes("InvokePattern"), "找到按钮要拿 InvokePattern");
    assert.ok(script.includes("$pattern.Invoke()"), "点它的是 Invoke，不是键盘");

    // 顺序：关窗 → 等确认框 → UIA Invoke →（找不到才）兜底
    const close = script.indexOf("CloseMainWindow()");
    const uia = script.indexOf("UIAutomationClient");
    const invoke = script.indexOf("$pattern.Invoke()");
    const fallback = script.indexOf("SendWait('{ENTER}')");
    assert.ok(close < uia && uia < invoke && invoke < fallback, "四步顺序：关窗 → UIA → Invoke → 兜底");
    assert.ok(script.includes("Start-Sleep -Milliseconds 1200"), "关窗到确认框出现之间要等一下");
  });

  test("「确定」用 char 码拼，不写字面中文", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("[char]0x786E"), "「确」= U+786E");
    assert.ok(script.includes("[char]0x5B9A"), "「定」= U+5B9A");
    assert.ok(script.includes("$okNames"), "要有一个按钮名清单（Ok / 确定）");
  });

  test("兜底段保留护栏：UIA 没成时才走键盘，且前台 PID 不等于目标就 exit 2", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("if ($invoked) { exit 0 }"), "UIA 成功就不再碰键盘");
    assert.ok(/if \(\$foreground -ne \$target\) \{ exit 2 \}/.test(script));
    assert.ok(script.includes("GetForegroundWindow()"));
    assert.ok(script.includes("GetWindowThreadProcessId"));
    assert.ok(script.indexOf("exit 2") < script.indexOf("SendWait"), "校验必须在发键之前");
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
