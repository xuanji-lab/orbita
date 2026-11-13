/**
 * 关窗脚本的测试。五条硬要求，都是真机咬过的：
 *  ① 要点的是 UI Automation 的 Invoke——真机实测 AppActivate + SendKeys('{ENTER}')
 *     按不掉那个确认框（键发出去了，框还在），所以键盘只能当兜底；
 *  ② **UIA 必须跑在子进程里、带超时**（2026-11-13）：UIA 的 FindAll / FindFirst 打在
 *     沙箱窗口上会**无限期阻塞**（实测 126s 不返回、主会话复核又一次 25s 无返回），
 *     撞穿调用方 spawnSync 的 20s 预算 → 脚本被杀 → 优雅关窗没发生 → 强杀 → 漏 3.4GB 孤儿 VM。
 *     放进 Job 之后，卡住最多超时一次，Stop/Remove-Job 杀掉重试即可；
 *  ③ 关窗之后要**轮询**等确认框（2026-10-24：只等 1200ms 就枚举，框还没画出来）；
 *  ④ 兜底那一段必须保留「前台 PID 校验」——否则 Enter 会打到用户正在用的窗口上；
 *  ⑤ 必须**纯 ASCII**——PowerShell 5.1 按 ANSI 读带中文的 -Command 会直接解析失败，
 *     所以中文按钮名只能用 char 码拼。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCloseSandboxWindowScript } from "./close-window-script.ts";

describe("buildCloseSandboxWindowScript", () => {
  test("目标 pid 写进脚本，先 CloseMainWindow 弹确认框（带重试，返回值要看）", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("$target = 4300"), "目标 pid 要写进脚本");
    assert.ok(script.includes("CloseMainWindow()"), "先按用户点 X 的语义关窗");
    assert.ok(
      script.includes("if ($process.CloseMainWindow()) { $orbitaClosed = $true; break }"),
      "CloseMainWindow 的返回值必须看：窗口忙的时候它返回 false 且什么都不做，框根本不会弹",
    );
    assert.ok(script.includes("for ($try = 1; $try -le 3; $try++)"), "忙的时候要重试，不能一次就放弃");
    assert.ok(script.includes("Write-Output \"orbita-close-mainwindow=$orbitaClosed\""), "结果要留痕，真机排查靠它");
  });

  test("UIA 跑在子进程里，带 8 秒上限，超时要 Stop/Remove 掉（这条是 2026-11-13 的根因）", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.ok(script.includes("Start-Job"), "UIA 必须在独立 Job 里跑：主脚本不能跟着一起挂");
    assert.ok(script.includes("Wait-Job $orbitaJob -Timeout 8"), "给它 8 秒上限（不是无限等）");
    assert.ok(script.includes("Stop-Job $orbitaJob"), "超时要停掉");
    assert.ok(script.includes("Remove-Job $orbitaJob -Force"), "还要强制移除（卡在 COM 里的 Job 进程要杀干净）");
    assert.ok(script.includes("$orbitaUia = 'TIMEOUT'"), "超时要有独立标记，别和 NOTFOUND 混成一句");
    assert.ok(script.includes("Write-Output \"orbita-close-uia=$orbitaUia\""), "UIA 的结局要留痕");

    // 顺序：关窗 → 启动 Job → 等它 → 判结果 → 兜底
    const close = script.indexOf("CloseMainWindow()");
    const job = script.indexOf("Start-Job");
    const wait = script.indexOf("Wait-Job");
    const fallback = script.indexOf("SendWait('{ENTER}')");
    assert.ok(close < job && job < wait && wait < fallback, "顺序：关窗 → Job → 等 → （不成才）键盘兜底");
  });

  test("Job 里仍是「轮询等确认框 + 按 Ok」：第一轮立即查，之后 200ms，最多 30 轮", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.match(script, /for \(\$round = 1; \$round -le 30; \$round\+\+\)/, "最多 30 轮（≈6 秒），不能一次定生死");
    assert.ok(
      script.includes("if ($round -gt 1) { Start-Sleep -Milliseconds 200 }"),
      "第一轮不等，之后 200ms（框可见时间从 ~0.5–1s 压到 ~0.1–0.2s）",
    );
    assert.ok(script.includes("InvokePattern]::Pattern).Invoke()"), "找到按钮要 Invoke，不是发键");
    assert.ok(script.includes("Write-Output (\"INVOKED:\" + $round)"), "命中第几轮要能带出来");

    // 两步查询：先取该 pid 的顶层窗口（Children），再在窗口内找（Descendants）——
    // 全树 Descendants 在真机上周期性返回 0 个元素（2026-10-27：15 轮全落空）
    assert.ok(
      script.includes("FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)"),
      "第一步：顶层窗口按 pid 取（Children）",
    );
    assert.ok(
      script.includes("$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)"),
      "第二步：在窗口内 Descendants 找按钮",
    );
    assert.ok(
      !script.includes("RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants"),
      "不要再全树 Descendants（就是它在真机上落空）",
    );
  });

  test("按钮名候选：OK 一族 + 中文「确定」「是」（ASCII 拼），只认 ControlType.Button", () => {
    const script = buildCloseSandboxWindowScript(4300);
    for (const name of ["'Ok'", "'OK'", "'ok'", "'Yes'"]) {
      assert.ok(script.includes(name), `候选里要有 ${name}`);
    }
    assert.ok(script.includes("[char]0x786E"), "「确」= U+786E");
    assert.ok(script.includes("[char]0x5B9A"), "「定」= U+5B9A");
    assert.ok(script.includes("[char]0x662F"), "「是」= U+662F");
    assert.ok(script.includes("[System.Windows.Automation.ControlType]::Button"), "只认按钮，别去 Invoke 同名文本框");
    assert.ok(script.includes("System.Windows.Automation.AndCondition"), "名字 + 控件类一次性下推给 UIA");
  });

  test("兜底段保留护栏：UIA 没成时才走键盘，且前台 PID 不等于目标就 exit 2", () => {
    const script = buildCloseSandboxWindowScript(4300);
    // UIA 按下去了就不再碰键盘（那条路只等进程自己退）
    const invoked = script.indexOf("if ($orbitaUia -like 'INVOKED*') {");
    const fallback = script.indexOf("SendWait('{ENTER}')");
    assert.ok(invoked > 0 && invoked < fallback, "INVOKED 分支在键盘兜底之前，且中途 exit");
    assert.ok(/if \(\$foreground -ne \$target\) \{ exit 2 \}/.test(script));
    assert.ok(script.includes("GetForegroundWindow()"));
    assert.ok(script.includes("GetWindowThreadProcessId"));
    assert.ok(script.indexOf("exit 2") < script.indexOf("SendWait"), "校验必须在发键之前");
  });

  test("WinForms / P/Invoke 只在键盘兜底分支里加载（真机 9.4–18.8 秒的固定开销不放在主路径上）", () => {
    const script = buildCloseSandboxWindowScript(4300);
    // 2026-11-13 三次真机诊断：Add-Type System.Windows.Forms 一步 9.35 / 16.4 / 18.75 秒，
    // 而 CloseMainWindow + UIA 合起来只要 8 毫秒。主路径上多等它一次就可能撞穿超时。
    const uiaBranch = script.indexOf("if ($orbitaUia -like 'INVOKED*') {");
    const winforms = script.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const pInvoke = script.indexOf("Add-Type -TypeDefinition $signature");
    assert.ok(winforms > uiaBranch, "WinForms 必须在 UIA 分支之后才加载");
    assert.ok(pInvoke > uiaBranch, "P/Invoke 类型同样只在兜底里编");
    // UIA 那一步的 Add-Type（UIAutomationClient）是主路径本身需要的，留在 Job 里；
    // 不许出现在主路径的是 WinForms 与 C# 类型编译这两笔大开销。
    assert.equal(script.slice(0, uiaBranch).includes("System.Windows.Forms"), false, "主路径不许加载 WinForms");
    assert.equal(
      script.slice(0, uiaBranch).includes("Add-Type -TypeDefinition"),
      false,
      "主路径不许编译 P/Invoke 类型",
    );
  });

  test("失败语义可分辨：按下 Ok 但进程不退 = 3，前台不匹配 = 2，兜底后还在 = 3", () => {
    const script = buildCloseSandboxWindowScript(4300);
    assert.equal(script.split("exit 2").length - 1, 1, "exit 2 只留给「前台不匹配，一个键都没发」");
    // 3 有两处，语义相同（进程还在 = 没关成）：
    //   ① UIA 按下了 Ok，但等 15s 进程还没退（VM 收尾慢 / 没反应）；
    //   ② 键盘兜底也发过了，进程仍在。
    // 旧代码在这里 exit 0（把「什么都没做成」报成成功），调用方于是安心等满 25s 才强杀，
    // 而强杀会漏 VM——2026-11-13 验收抓到的假成功。
    assert.equal(script.split("exit 3").length - 1, 2, "exit 3 覆盖两种没关成");
    assert.ok(script.includes("orbita-close-mainwindow="), "关窗结果留痕");
    assert.ok(script.includes("orbita-close-uia="), "UIA 结果留痕（INVOKED:n / NOTFOUND / TIMEOUT / GONE / ERROR）");
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
