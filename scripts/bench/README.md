# Orbita 性能测量（bench/perf 分支）

这套脚本用一个本地假模型代替真实模型，把用户的真实长会话截成若干快照，用**生产构建**起一个隔离实例，从外面接上 renderer、主进程、agent 进程三处调试口，量这几件事：打开会话时传了多少、读一遍文件多久；切到这条会话；跑一轮；流式输出时打字；空闲；以及触发一次自动压缩、看压缩前后有什么变化。每个数都按进程分开记，Mac 和 Windows 跑的是同一份脚本、同一份素材。它不改应用代码，只放在 `bench/perf` 分支上，不进 main。

## 一条命令跑完

素材是三个 zip，不在仓库里，单独传：`fixture-6df79261.zip`（24 MB）、`fixture-fb46e6be.zip`（126 MB）、`fixture-8ee32d1b.zip`（207 MB）。放到本机任意不含中文的目录，然后在本分支的仓库根目录执行：

```bash
bun install
node scripts/bench/bench.mjs --fixture <6df79261.zip> --fixture <fb46e6be.zip> --fixture <8ee32d1b.zip> --actions "6df79261=switch,turn" --label <这台机器的名字>
```

这条命令和 Mac 基线 v2 跑的是同一套：6df79261 只量切会话和跑一轮（它的完整四个动作在 v1 基线里），另两条会话量全部动作外加压缩场景。脚本先做一次生产构建（`electron-vite build`），然后每个刻度单独起实例。结果写到仓库根的 `bench-results/<label>-<时间>/`：`result.md` 是表，`result.json` 是原始数据，`instance-*.log` 是实例日志，某一格失败时还会有 `fail-*.png` 截图。

M3 Max 上这一套实测约 41 分钟（6df79261 约 6 分钟，另两条各约 17 分钟）。慢一些的机器，推断要 1.5–2.5 小时；中途想停，Ctrl+C 即可，已跑完的刻度都已写进 `result.json`。

### Mac

```bash
git fetch origin && git worktree add ../orbita-bench origin/bench/perf && cd ../orbita-bench
bun install
node scripts/bench/bench.mjs --fixture ~/Downloads/fixture-6df79261.zip --fixture ~/Downloads/fixture-fb46e6be.zip --fixture ~/Downloads/fixture-8ee32d1b.zip --actions "6df79261=switch,turn" --label mac
```

需要 Node 22 以上（脚本用到 Node 自带的 `WebSocket` 与 `fetch`）。

### Windows（PowerShell）

```powershell
git fetch origin; git worktree add ..\orbita-bench origin/bench/perf; cd ..\orbita-bench
bun install
# electron 二进制没装上时（node_modules\electron\path.txt 不在）补一次：
node node_modules\electron\install.js
node scripts\bench\bench.mjs --fixture C:\orbita-bench\fixture-6df79261.zip --fixture C:\orbita-bench\fixture-fb46e6be.zip --fixture C:\orbita-bench\fixture-8ee32d1b.zip --actions "6df79261=switch,turn" --label win-g14
```

