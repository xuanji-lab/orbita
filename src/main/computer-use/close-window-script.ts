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
 * 为什么找按钮要**两步**（先 Children 再 Descendants），2026-10-27 真机验收：
 * 原来的 `RootElement.FindAll(Descendants, byPid)` 在一次运行里 15 轮全部落空（每轮 2s，共 35s），
 * 而窗口与那个 `name='Ok'` 的按钮都在——同一个 pid 先取**顶层窗口**（`TreeScope.Children`），
 * 再在窗口内找按钮（`Descendants` + Name/ControlType 条件）第一次就 Invoke 成功。
 * 全树 Descendants 这条路径在真机上会周期性返回 0 个元素，不能再当主路；两步查询还额外
 * 把搜索范围限在这只沙箱的窗口子树内（不会扫到用户桌面）。
 *
 * 为什么要**轮询**而不是睡一觉再找：
 * 2026-10-24 真机复现两次——关窗后只等 1200ms 就枚举，确认框还没画出来，UIA 落空、
 * 回退到键盘兜底；而用户当时前台是微信，前台 PID 守卫（正确地）拒绝发键 → exit 2 →
 * 超时强杀 → VM 泄漏。UIA 枚举后来是能看到那个 `name='Ok' class=Button` 的，说明根因只是
 * **等太短**。现在每轮 400ms、最多 15 轮（≈6 秒），每轮重新枚举一次，按钮一出现就 Invoke。
 *
 * 为什么不用 SendKeys：2026-10-23 第二次真机验收，`AppActivate` + `SendKeys('{ENTER}')`
 * 前台 PID 校验都通过了、键也发了，**确认框还在**（打键这条路对它的对话框无效）。
 * 现在改成 UI Automation 直接 `InvokePattern.Invoke()` 那个按钮——进程内调用，天然不会
 * 误敲到别人的窗口；SendKeys 只作为「UIA 全轮都找不到按钮」时的兜底（那条兜底才需要前台校验）。
 *
 * 为什么 PostMessage(WM_COMMAND, IDOK) 也不行：不稳——窗口有时是隐藏态 / 取不到对话框句柄。
 *
 * ⚠ **2026-11-13 补充：UIA 会无限期阻塞，所以它现在跑在子进程里。**
 * 真机两次实测：`FindAll` / `FindFirst` 打在这只沙箱的窗口上，**126 秒不返回**（另一次复核
 * 25 秒无返回）。它撞穿调用方 `spawnSync` 的 20s 预算 → PowerShell 被杀 → 优雅关窗根本没发生
 * → 落强杀 → 漏 3.4GB 孤儿 VM（要 60~150 秒才自清）。而 `$process.Responding` 拦不住它：
 * 窗口泵是响应的，卡住的是 UIA provider 自己。
 * 现在把整段 UIA 放进 `Start-Job`，主脚本 `Wait-Job -Timeout 8`；超时就 `Stop-Job` +
 * `Remove-Job -Force` 杀掉，再走键盘兜底。**卡住只损失 8 秒，不再拖垮整次关闭。**
 * 顺带：`CloseMainWindow()` 的返回值必须看（窗口忙时它返回 false 且什么都不做，框压根不弹），
 * 所以给了 3 次重试；没按到任何按钮且进程仍活着 → `exit 3`，不再假装成功。
 *
 * 退出码（调用方按它写日志，别混着看）：
 *   0 = 我们自己按下了确认（UIA Invoke，或兜底 Enter 之后确认框消失）
 *   2 = 走到了键盘兜底，但前台不是这只沙箱 → **一个键都没发**（绝不误敲用户窗口）
 *   3 = 两条路都没成（确认框没出现 / 按不到 Ok / 按了还在）→ 交给强杀链兜底
 *
 * ⚠ 这个脚本必须**纯 ASCII**：PowerShell 5.1 按 ANSI 读 `-Command` 里不带 BOM 的中文，
 * 会解析炸掉（第一版就是这么失败的）。所以脚本里连注释都是英文（中文字面量「确定」「是」「关闭」
 * 分别用 `[char]0x786E + [char]0x5B9A`、`[char]0x662F`、`[char]0x5173 + [char]0x95ED` 拼出来），
 * 中文解释只活在这个 TS 文件里。`close-window-script.test.ts` 断言整段是 ASCII。
 */

