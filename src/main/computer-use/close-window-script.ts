/**
 * 「关掉沙箱窗口」要按的那一下确认键 —— PowerShell 脚本生成器。
 *
 * 为什么不是简单一句 `CloseMainWindow()`：
 * 2026-10-23 真机实测，`CloseMainWindow()` 之后沙箱会弹**它自己的确认框**
 * 「Are you sure you want to close Windows Sandbox? …（Ok 是默认按钮）」。没人按 Ok，
 * 窗口就一直等——于是 graceful 窗口必然超时、退回强杀；而**强杀会让 VM 泄漏**
 * （vmwp + vmmemWindowsSandbox 各 ~3.5GB），泄漏攒多了会报「与该服务器建立的会话太多」，
 * 新沙箱都起不来。所以「替用户按下 Ok」不是锦上添花，是收尾必须的一步。
 *
 * 为什么不用 SendKeys：2026-10-23 第二次真机验收，`AppActivate` + `SendKeys('{ENTER}')`
 * 前台 PID 校验都通过了、键也发了，**确认框还在**（打键这条路对它的对话框无效）。
 * 现在改成 UI Automation 直接 `InvokePattern.Invoke()` 那个按钮——进程内调用，天然不会
 * 误敲到别人的窗口；SendKeys 只作为「UIA 找不到按钮」时的兜底（那条兜底才需要前台校验）。
 *
 * 为什么 PostMessage(WM_COMMAND, IDOK) 也不行：不稳——窗口有时是隐藏态 / 取不到对话框句柄。
 *
 * ⚠ 这个脚本必须**纯 ASCII**：PowerShell 5.1 按 ANSI 读 `-Command` 里不带 BOM 的中文，
 * 会解析炸掉（第一版就是这么失败的）。所以脚本里连注释都是英文（中文字面量「确定」用
 * `[char]0x786E + [char]0x5B9A` 拼出来），中文解释只活在这个 TS 文件里。
 * `close-window-script.test.ts` 断言整段是 ASCII。
 */

/** 关窗脚本：关窗 → 等确认框 → UIA 直接 Invoke Ok →（找不到按钮才）兜底按 Enter */
export function buildCloseSandboxWindowScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`关窗脚本要一个正整数 PID，收到：${String(pid)}`);
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    // P/Invoke：取前台窗口句柄，再问它属于哪个进程（只给兜底那一段用）
    "$signature = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class OrbitaForeground {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $signature",
    `$target = ${pid}`,
    "$process = Get-Process -Id $target -ErrorAction SilentlyContinue",
    "if ($null -eq $process) { exit 0 }",
    // a. 等价用户点 X：沙箱随即弹自己的确认框
    "$null = $process.CloseMainWindow()",
    "Start-Sleep -Milliseconds 1200",
    // b. UI Automation：在这只沙箱的窗口树里找确认框的 Ok 按钮，直接 Invoke
    //    （Invoke 是跨进程的 UI 自动化调用，不经过键盘，所以不会打进别的窗口）
    "$invoked = $false",
    "try {",
    "  Add-Type -AssemblyName UIAutomationClient",
    "  Add-Type -AssemblyName UIAutomationTypes",
    "  $automation = [System.Windows.Automation.AutomationElement]",
    "  $byPid = New-Object System.Windows.Automation.PropertyCondition($automation::ProcessIdProperty, $target)",
    "  $elements = $automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $byPid)",
    "  $okNames = @('Ok', ([string][char]0x786E + [string][char]0x5B9A))",
    "  foreach ($element in $elements) {",
    "    try {",
    "      $current = $element.Current",
    "      if ($current.ControlType.Id -ne [System.Windows.Automation.ControlType]::Button.Id) { continue }",
    "      if ($okNames -notcontains $current.Name) { continue }",
    "      $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "      $pattern.Invoke()",
    "      $invoked = $true",
    "      break",
    "    } catch { continue }",
    "  }",
    "} catch { $invoked = $false }",
    "if ($invoked) { exit 0 }",
    // c. 兜底：UIA 找不到按钮（对话框还没画出来 / 名字不叫 Ok）才退回「激活 + 校验 + Enter」
    "$shell = New-Object -ComObject WScript.Shell",
    "$null = $shell.AppActivate($target)",
    "Start-Sleep -Milliseconds 500",
    // d. 护栏：前台不是我们这只沙箱就一个键都不发（绝不误敲用户的窗口）
    "$handle = [OrbitaForeground]::GetForegroundWindow()",
    "$foreground = 0",
    "$null = [OrbitaForeground]::GetWindowThreadProcessId($handle, [ref]$foreground)",
    "if ($foreground -ne $target) { exit 2 }",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "exit 0",
    "",
  ].join("\r\n");
}