脚本第一次运行时会把每个 zip 解到 `%TEMP%\orbita-bench\` 下，之后复用；解开后约 500 MB，每个刻度铺实例时还会临时再占 150–300 MB。

### 子会话并发（单独一节）

```bash
node scripts/bench/bench.mjs --fixture <fb46e6be.zip> --fixture <6df79261.zip> --scenario concurrency --label <机器名>-conc
```

母会话是 fb46e6be·end（93 MB），下面挂 5 条子会话，分两档体量各起一个实例：小的每条是 6df79261·10（1 MB），大的每条是 6df79261·60（16 MB）。K = 0 / 1 / 3 / 5 条子会话同时开轮，各档轮流跑 3 遍。每档有两种变体：一种是母会话空着、在它的输入框里打字；另一种是母会话自己也跑一轮。子会话由驱动直接调 `window.orbita.agent.submit` 开轮，不经母会话的 delegate，理由见 `bench.mjs` 里这一节的注释。结果在 `concurrency.md` 与 `result.json` 的 `concurrency` 字段。M3 Max 上实测约 8 分钟。可调的参数有：`--conc-mother fb46e6be:end`、`--conc-child 6df79261`、`--conc-sizes 10,60`、`--conc-counts 0,1,3,5`、`--conc-reps 3`、`--conc-no-mother-turn`。`--scenario all` 先跑刻度再跑并发。agent 调试口接不上时，agent 列缺测，其余照量。

### 其它参数

`--ticks "fb46e6be=pre4,end;6df79261=60"` 只跑部分刻度。刻度的写法有三种：数字 N 是前 N 轮；`pre<k>` 是第 k 次压缩那一轮之前（盘上只有 k−1 次压缩）；`end` 是整条会话。不写就用素材 manifest 里的默认值：6df79261 是 10/30/60/100，fb46e6be 是 pre2/pre4/end，8ee32d1b 是 pre2/pre3/end。

`--actions` 选动作（`switch,idle,turn,type,compact`），写成 `素材=动作,…` 只改那个素材。`--runs 5` 是每格次数；会话文件超过 30 MB 的格按 `--runs-big`（默认 3）跑。`--compact-reps 3` 是压缩场景重复几次，0 表示不跑。另外还有：`--no-build` 跳过构建，`--out <目录>` 改结果位置，`--work <目录>` 改临时数据位置。

**动作的先后就是测量的顺序**：冷打开 → switch → idle → turn → type，打开探针（含主进程 / agent 里的 readParse ×3）放在整条动作序列的**最后**——它的即弃对象（约三倍文件体积）若排在前面，会叠进后面动作的进程内存读数；idle 开始前还会经 inspector 对主进程与 agent 各做一次手动 GC，让 idle 的工作集反映真实驻留而不是「垃圾挂多久」。探针自己量的是 CPU 计时，放在最后不受先前动作影响；session:load 的尾窗量此时会含 turn / type 追加的轮次。

## 用你自己的会话当素材（pack.mjs）

上面三个 zip 是维护者 Mac 上的会话。要量自己机器上最重的会话，先在终端里（不是在 Orbita 的对话里——Orbita 的 agent 读不了 sessions/ 与 pi-sessions/）列出来，再打成素材目录：

```powershell
node scripts\bench\pack.mjs --list
node scripts\bench\pack.mjs --session <id 前 8 位>
node scripts\bench\bench.mjs --fixture bench-fixtures\<id 前 8 位> --label <机器名>-own
```

`--fixture` 接目录也接 zip。素材目录的默认刻度按压缩次数定（压缩 ≥ 2 次：pre2 / 最后一次压缩前 / end；没压缩：10 / 30 / 60 / end）。并发场景把母会话换成自己的：`--scenario concurrency --conc-mother <id8>:end --conc-child <另一条的 id8>`。素材是原样副本，不要传出本机。

## 跑的时候要注意

**窗口要一直看得见。** 窗口被盖住或最小化时，Chromium 会停掉 `requestAnimationFrame`，帧相关的数会变成 0。脚本会在 `result.md` 的「警告」里标出这种情况，但不会去动窗口层级。跑的这段时间里不要用这台机器，也不要让它睡眠（脚本不会替你改电源设置）。每个刻度会新起一个 Orbita 窗口，这是正常的。

**插电，并记下电源模式。** Windows 笔记本拔电会降频。脚本只读地记录三件事，写进结果头部：是否插电、`powercfg /getactivescheme` 的当前方案、Defender 实时防护是否开着。它不关 Defender，也不加排除项。

**端口。** 假模型在 5300–5799 里挑第一个可用的端口，renderer 调试口在 39300–39999 里挑。范围给得宽，是因为 Windows 的 winnat（Hyper-V/WSL）每次开机在低位段随机保留整段端口（实测 5305-5404 整段保留过，窄段会被整段吞掉）；脚本先查 `netsh int ipv4 show excludedportrange`，跳过系统保留段（同 `scripts/try-pr.ps1`），再逐口试绑。主进程与 agent 进程的 inspector 用 `--inspect=0`，由系统分配临时端口。不会碰 5273。

**它会在家目录下建一个空的 `Orbita-bench` 文件夹**（应用按 `--user-data-dir` 的目录名派生工作区根）。跑完可以删。

**停实例只按自己记下的 PID。** Mac 发 SIGTERM，Windows 用 `taskkill /PID <pid> /T /F`。不按进程名杀，不影响你正在用的 Orbita。

## 两份结果并排

```bash
node scripts/bench/compare.mjs <A/result.json> <B/result.json> --out compare.md
```

每格是「A 中位数 → B 中位数（变化%）」，刻度按「素材·刻度」配对，v1 的结果也能比。可以拿来比 Mac 对 Windows，也可以比改前改后：同一台机器、同一份素材，在优化 PR 的 base 上跑一次、head 上再跑一次，把表贴进 commit 正文。

## 量了什么、怎么量的

| 进程 | 指标 | 怎么采 |
|---|---|---|
| renderer | 长任务个数 / 合计 / 最长；帧间隔 p95 与 >50 ms 的帧数 | 页面里挂 `PerformanceObserver('longtask')` 和 `requestAnimationFrame` |
| renderer | 按键到下一帧的延迟 p95 / 最大 | Event Timing（`PerformanceObserver('event')`，阈值 16 ms，没上报的按键按 16 ms 计），CDP 真键盘逐字敲 40 个字符 |
| renderer | 切会话：点击到界面静止 | 真鼠标点侧栏；静止 = 点击后有过 DOM 变化，且 500 ms 内不再变 |
| 打开会话 | `session:load` 耗时、尾窗条数与字节、尾窗里的压缩界碑、DOM 节点数 | 从 renderer 直接调同一个 IPC 三次取中位数 |
| 主进程、agent | 同步读一遍、逐行 `JSON.parse` 一遍自己那份会话文件的耗时 | 经 inspector 在该进程里执行。这是「每轮整份重读」的下界模拟，不是应用的原函数 |
| 各进程 | CPU 秒、工作集 | 主进程里每 250 ms 采一次 `app.getAppMetrics()`；CPU 秒用 `cumulativeCPUUsage` 求差（`percentCPUUsage` 在 Mac 上严重偏低） |
| 主进程、agent | 事件循环延迟 p99 / 最大 | 经 inspector 注入 `monitorEventLoopDelay`（分辨率 10 ms，报告时已减掉） |
| 端到端 | 回车到假模型收到请求、每次工具往返的额外开销、回车到首字上屏 | 假模型和驱动在同一个 Node 进程里，用同一个时钟 |
| 压缩 | 正文结束到界碑落盘、到摘要请求到达、摘要请求个数与大小；压缩前一轮与压缩后第 1–3 轮的「跑一轮」 | 见下 |

假模型（`mock-llm.mjs`）实现 OpenAI 兼容的流式接口，行为只由用户消息里的指令决定，例如 `tokens=300 rate=50 ttft=300 tool=2`。工具调用用 `read` 读一个 8 KB 的文件。平时它固定报 1000 个输入 token，避免触发自动压缩。

**压缩场景。** 测量模型声明的窗口是 200 万 token。pi 在「上一条回复报的上下文 > 窗口 − 20% 保留量 = 160 万」时自动压缩，素材里真实回复报的用量最多几十万，不会误触。压缩那一轮的正文回复报 `ctx=1700000`，pi 在轮末压缩。摘要请求（认它的 system prompt）由假模型固定等 2 秒，再回一段约 6 KB 的摘要，所以两台机器上「模型那部分」一样长，剩下的差别都是 Orbita 自己的。每次压缩场景都起一个新实例，依次跑：预热一轮（不计）、压缩前一轮、压缩那一轮、压缩后三轮。普通轮里会记「摘要请求个数」，它应当恒为 0；非 0 说明那一轮意外又压缩了一次。

## 素材怎么截的

三条都是用户自己的会话，原样、未脱敏，只在用户自己的两台机器之间传，不进仓库。

| 素材 | 会话 | 轮数 | 压缩 | 会话文件 / pi 会话本 |
|---|---|---|---|---|
| 6df79261 | 落实C：DDPM基线与阅读分工 | 61 | 0 | 15.8 / 16.2 MB |
| fb46e6be | 意图系统可视化审核（从 Proma 导入） | 105 | 4 | 92.6 / 98.3 MB |
| 8ee32d1b | 维护Kimi模型列表回顾与发散 | 95 | 3 | 141.5 / 144.6 MB |

「轮」是 Orbita 会话里的用户消息去掉被撤回的。pi 会话本里的用户消息更多，因为那里还包含子会话完成时投递回来的消息。

Orbita 的会话记录和 pi 的会话本都只追加不改写，所以截某个刻度就是取两份文件的前缀：在某条用户消息前切一刀，pi 那份按同一条消息对齐（文字相同、时间最近；从 Proma 导入的那条两边文字对不上，就按时间戳对齐，实测两边只差 1 ms）。6df79261 的 100 轮超出了原会话，做法是整条会话后面再接一份前 39 轮的复制，所有 id 换新、时间后移。压缩过的会话不做这种拼接。每个实例里还有一条一问一答的「bench-home」，切会话就是从它切过去。

每次「跑一轮」和「打字」都会往会话里追加一轮（约 20 KB）。这对 10 轮那格的体量影响约 20%，其余格可以忽略。

## 已知的局限

- 假模型走 OpenAI 协议，用户真实会话走 Anthropic 协议，流式解析那一段代码路径不同。
- 用 `electron .` 跑 `out/` 里的生产 bundle，和安装包是同一份代码，但 `app.isPackaged` 为假：不接自动更新、托盘图标路径不同、不用随包的 rg / fd。这几处都不在测量路径上。
- 主进程与 agent 进程的 inspector 必须等界面加载完再接。实测在 agent 进程启动后 1 秒内就执行表达式，会报 `Promise was collected`，随后进程退出；原因没查清。
- 挂 inspector、开观察器、每 250 ms 采一次进程指标都有开销。开销最大的是记帧间隔用的 `requestAnimationFrame` 循环：Mac 上实测，空闲 8 秒里它让 renderer 多用约 0.1–0.3 CPU 秒；流式输出时页面本来就在每帧重绘，影响可以忽略。
- 压缩的摘要由假模型固定 2 秒回出，量不到真实模型写摘要要多久，量的是 Orbita 在它前后花的时间。
- 还没有子会话并发、滚动、回放增长（0 → 100 轮逐轮记）和自动 CPU profile 归因。
