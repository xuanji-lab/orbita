<#
try-pr.ps1 —— 一键起隔离验收实例（Windows 专用，netsh / taskkill 是平台件）

为什么是它：每次验收都要手工做同一串事——查保留段、挑端口、起隔离实例、
探活、跑冒烟、记 PID、按 PID 杀。串里任何一步漏了都会变成整轮重试
（保留段吞 bind 的那一个下午，见 AGENTS.md 陷阱史与本仓 ui-smoke.mjs 头注释）。
本脚本把这串固化成一条命令；耗时对账（2026-10-12 四轮验收实测）见 commit 描述。

用法（在仓库根或任意目录）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/try-pr.ps1 -Instance pr201
  # 自定端口（dev ≥5300；CDP 落 39xxx 段）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/try-pr.ps1 -Instance pr201 -DevPort 5304 -CdpPort 39304
  # 冒烟不过：
  ... -SkipSmoke
  # 收尾，按记录的 PID 树杀（绝不用 pkill -f，陷阱史 #2）：
  ... -Stop -Instance pr201

固化约束（改这条脚本前先读 AGENTS.md「命令」节）：
  - 5273 永远留给用户，脚本直接拒绝；
  - 端口先过 netsh excludedportrange（Windows 保留段会静默吞 bind，且表会漂移）
    与 Listen 占用检查，撞了自动在段内 +2 找下一个并明示最终值；
  - package.json + bun.lock 哈希没变就跳过 bun install；
  - node_modules/electron/path.txt 在就跳过 electron 安装；
  - 实例输出重定向到日志文件，PID 落文件，-Stop 时 taskkill /T 树杀；
  - 探活 http://127.0.0.1:<dev> 200 与 <cdp>/json/version 之后才接 ui-smoke，
    冒烟假红（起得太早）自动等 5s 重试一次；结束打总耗时。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$Instance,
  [int]$DevPort = 5304,
  [int]$CdpPort = 39304,
  [switch]$Stop,
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $env:TEMP "orbita-try-pr-$Instance.pid"
$logFile = Join-Path $env:TEMP "orbita-try-pr-$Instance.log"
$stateFile = Join-Path $env:TEMP "orbita-try-pr-$Instance.state"

function Test-PortExcluded([int]$Port) {
  # netsh 输出的保留段行形如「  39301  -  39400 」；解析成区间再判
  $lines = netsh interface ipv4 show excludedportrange protocol=tcp |
    Where-Object { $_ -match '^\s*(\d+)\s*-\s*(\d+)\s*$' }
  foreach ($line in $lines) {
    if ($line -match '^\s*(\d+)\s*-\s*(\d+)\s*$') {
      if ($Port -ge [int]$Matches[1] -and $Port -le [int]$Matches[2]) { return $true }
    }
  }
  return $false
}