/**
 * 关窗脚本：关窗 → 每 400ms 找一次确认框的 OK 按钮（最多 15 轮）→ Invoke →
 * （全轮落空才）兜底「激活 + 前台 PID 校验 + Enter」。
 */
export function buildCloseSandboxWindowScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`关窗脚本要一个正整数 PID，收到：${String(pid)}`);
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$signature = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class OrbitaForeground {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $signature",
    "function Orbita-Alive { param([int]$Id) return ($null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)) }",
    `$target = ${pid}`,
    "if (-not (Orbita-Alive $target)) { exit 0 }",
    "$process = Get-Process -Id $target -ErrorAction SilentlyContinue",
    "if ($null -eq $process) { exit 0 }",
    // **不要在这里查 $process.Responding**：它内部是 SendMessageTimeout，窗口忙时单次最坏 5s，
    // 10 轮就是 50s——2026-11-13 复测里正是它让脚本在打印第一行之前就撞穿 20s 预算
    // （stdout 全空、调用方看到 ETIMEDOUT，于是又一次落强杀、漏 VM）。
    // CloseMainWindow 自己带 3 次重试，不需要这层「等它缓过来」。
    "$process.Refresh()",
    "if ($process.HasExited) { exit 0 }",
    "$orbitaClosed = $false",
    "for ($try = 1; $try -le 3; $try++) {",
    "  $process.Refresh()",
    "  if ($process.HasExited) { exit 0 }",
    "  if ($process.CloseMainWindow()) { $orbitaClosed = $true; break }",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "Write-Output \"orbita-close-mainwindow=$orbitaClosed\"",
    "$orbitaJob = Start-Job -ArgumentList $target -ScriptBlock {",
    "  param($target)",
    "  try {",
    "    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "    $byPid = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $target)",
    "    $btnType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)",
    "    $okNames = @('Ok', 'OK', 'ok', 'Yes', ([string][char]0x786E + [string][char]0x5B9A), ([string][char]0x662F))",
    "    for ($round = 1; $round -le 30; $round++) {",
    "      if ($round -gt 1) { Start-Sleep -Milliseconds 200 }",
    "      $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)",
    "      foreach ($w in $wins) {",
    "        foreach ($n in $okNames) {",
    "          try {",
    "            $nc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $n)",
    "            $cond = New-Object System.Windows.Automation.AndCondition($btnType, $nc)",
    "            $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)",
    "            if ($null -ne $b) {",
    "              $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()",
    "              Write-Output (\"INVOKED:\" + $round)",
    "              return",
    "            }",
    "          } catch { }",
    "        }",
    "      }",
    "      if ($null -eq (Get-Process -Id $target -ErrorAction SilentlyContinue)) { Write-Output 'GONE'; return }",
    "    }",
    "    Write-Output 'NOTFOUND'",
    "  } catch { Write-Output 'ERROR' }",
    "}",
    "$orbitaDone = Wait-Job $orbitaJob -Timeout 8",
    "$orbitaUia = ''",
    "if ($null -ne $orbitaDone) { $orbitaUia = (Receive-Job $orbitaJob -ErrorAction SilentlyContinue | Out-String).Trim() }",
    "else { Stop-Job $orbitaJob -ErrorAction SilentlyContinue; $orbitaUia = 'TIMEOUT' }",
    "Remove-Job $orbitaJob -Force -ErrorAction SilentlyContinue",
    "Write-Output \"orbita-close-uia=$orbitaUia\"",
    "if ($orbitaUia -eq 'GONE') { exit 0 }",
    "if ($orbitaUia -like 'INVOKED*') {",
    "  for ($i = 1; $i -le 50; $i++) {",
    "    Start-Sleep -Milliseconds 300",
    "    if (-not (Orbita-Alive $target)) { exit 0 }",
    "  }",
    "  exit 3",
    "}",
    "$shell = New-Object -ComObject WScript.Shell",
    "$null = $shell.AppActivate($target)",
    "Start-Sleep -Milliseconds 500",
    "$handle = [OrbitaForeground]::GetForegroundWindow()",
    "$foreground = 0",
    "$null = [OrbitaForeground]::GetWindowThreadProcessId($handle, [ref]$foreground)",
    "if ($foreground -ne $target) { exit 2 }",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "Start-Sleep -Milliseconds 900",
    "if (Orbita-Alive $target) { exit 3 }",
    "exit 0",
    "",
  ].join("\r\n");
}
