# Orbita 性能测量（bench/perf 分支）

这套脚本用一个本地假模型代替真实模型，把一条真实的长会话截成 10 / 30 / 60 / 100 轮四个快照，用**生产构建**起一个隔离实例，从外面接上 renderer、主进程、agent 进程三处调试口，量四件事：切到这条会话、跑一轮、流式输出时打字、空闲。每个数都按进程分开记，Mac 和 Windows 跑的是同一份脚本、同一份素材。它不改应用代码，只放在 `bench/perf` 分支上，不进 main。

## 一条命令跑完

先把素材包 `fixture-6df79261.zip` 放到本机任意位置（它不在仓库里，单独传）。然后在本分支的仓库根目录执行：

```bash
bun install
node scripts/bench/bench.mjs --fixture <素材包路径> --label <这台机器的名字>
```

脚本会先做一次生产构建（`electron-vite build`），然后对四个刻度各起一次实例、各跑 1 次冷打开、5 次切会话、1 次空闲、1+5 次「跑一轮」、1+5 次「流式时打字」（「1+」的那次是预热，不计入），最后停掉实例。M3 Max 上一整套实测约 11 分钟（含构建），慢一些的机器可能要翻倍。结果写到仓库根的 `bench-results/<label>-<时间>/`：`result.md` 是表，`result.json` 是原始数据，`instance-<轮数>.log` 是实例日志，某一格整格失败时还会有一张 `fail-<轮数>.png` 截图。

常用参数：`--turns 10,60` 只跑部分刻度；`--runs 5` 每格次数；`--no-build` 跳过构建（`out/` 已是当前代码时）；`--out <目录>` 改结果位置；`--work <目录>` 改临时数据位置（默认系统临时目录下的 `orbita-bench`）。

### Mac

```bash
git fetch origin && git worktree add ../orbita-bench origin/bench/perf && cd ../orbita-bench
bun install
node scripts/bench/bench.mjs --fixture ~/Downloads/fixture-6df79261.zip --label mac
```

需要 Node 22 以上（脚本用到 Node 自带的 `WebSocket` 与 `fetch`）。

### Windows（PowerShell）

```powershell
git fetch origin; git worktree add ..\orbita-bench origin/bench/perf; cd ..\orbita-bench
bun install
# electron 二进制没装上时（node_modules\electron\path.txt 不在）补一次：
node node_modules\electron\install.js
node scripts\bench\bench.mjs --fixture C:\orbita-bench\fixture-6df79261.zip --label win-g14
```

