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
    // P/Invoke：取前台窗口句柄，再问它属于哪个进程（只给键盘兜底那一段用）
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
    // a. 等价用户点 X：沙箱随即弹自己的确认框（框什么时候画出来不确定，所以下面要轮询）。
    //    **必须看返回值并重试**：窗口线程一时忙的时候 CloseMainWindow 返回 false 且什么都不做，
    //    确认框根本不会弹出来——那之后 30 轮轮询全是空转，最后落进「找不到按钮＝已经关了」的
    //    假成功（2026-11-13 行为验收：产品路径 2/2 次 exit 0 但 25s 时四个进程全在，只能强杀，
    //    而强杀正是会漏 VM 的那条路；同一份脚本手工跑 3/3 成功，差别就是这个返回值）。
    // 先等它从上一次的忙状态里缓过来（最多 3s）：忙着的时候 CloseMainWindow 返回 false 且什么都不做
    "for ($waitRound = 1; $waitRound -le 10; $waitRound++) {",
    "  $process.Refresh()",
    "  if ($process.HasExited) { exit 0 }",
    "  if ($process.Responding) { break }",
    "  Start-Sleep -Milliseconds 300",
    "}",
    "$orbitaClosed = $false",
    "for ($try = 1; $try -le 3; $try++) {",
    "  $process.Refresh()",
    "  if ($process.HasExited) { exit 0 }",
    "  if ($process.CloseMainWindow()) { $orbitaClosed = $true; break }",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "Write-Output \"orbita-close-mainwindow=$orbitaClosed\"",
    // b. 在这只沙箱的窗口树里找确认框的按钮，找到就 Invoke。
    //    Invoke 是跨进程的 UI 自动化调用，不经过键盘，不会打进别的窗口。
    //    名字优先级：OK 一族优先；Close / 关闭 只当「整轮都没见到 OK」时的最后手段
    //    （沙箱的框默认按钮是 Ok，Close 只是某些版本的叫法）。
    "$global:orbitaUnresponsive = $false",
    "$orbitaOkNames = @('Ok', 'OK', 'ok', 'Yes', ([string][char]0x786E + [string][char]0x5B9A), ([string][char]0x662F))",
    "$orbitaCloseNames = @('Close', ([string][char]0x5173 + [string][char]0x95ED))",
    // TWO-STEP LOOKUP: first the top-level windows owned by this pid (TreeScope.Children of the
    // desktop), then the buttons inside those windows (TreeScope.Descendants).
    // A single RootElement.FindAll(Descendants, byPid) intermittently returned zero elements on
    // real machines (2026-10-27 acceptance: 15 rounds missed the Ok button while the window was
    // right there; the two-step query hit it on the first round). Walking Children first also keeps
    // the search inside this sandbox's own window subtree instead of scanning the whole desktop.
    "function Find-OrbitaButton {",
    "  param([string[]]$Names)",
    // **先问一句「它还响应吗」**：UIA 的 FindAll / FindFirst 打到无响应的窗口上会一直阻塞
    // （2026-11-13 真机：手工跑这份脚本卡了 126s 才返回，直接撞穿调用方 spawnSync 的 20s 超时
    // → PowerShell 被杀 → 优雅关窗根本没发生 → 强杀 → 漏孤儿 VM 3.4GB）。
    // Responding 用 SendMessageTimeout 探一下，最坏 5s 返回，比无限期挂住强。
    "  $orbitaProbe = Get-Process -Id $target -ErrorAction SilentlyContinue",
    "  if ($null -eq $orbitaProbe) { return $null }",
    "  $orbitaResponding = $true",
    "  try { $orbitaResponding = $orbitaProbe.Responding } catch { $orbitaResponding = $true }",
    "  if (-not $orbitaResponding) {",
    // 一次不响应就够了：Responding 本体最坏要 5s，30 轮 × 5s = 150s，比挂住还糟。
    // 标记给外面的轮询循环，让它立刻跳出（后面只判进程还在不在）。
    "    $global:orbitaUnresponsive = $true",
    "    Write-Output \"orbita-close-unresponsive=1\"",
    "    return $null",
    "  }",
    "  try {",
    "    $windows = $orbitaAutomation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $orbitaByPid)",
    "    foreach ($window in $windows) {",
    "      foreach ($name in $Names) {",
    "        try {",
    "          $nameCondition = New-Object System.Windows.Automation.PropertyCondition($orbitaAutomation::NameProperty, $name)",
    "          $condition = New-Object System.Windows.Automation.AndCondition($orbitaButtonType, $nameCondition)",
    "          $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)",
    "          if ($null -ne $button) { return $button }",
    "        } catch { continue }",
    "      }",
    "    }",
    "  } catch { }",
    "  return $null",
    "}",
    "$orbitaUiaReady = $false",
    "try {",
    "  Add-Type -AssemblyName UIAutomationClient",
    "  Add-Type -AssemblyName UIAutomationTypes",
    "  $orbitaAutomation = [System.Windows.Automation.AutomationElement]",
    "  $orbitaByPid = New-Object System.Windows.Automation.PropertyCondition($orbitaAutomation::ProcessIdProperty, $target)",
    // ControlType.Button：只认按钮（别去 Invoke 一个同名文本框）
    "  $orbitaButtonType = New-Object System.Windows.Automation.PropertyCondition($orbitaAutomation::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)",
    "  $orbitaUiaReady = $true",
    "} catch { $orbitaUiaReady = $false }",
    "$invoked = $false",
    "if ($orbitaUiaReady) {",
    "  $closeCandidate = $null",
    // 轮询节奏（2026-10-27 真机）：原来是「先睡 400ms 再查」，框出现后最快也要等 400ms
    // 才会被看第一眼，用户能看到确认框停留约 0.5–1 秒。改成**第一轮立即查**，
    // 之后每轮 200ms：总预算 30 轮 ≈ 6 秒（与原来的 15×400ms 相当），
    // 但框的可见时间降到约 100–200ms。
    "  for ($round = 1; $round -le 30; $round++) {",
    "    if ($round -gt 1) { Start-Sleep -Milliseconds 200 }",
    "    if ($round -gt 1) {",
    // 窗口在我们轮询期间自己关掉了（用户手按 / 系统收尾）：没有要按的框，直接成功
    "      $alive = Get-Process -Id $target -ErrorAction SilentlyContinue",
    "      if ($null -eq $alive) { exit 0 }",
    "    }",
    "    if ($global:orbitaUnresponsive) { break }",
    "    $button = Find-OrbitaButton -Names $orbitaOkNames",
    "    if ($null -ne $button) {",
    "      try {",
    "        $okPattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "        $okPattern.Invoke()",
    "        $invoked = $true",
    "      } catch { $invoked = $false }",
    // 命中的是第几轮：stdout 一行诊断（生产的 spawnSync 是 stdio ignore，看不见；
    // 真机排查 / 验收脚本收它会报「第 1 轮就命中」还是「拖到第 12 轮」）
    "      if ($invoked) { Write-Output \"orbita-close-round=$round\"; break }",
    "    }",
    "    if ($null -eq $closeCandidate) { $closeCandidate = Find-OrbitaButton -Names $orbitaCloseNames }",
    "  }",
    "  if (-not $invoked -and $null -ne $closeCandidate) {",
    "    try {",
    "      $closePattern = $closeCandidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "      $closePattern.Invoke()",
    "      $invoked = $true",
    "    } catch { $invoked = $false }",
    "  }",
    "}",
    "if ($invoked) { exit 0 }",
    // c. 兜底：UIA 全轮都没找到按钮（框根本没出来 / 名字对不上）才退回「激活 + 校验 + Enter」
    "$shell = New-Object -ComObject WScript.Shell",
    "$null = $shell.AppActivate($target)",
    "Start-Sleep -Milliseconds 500",
    // d. 护栏：前台不是我们这只沙箱就一个键都不发（绝不误敲用户的窗口）；2 = 没发键
    "$handle = [OrbitaForeground]::GetForegroundWindow()",
    "$foreground = 0",
    "$null = [OrbitaForeground]::GetWindowThreadProcessId($handle, [ref]$foreground)",
    "if ($foreground -ne $target) { exit 2 }",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    // e. Enter 是盲发，按没按到要回头看：确认框还在（或 UIA 都不可用无从确认）就算没成
    "Start-Sleep -Milliseconds 800",
    "$stillOpen = $true",
    // 「找不到按钮」不等于「已经关了」：框可能压根没弹（CloseMainWindow 没生效），
    // 也可能弹了但 UIA 读不到。判据只认一件事——**目标进程还在不在**。
    "$aliveAfter = Get-Process -Id $target -ErrorAction SilentlyContinue",
    "if ($null -eq $aliveAfter) { exit 0 }",
    "if ($orbitaUiaReady) {",
    "  $stillOpen = $false",
    "  $left = Find-OrbitaButton -Names $orbitaOkNames",
    "  if ($null -eq $left) { $left = Find-OrbitaButton -Names $orbitaCloseNames }",
    "  if ($null -ne $left) { $stillOpen = $true }",
    "}",
    "if ($stillOpen) { exit 3 }",
    // 没按到按钮、进程也还在：exit 3。调用方据此留一行痕（旧代码在这里 exit 0，把
    // 「什么都没做成」报成成功，于是它安心等满 25s 才强杀）。
    "exit 3",
    "",
  ].join("\r\n");
}
