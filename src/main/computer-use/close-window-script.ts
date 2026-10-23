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
 * 为什么不直接 PostMessage(WM_COMMAND, IDOK)：不稳——窗口有时是隐藏态 / 取不到对话框句柄。
 * 这里走「激活 + 校验前台 PID + 发 Enter」，并且**带护栏**：前台窗口不属于目标进程时
 * 一个键都不发（否则会误敲到用户正在用的窗口），脚本以退出码 2 结束。
 *
 * ⚠ 这个脚本必须**纯 ASCII**：PowerShell 5.1 按 ANSI 读 `-Command` 里不带 BOM 的中文，
 * 会解析炸掉（上一版就是这么失败的）。所以本文件里的脚本连注释都是英文，
 * 中文解释只活在这个文件头的 TS 注释里。`close-window-script.test.ts` 断言整段是 ASCII。
 */

/** 目标进程自己的窗口前台判定：拿前台窗口 → 反查 PID → 不等于目标就退出（不发键） */
export function buildCloseSandboxWindowScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`关窗脚本要一个正整数 PID，收到：${String(pid)}`);
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    // P/Invoke：取前台窗口句柄，再问它属于哪个进程
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
    // b. 把它带到前台，确认框才会收到键
    "$shell = New-Object -ComObject WScript.Shell",
    "$null = $shell.AppActivate($target)",
    "Start-Sleep -Milliseconds 500",
    // c. 护栏：前台不是我们这只沙箱就一个键都不发
    "$handle = [OrbitaForeground]::GetForegroundWindow()",
    "$foreground = 0",
    "$null = [OrbitaForeground]::GetWindowThreadProcessId($handle, [ref]$foreground)",
    "if ($foreground -ne $target) { exit 2 }",
    // d. Ok 是默认按钮，发 Enter 就是「确认关闭」
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "exit 0",
    "",
  ].join("\r\n");
}