素材包建议放在 `C:\orbita-bench\`（路径里不要有中文，`tar` 解包最省事）。脚本第一次运行时会把它解到 `%TEMP%\orbita-bench\fixture-fixture-6df79261\`，之后复用。

## 跑的时候要注意

**窗口要一直看得见。** 窗口被盖住或最小化时 Chromium 会停掉 `requestAnimationFrame`，帧相关的数会变成 0；脚本会在 `result.md` 的「警告」里标出这种情况，但不会去动窗口层级。跑的这 10–30 分钟里不要用这台机器，也不要让它睡眠（脚本不会替你改电源设置）。

**插电，并记下电源模式。** Windows 笔记本拔电会降频。脚本会只读地记录是否插电、`powercfg /getactivescheme` 的当前方案和 Defender 实时防护是否开着，写进结果头部；它不关 Defender、不加排除项。想知道 Defender 占了多少，可以自己把 `%TEMP%\orbita-bench` 加进排除再跑一组，用 `compare` 对比。

**端口。** 假模型在 5381–5399、renderer 调试口在 39381–39399 里挑第一个可用的；Windows 上先查 `netsh int ipv4 show excludedportrange`，跳过系统保留段（同 `scripts/try-pr.ps1`）。主进程与 agent 进程的 inspector 用 `--inspect=0`，由系统分配临时端口。不会碰 5273。

**它会在家目录下建一个 `Orbita-bench` 文件夹。** 应用按 `--user-data-dir` 的目录名派生工作区根（`src/main/data-dirs.ts`），隔离实例的数据都在 `orbita-bench` 临时目录里，但应用启动时会建这个空的工作区根。跑完可以删。

**停实例只按自己记下的 PID。** Mac 发 SIGTERM，Windows 用 `taskkill /PID <pid> /T /F`，不按进程名杀，不影响你正在用的 Orbita。

## 两份结果并排

```bash
node scripts/bench/compare.mjs <A/result.json> <B/result.json> --out compare.md
```

每格是「A 中位数 → B 中位数（变化%）」。可以拿来比 Mac 对 Windows，也可以比改前改后：同一台机器、同一份素材，在优化 PR 的 base 上跑一次，在 head 上再跑一次，把表贴进 commit 正文。

## 量了什么、怎么量的

| 进程 | 指标 | 怎么采 |
|---|---|---|
| renderer | 长任务个数 / 合计 / 最长；帧间隔 p95 与 >50 ms 的帧数 | 页面里挂 `PerformanceObserver('longtask')` 和 `requestAnimationFrame` |
| renderer | 按键到下一帧的延迟 p95 / 最大 | Event Timing（`PerformanceObserver('event')`，阈值 16 ms，没上报的按键按 16 ms 计），CDP 真键盘逐字敲 40 个字符 |
| renderer | 切会话：点击到界面静止 | 真鼠标点侧栏；静止 = 点击后有过 DOM 变化且 500 ms 内不再变 |
| 各进程 | CPU 秒、工作集 | 主进程里每 250 ms 采 `app.getAppMetrics()`，CPU 秒用 `cumulativeCPUUsage` 求差（`percentCPUUsage` 在 Mac 上严重偏低）；renderer 按主窗口的 `getOSProcessId()` 认，agent 按它 inspector 里的 `process.pid` 认，GPU 进程按类型认 |
| 主进程、agent | 事件循环延迟 p99 / 最大 | 经 inspector 注入 `monitorEventLoopDelay`（分辨率 10 ms，报告时已减掉） |
| 端到端 | 回车到假模型收到请求、每次工具往返的额外开销、回车到首字上屏 | 假模型和驱动在同一个 Node 进程里、同一个时钟；工具往返额外开销 = 假模型发完工具调用到收到下一个请求的间隔 |

假模型（`mock-llm.mjs`）实现 OpenAI 兼容的流式接口，行为只由用户消息里的指令决定，例如 `tokens=300 rate=50 ttft=300 tool=2`。工具调用用 `read` 读一个 8 KB 的文件，不用 `bash`，因为 Windows 上没有 `/dev/zero`。它固定报 1000 个输入 token，避免 15 MB 级的历史触发自动压缩。

## 素材怎么截的

素材是用户自己的会话 6df79261（DDPM 读论文），原样、未脱敏，只在用户自己的两台机器之间传，不进仓库。它有 71 条用户消息，其中 10 条被撤回，剩下 61 轮，就是「60 轮会话」。

Orbita 的会话记录和 pi 的会话本都只追加不改写，所以截到第 N 轮的做法是取两份文件的前缀：切在第 N 轮之后出现的第一条用户消息前面（不管它后来有没有被撤回），pi 那份按同一条消息（时间戳相同）对齐。这样每个快照都是会话当时在盘上的真实样子。

100 轮超出了原会话，做法是整条会话后面再接一份前 39 轮的复制：复制段的所有 id 换新（含 parentId、toolCallId、撤回目标），时间整体后移，pi 那段接在原会话最后一条下面。所以 100 轮的体量是 20.5 MB，不是按比例推算的 25 MB 左右，因为前 39 轮比后面的轮次轻。另外，每个刻度里还有一条只有 1 轮的「bench-home」会话，切会话就是从它切过去。

每次「跑一轮」和「打字」都会往会话里追加一轮（约 20 KB），一个刻度跑完会多出 12 轮。这对 60、100 轮影响很小，对 10 轮（1 MB）的体量约增加 20%，看 10 轮的数时要记得这一点。

## 已知的局限

- 假模型走 OpenAI 协议，用户真实会话走 Anthropic 协议，流式解析那一段代码路径不同。
- 用 `electron .` 跑 `out/` 里的生产 bundle，和安装包里的是同一份代码，但 `app.isPackaged` 为假：不接自动更新、托盘图标路径不同、不用随包的 rg / fd。这几处都不在测量路径上。
- 主进程与 agent 进程的 inspector 必须等界面加载完再接。实测在 agent 进程启动后 1 秒内就执行表达式，会报 `Promise was collected`，随后进程退出；等界面出来以后再接就没事。原因没查清，推断是打断了它的启动期。
- 挂 inspector、开观察器、每 250 ms 采一次进程指标都有开销。开销最大的是记帧间隔用的 `requestAnimationFrame` 循环：它让页面在空闲时也每帧都出帧。Mac 上实测，空闲 8 秒里它让 renderer 多用约 0.1–0.3 CPU 秒；流式输出时页面本来就在每帧重绘，挂不挂它，一轮的 renderer CPU 秒都是 3.6。所以「空闲 8 秒」那张表偏高，其他表基本不受影响。
- 这一版还没有子会话并发、滚动、回放增长（0 → 100 轮逐轮记）和自动 CPU profile 归因。
