/**
 * 关窗脚本的测试。四条硬要求，都是真机咬过的：
 *  ① 确认要点的是 UI Automation 的 Invoke——真机实测 AppActivate + SendKeys('{ENTER}')
 *     按不掉那个确认框（键发出去了，框还在）；
 *  ② 关窗之后必须**轮询**等确认框（2026-10-24 真机：只等 1200ms 就枚举，框还没画出来 →
 *     UIA 落空 → 前台是微信 → 爷发守卫拒发键 → 超时强杀 → VM 泄漏）；
 *  ③ 兜底那一段必须保留「前台 PID 校验」——否则 Enter 会打到用户正在用的窗口上；
 *  ④ 必须**纯 ASCII**——PowerShell 5.1 按 ANSI 读带中文的 -Command 会直接解析失败
 *     （第一版「优雅关窗永远超时」的根因之一），所以中文按钮名只能用 char 码拼。
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
    assert.ok(script.includes("$okPattern.Invoke()"), "点它的是 Invoke，不是键盘");

    // 顺序：关窗 → 等确认框 → UIA Invoke →（找不到才）兜底
    const close = script.indexOf("CloseMainWindow()");
    const uia = script.indexOf("UIAutomationClient");
    const invoke = script.indexOf("$okPattern.Invoke()");
    const fallback = script.indexOf("SendWait('{ENTER}')");
    assert.ok(close < uia && uia < invoke && invoke < fallback, "四步顺序：关窗 → UIA → Invoke → 兜底");
  });

  test("关窗后轮询等确认框：第一轮立即查，之后每轮 200ms，最多 30 轮（≈6 秒）", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.match(script, /for \(\$round = 1; \$round -le 30; \$round\+\+\)/, "最多 30 轮（≈6 秒），不能一次定生死");
    assert.ok(
      script.includes("if ($round -gt 1) { Start-Sleep -Milliseconds 200 }"),
      "第一轮不等，之后 200ms（框可见时间从 ~0.5–1s 压到 ~0.1–0.2s）",
    );
    // 循环体内：条件睡 → 找按钮 → Invoke
    const loop = script.indexOf("for ($round = 1;");
    const sleep = script.indexOf("Start-Sleep -Milliseconds 200");
    const find = script.indexOf("Find-OrbitaButton -Names $orbitaOkNames");
    const invoke = script.indexOf("$okPattern.Invoke()");
    assert.ok(loop < sleep && sleep < find && find < invoke, "循环体内：条件睡 → 找按钮 → Invoke");
    assert.ok(script.includes("$invoked = $true"), "找到并 Invoke 成功要标记");
    assert.ok(script.includes("if ($invoked) { exit 0 }"), "按下确认就算成功退出");
  });

  test("按钮名候选：OK 一族 + 中文「确定」「是」，Close/关闭 只作兜底", () => {
    const script = buildCloseSandboxWindowScript(4300);
    for (const name of ["'Ok'", "'OK'", "'ok'", "'Yes'"]) {
      assert.ok(script.includes(name), `候选里要有 ${name}`);
    }
    assert.ok(script.includes("[char]0x786E"), "「确」= U+786E");
    assert.ok(script.includes("[char]0x5B9A"), "「定」= U+5B9A");
    assert.ok(script.includes("[char]0x662F"), "「是」= U+662F");
    assert.ok(script.includes("[char]0x5173"), "「关」= U+5173");
    assert.ok(script.includes("[char]0x95ED"), "「闭」= U+95ED");
    // 只认按钮（ControlType.Button），别把同名文本框 Invoke 了；名字用 PropertyCondition 比较，
    // 不再枚举整棵树的每个元素
    assert.ok(script.includes("[System.Windows.Automation.ControlType]::Button"), "只认按钮，别去 Invoke 同名文本框");
    assert.ok(script.includes("System.Windows.Automation.AndCondition"), "名字 + 控件类一次性下推给 UIA");

    // 两步查询：先取该 pid 的顶层窗口（Children），再在窗口内找（Descendants）——
    // 全树 Descendants 在真机上周期性返回 0 个元素（2026-10-27：15 轮全落空）
    assert.ok(
      script.includes("FindAll([System.Windows.Automation.TreeScope]::Children, $orbitaByPid)"),
      "第一步：顶层窗口按 pid 取（Children）",
    );
    assert.ok(
      script.includes("$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)"),
      "第二步：在窗口内 Descendants 找按钮",
    );
    assert.ok(
      !script.includes("RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants"),
      "不要再全树 Descendants（就是它在真机上落空）",
    );

    // 优先级：Ok 一族在轮询里直接按；Close 一族先记着，整轮落空之后才按
    const okSearch = script.indexOf("Find-OrbitaButton -Names $orbitaOkNames");
    const closeRemember = script.indexOf("$closeCandidate = Find-OrbitaButton -Names $orbitaCloseNames");
    const closeInvoke = script.indexOf("$closePattern.Invoke()");
    assert.ok(okSearch < closeRemember && closeRemember < closeInvoke, "Close 只在 OK 找不到之后才用");
  });

  test("兜底段保留护栏：UIA 没成时才走键盘，且前台 PID 不等于目标就 exit 2", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("if ($invoked) { exit 0 }"), "UIA 成功就不再碰键盘");
    assert.ok(/if \(\$foreground -ne \$target\) \{ exit 2 \}/.test(script));
    assert.ok(script.includes("GetForegroundWindow()"));
    assert.ok(script.includes("GetWindowThreadProcessId"));
    assert.ok(script.indexOf("exit 2") < script.indexOf("SendWait"), "校验必须在发键之前");
  });

  test("失败语义可分辨：确认框没按到 Ok 是 exit 3，前台不匹配是 exit 2", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("exit 3"), "兜底也不成要有自己的码，方便日志区分");
    const send = script.indexOf("SendWait('{ENTER}')");
    const retry = script.indexOf("$stillOpen");
    const code3 = script.indexOf("if ($stillOpen) { exit 3 }");
    assert.ok(send < retry && retry < code3, "Enter 之后要回查确认框还在不在，再决定 3");
    // 2 只出现在前台校验处，3 只在兜底之后——两个码不能互相污染
    assert.equal(script.split("exit 2").length - 1, 1, "exit 2 只留给「前台不匹配，不发键」");
    assert.equal(script.split("exit 3").length - 1, 1, "exit 3 只在兜底也失败时出现");
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