function Test-PortListening([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Pick-Port([int]$Port, [int]$Min, [int]$Max, [string]$What) {
  # 撞保留段或被占用就在区间内 +2 续找；找不到才报错退出
  while ($true) {
    if ($Port -gt $Max) { throw "$What 在 $Min-$Max 内找不到可用端口（保留段 + 占用吃光了）" }
    if (-not (Test-PortExcluded $Port) -and -not (Test-PortListening $Port)) { return $Port }
    Write-Host "  $What 端口 $Port 不可用（保留段或占用），试 $($Port + 2)..."
    $Port += 2
  }
}

if ($Stop) {
  if (-not (Test-Path $pidFile)) { Write-Host "没有 $Instance 的 PID 记录（$pidFile），无事可做"; exit 0 }
  $saved = Get-Content $pidFile
  foreach ($p in $saved) {
    Write-Host "taskkill /PID $p /T /F ..."
    taskkill /PID $p /T /F | Out-Null
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Host "已停（日志保留在 $logFile）"
  exit 0
}

if ($DevPort -eq 5273) { throw "5273 留给用户自己的 bun run dev（AGENTS.md），验收实例请用 5300+" }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$DevPort = Pick-Port $DevPort 5300 5399 'dev'
$CdpPort = Pick-Port $CdpPort 39300 39399 'CDP'
Write-Host "实例 $Instance ：dev $DevPort / CDP $CdpPort"

Set-Location $repo

# —— 依赖：哈希没变跳过 install（省 31k 文件过 Defender 的一遍扫描）——
$hash = (Get-FileHash package.json, bun.lock -Algorithm SHA256 | ForEach-Object { $_.Hash }) -join ''
$skipInstall = $false
if (Test-Path $stateFile) {
  # 哈希一致且 node_modules 还在才跳过（目录被删过就老实重装）
  $skipInstall = ((Get-Content $stateFile -Raw) -eq $hash) -and (Test-Path (Join-Path $repo 'node_modules'))
}
if ($skipInstall) {
  Write-Host '依赖未变，跳过 bun install'
} else {
  Write-Host 'bun install ...'
  bun install | Out-Null
  Set-Content -Path $stateFile -Value $hash -NoNewline
}
if (-not (Test-Path (Join-Path $repo 'node_modules\electron\path.txt'))) {
  Write-Host '补装 electron 本体 ...'
  Push-Location (Join-Path $repo 'node_modules\electron')
  node install.js | Out-Null
  Pop-Location
}

# —— 起实例：后台进程 + 日志文件 + PID 落盘 ——
$env:ORBITA_DEV_INSTANCE = $Instance
$env:ORBITA_DEV_PORT = "$DevPort"
Write-Host "bun run dev -- --remote-debugging-port=$CdpPort （日志：$logFile）"
$proc = Start-Process -FilePath 'bun' -ArgumentList @('run', 'dev', '--', "--remote-debugging-port=$CdpPort") `
  -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
Set-Content -Path $pidFile -Value $proc.Id

# —— 探活：dev HTTP 200 + CDP /json/version，上限 120s ——
$ready = $false
while ($sw.Elapsed.TotalSeconds -lt 120) {
  Start-Sleep -Seconds 2
  if ($proc.HasExited) { throw "bun run dev 提前退出（exit $($proc.ExitCode)），看日志：$logFile" }
  $devOk = $false
  try { $r = Invoke-WebRequest "http://127.0.0.1:$DevPort/" -UseBasicParsing -TimeoutSec 2; $devOk = ($r.StatusCode -eq 200) } catch {}
  $cdpOk = $false
  try { $c = Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 2; $cdpOk = ($c.StatusCode -eq 200) } catch {}
  if ($devOk -and $cdpOk) { $ready = $true; break }
}
if (-not $ready) { throw "120s 内没探活（dev $DevPort / CDP $CdpPort），看日志：$logFile" }
Write-Host ("探活通过（{0:n0}s）" -f $sw.Elapsed.TotalSeconds)

# —— 冒烟：独立进程跑（不与宿主控制台耦合，避免句柄继承把脚本挂住），限时 90s，
# 假红自动重试一次（renderer 刚挂载完的头几秒会假红，实测 8s 内必红）
if (-not $SkipSmoke) {
  Start-Sleep -Seconds 8
  $smokeLog = Join-Path $env:TEMP "orbita-try-pr-$Instance-smoke.log"
  $smokeOk = $false
  foreach ($attempt in 1..2) {
    # 直接 Start-Process bun + 重定向会让 bun 的首个 fetch 挂死（实测：探活自己的
    # Invoke-WebRequest 是通的，bash 里跑冒烟也是通的，唯 powershell 派生的 bun 挂）；
    # 经 cmd /c 落重定向则一切正常——用 cmd 包一层，日志与退出码都归位
    $smokeCmd = "bun scripts/ui-smoke.mjs $CdpPort $DevPort > `"$smokeLog`" 2>&1"
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $smokeCmd -WorkingDirectory $repo -WindowStyle Hidden -PassThru
    if (-not ($p.WaitForExit(90000))) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    if ($p.ExitCode -eq 0) { $smokeOk = $true; break }
    Write-Host "冒烟第 $attempt 次未过，等 5s 重试（日志：$smokeLog）"
    Start-Sleep -Seconds 5
  }
  if (-not $smokeOk) {
    Write-Host "冒烟两次未过——看日志：$smokeLog 与 $logFile（实例保留运行，可手动排查）"
    exit 1
  }
  Get-Content $smokeLog | Where-Object { $_ -match '✓|全部' } | ForEach-Object { Write-Host "  $_" }
}

Write-Host ("ready in {0:n0}s —— 实例 {1}（dev {2} / CDP {3}），PID {4}（{5}）" -f $sw.Elapsed.TotalSeconds, $Instance, $DevPort, $CdpPort, $proc.Id, $pidFile)
Write-Host "收尾：powershell -File scripts/try-pr.ps1 -Stop -Instance $Instance"
