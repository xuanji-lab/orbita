/**
 * computer use（Windows 沙箱隔离环境）契约 —— IPC 四层的第 1 层。
 *
 * 定位（2026-10 终审裁决）：v1 的 computer use = **Windows Sandbox 里的网页自动化**。
 * agent 的输入注入发生在沙箱会话内部（guest 桥），宿主完全不碰用户桌面的焦点与键鼠。
 * 隔离路线 = 一份 .wsb（Anthropic demo 的 Windows 同构）：MappedFolder 把 guest 桥只读映射
 * 进去、把输出目录读写映射进去，LogonCommand 先建 junction 再启动桥——具体生成在
 * src/main/computer-use/sandbox.ts。设计取舍（为什么不走网络、为什么是文件协议、为什么直探
 * 序号而不是枚举目录）全写在本文件与那几个模块的注释里，加上 commit 历史——调研笔记不进仓，
 * 外部贡献者拿不到，所以别在注释里引用仓外的文档。
 *
 * 出网：.wsb 的 <Networking> 缺省是 Default（沙箱能上网）。v1 要的就是网页自动化，所以这是
 * **有意放开的攻击面**：沙箱内的进程（含 agent 打开的网页）能访问网络与宿主所在内网，
 * 别把它当成「防网络的隔离层」。设置 › 实验功能 › 电脑使用 里有「允许沙箱出网」开关
 * （缺省值见 COMPUTER_USE_DEFAULT_ALLOW_NETWORK，即开）：关掉后 .wsb 渲染成
 * <Networking>Disable</Networking>，沙箱里只剩本地桌面自动化。.wsb 只在启动时渲染一次，
 * 所以这个改动**只对下一次启动生效**，运行中的 VM 仍按它启动时的设置（设置页常驻一行说明这件事）。
 *
 * 宿主↔guest 协议（宿主在 src/main/computer-use/ 实现，guest 桥是独立 exe，两边必须严格一致）：
 *   - 通道 = **TCP 优先，文件回退**（0.8.0 起）。文件协议原来是唯一通道：宿主防火墙曾把
 *     宿主↔沙箱的 TCP 当不可测（2026-10-10 真机：ICMP 通、TCP 被丢），而 .wsb 读写映射
 *     文件夹双向实时同步、每次都可靠。但它**每一跳**传播实测 2.9–7.5 秒（2026-10-25 真机
 *     计量），于是每个沙箱工具都天然背 8–10 秒的下限；同一天的隔离沙箱实验里宿主→guest 的
 *     TCP 是握手 30ms、小包中位 1ms、64KB 往返 2–6ms，两侧都不用动防火墙。所以命令优先走
 *     TCP，文件协议**一条行为都没删**：它是老桥的唯一通道，也是 TCP 不可用时的回退。
 *   - TCP 命令：【bridge.json 通告 port / token / ipv4】→ 宿主连进 guest → 首行 hello + 令牌
 *     → 之后一行一条 {id, command, fields} / {id, resp, jpegBase64?}。详见 bridgeTcpHello。
 *   - 文件协议：宿主写 out/cmd/<名字>.req.json（tmp+rename 原子写）→ 桥轮询执行 →
 *     写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件，先于 resp 落盘）→ 删 req；
 *     宿主读完响应后负责清理 resp / jpg。
 *   - 就绪：桥启动后写 out/bridge.json（tmp+rename）——它出现即代表命令循环已上线。
 *   - 鉴权：文件协议靠隔离（命令目录在宿主用户目录下、沙箱是一次性环境）；TCP 靠
 *     bridge.json 里的随机令牌——同一个沙箱里还跑着 agent 打开的网页，端口不是口令。
 *
 * PR1 范围 = 沙箱生命周期 + renderer 手动「看一眼」截图。
 * PR2 范围 = agent 的像素工具组（截图 / 点击 / 打字 / 按键 / 滚动）：命令经
 * `computerUseRequest` / `computerUseResult`（agent-ipc.ts 的 requestId 问答，
 * browserRequest 同款）下发，**只有 agent 进程看得见**——renderer 面照旧只有 PR1 那四个入口。
 * PR3 范围 = 沙箱内 Edge 的 CDP 语义命令（`cdp-*`）与 agent 的 `sandbox_*` 工具组：
 * DOM 级操作，比像素工具稳；像素工具留作 CDP 不可用时的兜底。
 * CDP 的 WebSocket **只在 guest 里**（桥 ↔ 同机的 Edge），不过映射目录、不过 IPC；
 * 宿主看见的仍然是一条语义命令 + 一个扁平回执。
 *
 * 调用方：
 *   renderer   → computerUseProbe / Start / Stop / Screenshot（renderer 发起、主进程执行）
 *   主进程     → computerUseStatus（状态机每次迁移推给 renderer，单向）
 *   agent 进程 → computerUseRequest / computerUseResult（工具定义 → requestId 问答，薄包装）
 */


export const computerUseChannels = {
  /** 能力探测（全部只读）：Windows 版本、沙箱功能状态、可执行文件在不在。不就绪时结果里给手动开启指引 */
  computerUseProbe: "computer-use:probe",
  /** 生成 .wsb 并启动沙箱；状态机 off→starting，bridge.json 就绪→running，超时→error */
  computerUseStart: "computer-use:start",
  /** 停止沙箱（杀掉我们 spawn 的 WindowsSandbox.exe，沙箱内全部状态丢弃）。幂等 */
  computerUseStop: "computer-use:stop",
  /** 对沙箱桌面截一张（guest 桥执行），maxWidth 控制回图宽度 */
  computerUseScreenshot: "computer-use:screenshot",
  /** 主进程 → renderer：沙箱状态机每次迁移推一次最新 SandboxStatus */
  computerUseStatus: "computer-use:status",
  /**
   * renderer 发起、主进程回答：**当前**状态（不依赖迁移推送）。
   * 设置页每次挂载拉一次——沙盒是应用级的，页面切走再回来时不能按 off 画。
   */
  computerUseStatusGet: "computer-use:status-get",
  /**
   * 急停热键的注册状态（renderer 发起、主进程回答）。**注册失败必须让用户看见**：
   * `globalShortcut.register` 被占用时返回 false 而不是抛错，不 surface 的话用户
   * 以为自己有保护。设置页每次挂载问一次。
   */
  computerUseEmergencyStopState: "computer-use:emergency-stop-state",
  /**
   * 设置页问「现在有哪些后端可选」。**列表由主进程给**：开发者后端（qemu）只在
   * `ORBITA_CU_DEV_BACKENDS` 开着时才出现，renderer 不自己硬编码三档。
   * 只读，不改变任何状态。
   */
  computerUseBackends: "computer-use:backends",
  /**
   * 设置页问「现在沙箱桌面被谁占着」。有主时给会话 id、标题与已持有毫秒数；
   * 没人持有给 null。**观测只读**：它的真源是主进程那份桌面租约（lease.owner），
   * 不另写一套状态——否则设置页与闸门会各说各的。
   */
  computerUseLeaseStatus: "computer-use:lease-status",
  /**
   * renderer 回答主进程挂起的「电脑使用授权」提问（请求-应答，requestId 对号）。
   * 提问本体走 agent:event 的 `computerUseConsentAsk`——与 intentAsk / 急停同一条
   * 主进程广播通道（renderer 只有这一条订阅）。
   */
  computerUseConsentAnswer: "computer-use:consent-answer",
} as const;

export type ComputerUseChannel = (typeof computerUseChannels)[keyof typeof computerUseChannels];

/**
 * 桌面租约的观测回执（设置页「沙箱归属」一行）。
 *
 * `null` = 现在没人持有桌面（空闲）；否则是持有它的那条会话与**已经持有多久**。
 * 毫秒数由主进程在回答那一刻现算（`now - since`），不是租约里存的字段——租约的
 * `lastActive` 是 idle 线的起点，语义不同，不能拿来报「持有了多久」。
 *
 * `title` 读会话 meta；读不出（会话刚建 / 已删）时是空串，界面自己兜一句「未命名会话」。
 */
export type ComputerUseLeaseStatus = {
  sessionId: string;
  title: string;
  /** 从 acquire 成功那一刻算起的毫秒数 */
  heldMs: number;
} | null;

// ── 协议常量（宿主与 guest 桥共用的数字/路径，改动即破坏两端）──────────────

/** guest 桥在沙箱内的落点（.wsb 用 junction 把映射目录并到这里，协议按这个路径执行） */
export const COMPUTER_USE_GUEST_BRIDGE_DIR = "C:\\orbita-bridge";
/** 输出目录在沙箱内的落点（读写映射：桥写在这里，沙箱销毁后宿主目录里仍在——产物回传通道） */
export const COMPUTER_USE_GUEST_OUT_DIR = "C:\\orbita-out";
/** 桥的地址通告文件名（落在 out 目录下；宿主轮询它等桥上线） */
export const BRIDGE_INFO_FILE = "bridge.json";
/** 命令目录名（out 目录下；宿主写 req、桥写 resp 的地方） */
export const COMPUTER_USE_CMD_DIR = "cmd";
/**
 * 「让 guest 自己关机」的请求文件（out 目录下，桥 0.13.0 认它）。
 *
 * 宿主 stop 时先原子写这个文件、再补发 `shutdown` 命令：**「刚起就关」那一刻命令通道
 * 还没通**（桥还没登入），文件是唯一能把意图带进沙箱的方式——桥登入后第一件事就是读它
 * 并执行 `shutdown /s /t 0 /f`。桥读完会删掉它；宿主每次 start 也先清一遍（跨局复用 out）。
 */
export const COMPUTER_USE_SHUTDOWN_REQUEST_FILE = "shutdown.request";

// ── guest 桥的 TCP 命令通道（桥 0.8.0 起；文件协议降级为启动握手与回退通道）────
//
// 为什么加它：文件协议**每一跳**的传播实测 2.9–7.5 秒（2026-10-25 真机计量，而 guest
// 内部处理只有毫秒级），所以一次 sandbox_navigate 天然就是 8–10 秒。而宿主→guest 的
// TCP 在同一天的 一次性沙箱实测里完全可用：首次握手 30ms、20 次小包 RTT 中位 1ms、
// 10 次 64KB 往返 2–6ms（回程正是截图方向）、空闲 5s 后重连 2ms，且**两侧都不用动
// 防火墙规则**。所以命令优先走 TCP。
//
// 但文件协议**一条现有行为都不删**：它是老桥（没有下面这三个字段）的唯一通道，也是
// TCP 不可用时的回退通道。两条通道的回执形状完全一样，上层语义一个字都不用改。

/** bridge.json 的 TCP 扩展字段名。三个都齐才算可用；缺一个 = 老桥，纯文件协议 */
export const bridgeTcpFields = {
  /** 桥在 guest 里监听的端口（TcpListener 绑 0 = 系统分配，每次启动都不同） */
  port: "port",
  /** 每次启动随机生成的十六进制令牌（32 字符）：同一个沙箱里还有别的进程，端口不能当口令 */
  token: "token",
  /** 桥所在机器的全部非回环 IPv4（宿主按通告顺序逐个试连，全失败就回退文件协议） */
  ipv4: "ipv4",
} as const;

/**
 * 一条连接上的行协议（一行一条 JSON，UTF-8，`\n` 结尾）：
 *
 *   1. 首行 `{"t":"hello","token":"<token>"}`；桥回 `{"t":"hello-ok"}` 才算握手成功，
 *      回 `{"t":"hello-fail"}` 并立刻断开 = 首行不是 hello / 令牌不符。握手之前桥不接受任何命令。
 *   2. 命令 `{"id":<n>,"command":"<cmd>","fields":{...}}`——`fields` 与文件协议里那份同形，
 *      桥把整行原样交给同一个 Execute，所以两条通道的回执逐字一致。
 *   3. 回执 `{"id":<n>,"resp":{...}}`；截图的 JPEG 内联在 `jpegBase64`（resp 里的 `jpeg`
 *      字段照旧保留，与文件协议逐字一致，只是它指向的那个文件被桥读完即删）。
 *
 * 一条连接上可以连续发多条命令（按 id 对号），断开连接不影响桥本身继续跑文件协议。
 */
export const bridgeTcpHello = {
  type: "hello",
  ok: "hello-ok",
  fail: "hello-fail",
} as const;

/** bridge.json 里通告的 TCP 通道（`parseBridgeInfo` 解析；缺任一字段 = undefined = 走文件） */
export interface GuestTcpChannel {
  port: number;
  token: string;
  ipv4: string[];
}

/** 连一个候选地址（含 hello 握手）的预算：多网卡逐个试，全部失败就回退文件协议 */
export const BRIDGE_TCP_CONNECT_TIMEOUT_MS = 1_500;

/**
 * TCP 失败后的冷却窗口：这期间所有命令直接走文件协议。
 *
 * 为什么不每条命令都重试：TCP 不可用（防火墙规则被改、网卡还没起来）时，每条命令都要
 * 先白等 1.5s × 候选地址个数——比文件协议本身还慢，而 TCP 挂在半路时一次截图就能卡到
 * 命令预算耗尽。10s 是「沙箱网络刚起来 / 刚挂掉」的粒度：够长到不拖慢一串命令，够短到
 * 网络恢复后的下一次操作就能用上 TCP。
 */
export const BRIDGE_TCP_COOLDOWN_MS = 10_000;

/**
 * guest 桥认的命令名。**字符串两端的唯一真源**：宿主按它发，桥按它分派
 * （guest-bridge/Program.cs 的 Execute），改一个字母就是两端脱钩。
 * 载荷都是扁平的 JSON 对象，形状见各 ComputerUseToolRequest 分支。
 */
export const computerUseGuestCommands = {
  /** 就绪探针：映射文件夹 host→guest 开机后有热身期，桥通告了不代表命令通道已通 */
  ping: "ping",
  /** 截沙箱主屏一张，回 JPEG 兄弟文件 + 回图/物理屏两套尺寸 */
  screenshot: "screenshot",
  /**
   * 列出可截图的顶层窗口（桥 0.9.0）：`{windows:[{hwnd,title,process,className,x,y,w,h,minimized,visible}]}`。
   * 只读、不抢焦点。用途是让模型/宿主知道「该拍哪个窗口」——按标题匹配失败时宿主用它列候选。
   */
  winList: "win-list",
  /**
   * 按**窗口**截图（桥 0.9.0）：`{hwnd?, title?, maxWidth?}`，hwnd 优先，否则标题包含匹配。
   * PrintWindow(PW_RENDERFULLCONTENT) 读窗口自己的 surface：**被别的窗口遮住也拍得到**，
   * 所以这条路径不占桌面租约（见 isWindowScreenshotRequest）。
   */
  winShot: "win-shot",
  /**
   * 列出某个窗口里的可交互控件（桥 0.10.0）：`{hwnd?, title?, maxItems?}`。只读、不抢焦点。
   * 走 UI Automation（UIA）而不是像素：UIA 直接读那个窗口的控件树，不需要它在前台。
   * 回执见 ComputerUseUiaListResult。
   */
  uiaList: "uia-list",
  /**
   * 对一个控件执行 UIA 模式（桥 0.10.0）：`{hwnd?, title?, ref?, name?, action, value?, timeoutMs?}`。
   * action = invoke / setValue / selection。三条都**不抢前台**（桥把 IUIAutomation2 的
   * AutoSetFocus 置 false），所以不占桌面租约（见 isUiaRequest）。
   * **没有 focus**：Element.SetFocus 会移动桌面级键盘焦点，与车道前提冲突，桥 0.11.0 已删
   * （拒绝文案见 computerUseUiaErrors.focusRemoved）。
   */
  uiaAct: "uia-act",
  /** 移动指针并按键（SendInput 绝对坐标，沙箱原生物理像素） */
  click: "click",
  /** 逐字符 Unicode 注入（KEYEVENTF_UNICODE，中文可用），落在当前焦点窗口 */
  type: "type",
  /** 按一个键或一组组合键（键名→VK 的映射表在桥里） */
  key: "key",
  /**
   * 把指针移到某点并滚轮（正数向下）。deltaY 的单位是**滚轮格数**：桥乘 WHEEL_DELTA
   * 得到 Windows 的 wheel 数据（wheel 正数向上，所以桥取负）。
   */
  scroll: "scroll",

  // ── 打包产物冒烟（0.5.0）：不起沙箱里的 agent 就不发这几条 ──
  /**
   * 在沙箱里启动一个可执行文件（`{path, args?}`）→ `{ok, pid}`。
   * path 必须是沙箱桌面下的绝对路径（桥的 `GuestPathRejection` 只会放行 `.exe`）。
   * 用途只有一个：跑只读映射进来的打包版（`C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app\\orbita.exe`）。
   */
  launch: "launch",
  /**
   * 让 guest 自己关机（桥 0.13.0）：`{}` → `{ok}`。**关沙箱的首选路径**——宿主在 stop 时
   * 先落 `out/shutdown.request`（刚起就关时命令通道还没通），再补发这一条；VM 停掉之后
   * 沙箱窗口与 VM 内存一起消失，不需要点窗口上的 X、更不需要按确认框。
   * 老桥（< 0.13.0）不认它，回 `{ok:false, error:"未知命令…"}`，宿主据此退回关窗脚本。
   */
  shutdown: "shutdown",
  /**
   * 按 pid 杀进程树（`{pid}`）→ `{ok}`。**绝不按镜像名杀**——沙箱里可能同时跑着
   * 用户自己开的同程序进程。pid 已经不存在时也回 ok（幂等，冒烟脚本在 finally 里无脑调）。
   */
  kill: "kill",
  /**
   * 只回数字的截图统计（`{maxWidth?}`）→ `{width, height, mean, stdDev, blackRatio, whiteRatio, distinctColors}`。
   * 冒烟脚本靠它断言「画面非空、不是全黑/全白」：不需要宿主解 JPEG，也不需要基线图。
   */
  screenshotStats: "screenshot-stats",

  // ── CDP 浏览器通道（PR3）：一条命令内部 3~4 条 CDP 消息，但只算**一次**文件往返 ──
  // 0.6.0 起这些命令都认一个**可选**的 `session`（字符串）：缺省 `default`，桥按它选那个会话
  // 自己的 Edge 实例（各自的 --user-data-dir 与调试端口）。上限 COMPUTER_USE_BROWSER_MAX，
  // 空闲 COMPUTER_USE_BROWSER_IDLE_MS 后自动回收。只有 `cdp-status` 不带 session 时是
  // 「汇总所有会话」的形态；其余命令（含 cdp-stop）都只落在一个实例上。
  /** 起沙箱内的浏览器（默认 Edge，可配；见 COMPUTER_USE_BROWSER_CHOICES）并等到 CDP 可用（幂等）。端口取 0 让系统分配，桥读 DevToolsActivePort */
  cdpStart: "cdp-start",
  /** 只停桥自己启动的那个 Edge 进程树（按记录的 pid；绝不按镜像名杀） */
  cdpStop: "cdp-stop",
  /** 一眼现状：running / port / 当前标签页清单（供降级判定与模型自查） */
  cdpStatus: "cdp-status",
  /** 导航并等加载完成；内部用 readyState 轮询而不是等 loadEventFired 事件 */
  cdpNav: "cdp-nav",
  /** 正文文本 + 可交互元素清单（每条都带可直接用于 click/type 的选择器与中心坐标） */
  cdpObserve: "cdp-observe",
  /** 按选择器点击：滚动到可见 → 取中心点 → 走浏览器输入管线（mousedown/mouseup） */
  cdpClick: "cdp-click",
  /** 聚焦选择器并把文本用 Input.insertText 送进去（中文安全），可顺带回车提交 */
  cdpType: "cdp-type",
  /** 取正文（或某个选择器的）文本，超长截断并回报总长 */
  cdpExtract: "cdp-extract",
  /** 在 guest 内部等：选择器出现（轮询）或固定毫秒数；一次往返搞定 */
  cdpWait: "cdp-wait",
  /** 页面截图：JPEG 写同名兄弟文件，回执只带文件名与两套尺寸（同 screenshot 通道） */
  cdpShot: "cdp-shot",
  /** 把映射目录里的文件喂给 <input type=file>（DOM.setFileInputFiles） */
  cdpUpload: "cdp-upload",
  /** 打开下载到映射目录（Browser.setDownloadBehavior），轮询到文件落定 */
  cdpDownload: "cdp-download",
  /** 标签页清单 / 切换（Target.getTargets + attachToTarget） */
  cdpTabs: "cdp-tabs",
} as const;

export type ComputerUseGuestCommand = (typeof computerUseGuestCommands)[keyof typeof computerUseGuestCommands];

// ── 沙箱里用哪个浏览器（0.12.0：可配，默认 Edge）────────────────────────────

/**
 * 沙箱里的浏览器选项。**默认 edge**，不是「Chrome 更好」——真机实测（同一台沙箱、同一套
 * CDP 口径）：
 *   - Edge（沙箱预装）：启动到 CDP 就绪 2152ms，每台沙箱准备成本 0；
 *   - Chrome（从宿主映射直跑）：3198ms；
 *   - Chrome（拷到沙箱本地盘）：2119ms，但每台沙箱多 3074ms（robocopy 515MB）。
 * 运行能力完全一样，Edge 因为预装所以零成本。可配是为了不把选择权写死，不是换默认。
 *
 * `auto` = 依次探测 edge → chrome → brave → chromium，第一个存在的就用（**不算回退**：
 * 它本来就没指定是谁）。不认识的字符串一律落回 `edge`（设置解析层与桥各兜一层）。
 */
export const COMPUTER_USE_BROWSER_CHOICES = ["edge", "chrome", "brave", "chromium", "auto"] as const;
export type ComputerUseBrowser = (typeof COMPUTER_USE_BROWSER_CHOICES)[number];
export const COMPUTER_USE_DEFAULT_BROWSER: ComputerUseBrowser = "edge";

/** 是不是一个合法的浏览器选项（设置解析与设置页共用；桥侧另有一份 C# 实现） */
export function isComputerUseBrowser(value: unknown): value is ComputerUseBrowser {
  return typeof value === "string" && (COMPUTER_USE_BROWSER_CHOICES as readonly string[]).includes(value);
}

/**
 * `cdp-start` 的 guest 字段（宿主下发）。
 *
 * `browser`：edge / chrome / brave / chromium / auto，或一条 guest 内的绝对路径（自定义
 * 路径的后门，不做 UI）；缺席 = edge。桥在 guest 里解析它，找不到就回退 Edge 并在回执里
 * 标记 `browserFallbackFrom`（加上实际的 `browser` / `browserPath`）。
 *
 * **这个字段必须一路传到 worker**：`cdp-*` 是在该会话的 worker 子进程里执行的，只改主桥
 * 等于没改。漏传的表现是「配了 Chrome 但实际还是 Edge」，而除了回执里的 browser 字段，
 * 没有任何地方看得出来。
 */
export type ComputerUseCdpStartFields = {
  session: string;
  browser?: string;
  headless?: boolean;
  port?: number;
  url?: string;
};

/**
 * 每会话一个 Edge 时 profile 的**根目录**（guest 绝对路径）：每个实例落在
 * `<root>\<安全化后的会话 id>`（见 safeBrowserSessionId）。
 *
 * **每次沙箱一次性**：不映射到宿主，沙箱销毁即丢——登录态不跨会话，这是产品语义
 * （与 Operator 的 ephemeral VM 同构）。桥的 cdp-start 在 guest 里建它，宿主不读它。
 *
 * v1.5-1 之前是所有会话共用一个 `C:\orbita-browser\profile`；改成按会话分目录不是
 * 「整理目录」，而是隔离的**实现**：共用 profile 时两个 Edge 实例会互相抢锁（Chromium 的
 * SingletonLock），第二个根本起不来。
 */
export const COMPUTER_USE_BROWSER_PROFILE_ROOT = "C:\\orbita-browser\\sessions";

/**
 * 沙箱里同时最多几个浏览器实例（一个会话一个 Edge）。
 *
 * 4 不是拍脑袋：sandbox guest 空载占 0.9–1.2GB，每个 Edge 约 0.4GB，.wsb 的配额给到 4GB
 * （sandbox.ts 的 `<MemoryInMB>4096</MemoryInMB>`）。上限由**桥**执行（它才知道真实活着的实例），
 * 宿主这一侧只在「缓存说已经到上限」时去问一次真值，见 cdp.ts 的 pruneAgainstBridge。
 */
export const COMPUTER_USE_BROWSER_MAX = 4;

/**
 * 空闲回收线：某个会话的浏览器这么久没被碰过，桥自动 cdp-stop 并删掉它的 profile 目录。
 *
 * 为什么要有它：模型想事情、等用户审批时 Edge 一直占着 ~0.4GB；4 个实例的上限下，一个
 * 忘了收尾的会话会把名额吃死（后面来的会话只收到「先 cdp-stop 一个」，而它没有可停的）。
 * 5 分钟是「一轮里正常的停顿」与「这个会话其实不用了」之间的折中（与租约 idle 同量级）。
 */
export const COMPUTER_USE_BROWSER_IDLE_MS = 5 * 60_000;

/**
 * 不传 `session` 时用的会话键。单 agent（只有一个会话）走的就是它——所有 `cdp-*` 命令
 * 不带上 session 字段时的行为与 v1.5-1 之前**完全一致**，这是向后兼容的那条线。
 */
export const COMPUTER_USE_DEFAULT_BROWSER_SESSION = "default";

/**
 * 会话 id → 目录名 / 桥侧键。**两端必须逐字一致**（宿主 cdp.ts 与 guest-bridge/Cdp.cs 各有一份）：
 * 只允许 `[A-Za-z0-9_-]`，其余一律换成 `_`，最长 48 字符；空 / 缺省回落 `default`。
 *
 * 为什么不能直接用会话 id：它会被拼进 `C:\orbita-browser\sessions\<id>`——一个带 `..` 或
 * `\` 的 id 就能把 profile 目录指到 guest 的任意位置（profile 目录里全是可执行配置）。
 * 反过来，宿主缓存也用同一个键：两边归一化规则不一致的话，两个宿主会话可能在桥侧撞成
 * 同一个浏览器，而宿主以为各自独立。
 */
export function safeBrowserSessionId(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return COMPUTER_USE_DEFAULT_BROWSER_SESSION;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return safe === "" ? COMPUTER_USE_DEFAULT_BROWSER_SESSION : safe;
}

/**
 * 浏览器实例层面的错误文案（**给模型读的**：它看不见 UI，也不会自己想到「4 个名额用完了」）。
 * 文案里的数字从常量来，别在别处再写一遍「4」——改上限时只有一处要改。
 */
export const computerUseBrowserErrors = {
  /** 第 5 个实例被拒（桥是执行者；宿主在缓存到上限时提前用同一句话拦下） */
  tooMany: (max: number): string =>
    `沙箱里同时最多 ${max} 个浏览器，先 cdp-stop 一个再开新的（不用的实例在空闲 ` +
    `${Math.round(COMPUTER_USE_BROWSER_IDLE_MS / 60_000)} 分钟后会自动回收）。` +
    "如果你只是要换一个页面，用 sandbox_navigate 打开它即可，不必再起一个实例。",
  /** 按会话停不掉（停沙箱的收尾路径）：只记日志，不让模型/用户看到一句没头没尾的报错 */
  stopFailed: (session: string, cause: string): string =>
    `按会话停浏览器失败（会话 ${session}）：${cause}。沙箱销毁会带走整个进程树，不影响后续操作。`,
} as const;

/**
 * 上传文件的落点（guest 绝对路径）。宿主先把用户给的文件拷进这里（映射目录的宿主侧就是
 * `<computerUseDir>/out/upload`），再把 guest 路径交给 cdp-upload。
 *
 * 桥只认这个前缀下的路径（白名单）：`DOM.setFileInputFiles` 能读 guest 里任意文件，
 * 不设边界等于让一份伪造的回执把映射目录当跳板。
 */
export const COMPUTER_USE_GUEST_UPLOAD_DIR = "C:\\orbita-out\\upload";

/** 下载文件的落点（guest 绝对路径，宿主侧同一目录：`<computerUseDir>/out/downloads`） */
export const COMPUTER_USE_GUEST_DOWNLOAD_DIR = "C:\\orbita-out\\downloads";

/**
 * 回图的宽度上限（缺省值）。回图会被缩放压成 JPEG——模型要看清按钮与文字，
 * 但每张图都吃上下文，1280 是这两个约束的折中（renderer 的「看一眼」同值）。
 * 桥按**长边**缩放，所以它同时是高度上限。
 */
export const COMPUTER_USE_SHOT_MAX_WIDTH = 1280;

/**
 * 密码框矩形缓存的过期线（毫秒）。**与 guest 桥的 `Mask.CacheMaxAgeMs` 同一个数字**：
 * 桥按它决定遮不遮，宿主按它写「这张图没遮」那句人话（两侧各有一份常量，C# 与 TS 不能共享
 * 一个定义，改一处必须改另一处）。取 30s 的理由写在 guest-bridge/Mask.cs。
 */
export const COMPUTER_USE_MASK_CACHE_MAX_AGE_MS = 30_000;

// ── 网页截图的遮罩回执（cdp-shot，桥 0.16.0）────────────────────────

/**
 * 一张**网页**截图（sandbox_screenshot）出图前遮了哪些帧、盖住几个字段、哪几个没到。
 *
 * 与 `ComputerUseCaptureInfo` 不是一回事：那份是**像素车道**（整桌面 / 按窗口截图，靠 UIA
 * 记下的控件矩形涂黑）；网页里的密码框是 DOM，UIA 看不见，只能进页面自己盖一层 overlay。
 *
 * 为什么是两组数字 + 一张清单，而不是一个「覆盖到哪一档」的枚举：枚举会被读成
 * 「所有 iframe 都盖住了」，而事实只是「枚举到的每个 target 都试过」——OOPIF 里再套同源子帧
 * 时，真正盖住的范围只有桥自己知道，读者只能靠 checked / covered / missing 自己判断。
 */
export interface ComputerUseShotMask {
  /** 实际盖住几个密码字段（每个字段一块 overlay，跨 document 求和） */
  fieldsCovered: number;
  /** 检查过几个帧（含没遮到的：检查过但没到的也在 missing 里） */
  framesChecked: number;
  /** 注入脚本跑成了几个帧（哪怕那一帧一个字段都没命中） */
  framesCovered: number;
  /** 没遮到的帧，逐条 "url — 原因"；全遮住时是空数组。**最多 8 条**（见 missingTotal） */
  missing: string[];
  /** 没遮到的帧**总数**；大于 missing.length 就说明清单被截断（正文会说「还有 N 条未列」） */
  missingTotal: number;
  /** 整体原因（预算不足 / 枚举失败 / 连接中断…），最多 200 字。全好时没有这个键 */
  error?: string;
}

/**
 * 从 cdp-shot 的回执里取遮罩信息。**老桥（没有这几个字段）回 undefined**：
 * 那时既不能说「遮了」也不能说「没遮」，两条都是谎话，所以正文里一个字都不添。
 *
 * `maskFieldsCovered` 是唯一的门槛字段（它在，其余几个才可信）；缺帧数时按 0、
 * 缺清单时按空数组——宁可少说，不可编。
 */
export function computerUseShotMask(resp: Record<string, unknown>): ComputerUseShotMask | undefined {
  const fieldsCovered = resp["maskFieldsCovered"];
  if (typeof fieldsCovered !== "number" || !Number.isFinite(fieldsCovered) || fieldsCovered < 0) return undefined;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  const rawMissing = resp["maskMissing"];
  const items = Array.isArray(rawMissing)
    ? rawMissing.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  const missing = items.map((item) => item.trim().slice(0, 160)).slice(0, 8);
  // 总数以桥给的为准；老一点的桥没这个字段时按数组长度兜底——但至少不能小于列出来的条数
  const stated = count(resp["maskMissingTotal"]);
  const error = resp["maskError"];
  return {
    fieldsCovered: Math.round(fieldsCovered),
    framesChecked: count(resp["maskFramesChecked"]),
    framesCovered: count(resp["maskFramesCovered"]),
    missing,
    missingTotal: Math.max(stated, missing.length),
    ...(typeof error === "string" && error.trim() !== "" ? { error: error.slice(0, 200) } : {}),
  };
}

/**
 * overlay 上那行字（画在**用户网页**里，所以必须跟界面语言一致：中文界面纯中文、英文界面纯英文）。
 * 桥不猜语言——`cdp-shot` 的 `maskLabel` 字段带过去，缺省时桥用英文 `Masked`。
 */
export const COMPUTER_USE_MASK_LABEL_ZH = "已遮罩";
export const COMPUTER_USE_MASK_LABEL_EN = "Masked";

/**
 * 按界面语言（`settings.language` 归一后的值）取遮罩标签。**纯函数**。
 *
 * 不认识的取值（缺省 / 脏数据）一律按英文——与 `effectiveLanguage` 的兜底一致（缺省 en），
 * 也与桥在字段缺席时用的默认值一致：两处都落在英文，不会出现一半中文一半英文。
 */
export function computerUseMaskLabel(language: string | undefined): string {
  return language === "zh" ? COMPUTER_USE_MASK_LABEL_ZH : COMPUTER_USE_MASK_LABEL_EN;
}

/**
 * 给模型的那**一句话**：检查了几个帧、盖住几个字段；**没到的帧逐条点名**——模型据此才知道
 * 图里哪一块（可能是明文）不可信。老桥（mask === undefined）回空串。
 */
export function computerUseShotMaskNote(mask: ComputerUseShotMask | undefined): string {
  if (mask === undefined) return "";
  const frames = `${mask.framesChecked} frame${mask.framesChecked === 1 ? "" : "s"}`;
  const fields = `${mask.fieldsCovered} password field${mask.fieldsCovered === 1 ? "" : "s"}`;
  // 一帧都没检查（预算闸 / 枚举失败）时**不许**说「没有密码字段」：那是「检查过且干净」的意思，
  // 而事实是这张图根本没被检查过。两句话说的不是一件事，模型据此决定要不要信这张图。
  const base =
    mask.framesChecked === 0
      ? " Before the capture it skipped the password-field check; this image has not been checked for password fields."
      : mask.fieldsCovered === 0 && mask.missing.length === 0
        ? ` Before the capture it checked ${frames} and found no password field to cover.`
        : mask.fieldsCovered === 0
          ? ` Before the capture it checked ${frames} and covered no password field.`
          : ` Before the capture it checked ${frames} and covered ${fields} with an opaque overlay.`;
  const hidden = mask.missingTotal - mask.missing.length;
  const missing =
    mask.missing.length === 0
      ? ""
      : ` Frames it could not reach (everything visible inside them is visible in this image): ${mask.missing.join(
          "; ",
        )}${hidden > 0 ? `; and ${hidden} more not listed` : ""}.`;
  const error = mask.error === undefined ? "" : ` The bridge said: ${mask.error}`;
  return base + missing + error;
}

/**
 * 沙箱是否允许出网的**缺省值**（= 允许）。**全栈唯一来源**：
 * `shared/settings.ts` 的 `effectiveAllowNetwork`（读设置时的兜底）、主进程控制器
 * （没注入 getter / 读失败 / 读超时）、`renderWsbXml`（不传 allowNetwork）与渲染层
 * （开关的当前值）都从它取值；改默认只改这里。测试也断言「缺省 === 这个常量」而不是字面 true。
 *
 * v1 的 computer use 就是「沙箱里的网页自动化」，断网等于没有这个功能，所以默认开；
 * 开关是给只想让 agent 操作本地桌面 / 文件的人收紧攻击面的：关掉后宿主渲染的 .wsb
 * 写 `<Networking>Disable</Networking>`（官方只定义 Disable / Default 两个值）。
 */
export const COMPUTER_USE_DEFAULT_ALLOW_NETWORK = true;

// ── 应用级准入（guest 桥内判定）────────────────────────────────────────

/**
 * 一次输入动作**打在谁身上**的判定结果。判定只能在 guest 里做：Windows Sandbox 是完整 VM，
 * guest 的进程在宿主任务管理器里看不到、PID 不可跨边界映射。所以桥拿目标 hwnd →
 * `GetWindowThreadProcessId` 得到 guest 内 PID → 对照「自己启动的进程树」与 exe 白名单。
 *
 * - `owned`：在我们自己起的进程树里（桥的 worker → 该会话的 Edge）。
 * - `allowlisted`：不在树里，但 exe 在白名单里（缺省只有 msedge.exe——Edge 的网络进程 /
 *   launcher 可能被重新拉成树的旁支，靠树判会误报）。
 * - `bypassed`：两者都不是。**本轮观察模式：不拒**，只在回执与 bridge.log 里标记。
 *   先量清楚模型实际会点哪些 exe，再决定要不要拒——「沙箱内任意应用都算安全」是合理的产品
 *   假设，因为 VM 是一次性的。
 * - `unknown`：拿不到目标窗口 / 进程（点在桌面上、窗口刚关）。不是拒绝，也不是放行。
 */
export const COMPUTER_USE_ADMISSION_VERDICTS = ["owned", "allowlisted", "bypassed", "unknown"] as const;
export type ComputerUseAdmissionVerdict = (typeof COMPUTER_USE_ADMISSION_VERDICTS)[number];

/** 桥下发给回执、宿主再抬到工具回执里的准入信息 */
export interface ComputerUseAdmission {
  admission: ComputerUseAdmissionVerdict;
  /** 目标窗口所属进程的 exe 名（notepad.exe）；`unknown` 时是空串 */
  targetExe: string;
  /** guest 内 PID（不跨边界，只在 guest 里有意义）；`unknown` 时缺省 */
  targetPid?: number;
}

/**
 * 准入白名单的**内置默认**：沙箱里可能被我们起的四个浏览器（Edge / Chrome / Brave / Chromium）。
 * **全栈唯一来源**：设置解析的兜底（`shared/settings.ts` 的 `effectiveGuestAllowExe`）、
 * 控制器下发给桥的字段、桥自己的兜底（guest-bridge/Admission.cs 的 `DefaultAllowExe`）
 * 都从这里对齐。**两处必须逐字一致**（含顺序）——桥改一处、宿主改另一处而没人发现，
 * 后果是用 Chrome 时每条输入都判 `bypassed`：功能能用，但日志变噪音、owned 判定失效。
 * guest-bridge/bridge.test.mjs 直接对比两份源码，漂了就红。
 *
 * 为什么这四个要显式放行：树判定靠父链，而 Chromium 系的 launcher / 网络进程有机率被重新
 * 拉起或重新挂父，父链断了就落到 `bypassed`——它不是逸出风险，是自家浏览器。
 * 四个都放而不管当前设置用的是哪个：这份表是**内置默认**、不随设置变（设置只能往上追加），
 * 否则换一次浏览器就得把准入逻辑也联动一遍。
 */
export const COMPUTER_USE_DEFAULT_ALLOWED_APPS = [
  "msedge.exe",
  "chrome.exe",
  "brave.exe",
  "chromium.exe",
] as const;

/**
 * exe 名的规范化：去空白、只取路径末段、小写、只认 `*.exe`。
 * 取末段是为了让手写的设置（`C:\\Program Files\\...\\notepad.exe`）也能用；
 * 坏值返 null（解析层丢掉，不落盘一个永远匹配不上的名字）。
 */
export function normalizeGuestAppName(value: string): string | null {
  const base = value.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const name = base.trim().toLowerCase();
  if (!/^[a-z0-9._-]+\.exe$/.test(name)) return null;
  return name;
}

/**
 * 真正下发给桥的白名单 = 内置默认 ∪ 用户设置（规范化、去重、保序）。
 * 用户加的是**追加**，不是替换：拿掉某个内置项得改默认常量，不该靠手删设置做到。
 */
export function mergeGuestAllowExe(userList: readonly string[] | undefined): string[] {
  const out: string[] = [...COMPUTER_USE_DEFAULT_ALLOWED_APPS];
  for (const entry of userList ?? []) {
    const name = normalizeGuestAppName(entry);
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 从桥的回执里读准入信息。字段不齐 / 值不认识返 null（老桥没有这些字段，回执行为不变）。
 * 只认 shared 里的四个 verdict——桥以后加新值，这里要先改，不能让它静默流进 UI。
 */
export function parseComputerUseAdmission(resp: Record<string, unknown>): ComputerUseAdmission | null {
  const verdict = resp["admission"];
  if (typeof verdict !== "string" || !(COMPUTER_USE_ADMISSION_VERDICTS as readonly string[]).includes(verdict)) {
    return null;
  }
  const targetExe = typeof resp["targetExe"] === "string" ? resp["targetExe"] : "";
  const pid = resp["targetPid"];
  const targetPid = typeof pid === "number" && Number.isFinite(pid) ? pid : undefined;
  return {
    admission: verdict as ComputerUseAdmissionVerdict,
    targetExe,
    ...(targetPid === undefined ? {} : { targetPid }),
  };
}

/**
 * 桥不应答时的放弃线（主进程等一条 guest 命令的上限）。
 *
 * **45 秒不是拍脑袋的宽容值**：2026-10-10 真机实测，win+r 弹出「运行」框之后，
 * 映射文件夹的目录枚举缓存会卡住，宿主刚写进的 req 在 guest 侧 8–20 秒才可见
 * （触发面只有这类壳对话框；escape / click 后立刻 type 只要 433ms）。桥那边已改成
 * 序号直探（guest-bridge/Program.cs 的 PollOnce），把黑窗压到 ~8s，但黑窗仍存在。
 * 15 秒会把一次**真的成功了**的注入判成失败，而模型看到失败会重试——同一个动作做两遍
 * 比多等 30 秒坑得多（真机第一轮就是这么把 type 判失败的）。
 * 超过 45 秒没响应仍然算失败：那时桥大概率真的死了。
 *
 * **浏览器命令（`cdp-*`）不用这条线**，它有自己的 `COMPUTER_USE_CDP_TIMEOUT_MS`：那边
 * guest 里还有一条 40 秒的 worker 杀线，错误文案再走回宿主又要一跳（真机满载实测 8–19s）。
 * 一条命令走哪条线由 `computerUseGuestTimeoutMs` 决定，别在调用点各写一份。
 *
 * 放在 shared（而不是定义它的 bridge-client）是因为 agent 侧的 computer-tools 也要读它：
 * broker 的兜底超时必须比这条线更长，否则主进程还在等、agent 先把真成功判成
 * 「主进程没有回执」（computer-tools.ts 的 BROKER_TIMEOUT_MS）。agent 进程不能
 * import 主进程模块，跨进程共享的常量只有这里能放。
 */
export const GUEST_COMMAND_TIMEOUT_MS = 45_000;

/**
 * 浏览器命令（`cdp-*`）的放弃线。**比像素那条长，不是宽容，是两条线要对得上**。
 *
 * 0.7.0 起 CDP 由该会话自己的 worker 子进程执行，主桥 **40 秒**没有回执就把它连 Edge
 * 一起 taskkill（guest-bridge/WorkerHost.cs 的 CommandTimeoutMs），并回一句带下一步的
 * 人话。但从那一刻起，**那句话还要走回宿主**：2026-10-25 真机满载实测（Edge 卡在
 * 不可路由地址时），宿主→guest / guest→宿主**每一跳都要 8–19 秒**。
 * 于是最坏情况下那句人话落在宿主时，距 host 写 req 已经过了：
 *     9s（req 可见）+ 40s（杀线）+ 10s（resp 可见）≈ **59s**。
 * 45 秒会在 40s 杀线之前就放弃——模型只看到一句笼统的「没有响应」，看不见
 * 「通道已重启」，也不知道下一步做什么（2026-10-25 真机就是这样把那句人话丢掉的）。
 *
 * 70 秒 = 40（杀线）+ 19（实测最坏一跳）+ 11 余量。
 * **下游兜底必须比它长**：agent 侧 sandbox_* 的 broker 85s、sandbox_navigate 155s
 * （见 sandbox-tools.ts）。改这一条时三条一起看。
 */
export const COMPUTER_USE_CDP_TIMEOUT_MS = 70_000;

/**
 * 一条 guest 命令的放弃线：`cdp-*` 走 CDP 线，其余（像素 / 桌面）走 45s。
 *
 * 纯函数、唯一一份规则：`bridge-client` 的默认值与 `SandboxController` 的四个下发口
 * 都从它取；调用点只负责「测试注入的覆盖值优先」。
 */
export function computerUseGuestTimeoutMs(command: string): number {
  return command.startsWith("cdp-") ? COMPUTER_USE_CDP_TIMEOUT_MS : GUEST_COMMAND_TIMEOUT_MS;
}

// ── 沙箱租约（按资源切分：桌面独占 + 每会话浏览器）────────────────────

/**
 * 沙箱里真正稀缺的东西**不是整台机器，而是那块桌面**：像素工具（截图 / 点击 / 打字 / 按键 /
 * 滚动）动的是唯一一块屏幕与唯一一个前台焦点，两个会话交错就是 A 的文字落进 B 的框。
 *
 * 浏览器通道（`sandbox_*`）从每会话一个 Edge 起就不再共享了：A 的 cdp-nav 只换 A 自己那个
 * 实例的页面，碰不到 B 的。所以它不该去排桌面的队——否则「网页任务并行」等于没做，
 * 一个会话在网页上的长轮次会把所有会话的浏览器操作串起来。
 *
 * 于是租约按**资源键**切分：
 *   desktop:exclusive  桌面独占（像素 / 前台 / 整屏截图），数值见 COMPUTER_USE_LEASE
 *   browser:<session>  每会话一把（自己的浏览器永远立即可用，不排队、不设 idle / 硬上限）
 * 每个键独立持有者、独立队列、独立计时；revoke 仍然一次清掉所有键（沙箱没了，谁都用不了）。
 *
 * **按窗口截图（screenshot + window，桥 0.9.0）不占任何租约**：PrintWindow 读窗口自己的
 * surface，被遮挡也能拍、不抢焦点（isWindowScreenshotRequest 上有实测数据）。把它塞进
 * desktop:exclusive 等于让「各拍各的窗口」重新排队，而那正是这一刀要解开的瓶颈。
 */
export const COMPUTER_USE_DESKTOP_KEY = "desktop:exclusive";

/** 每会话桌面键的前缀（只在「每个 agent 一个桌面」的档位下用） */
export const COMPUTER_USE_SESSION_DESKTOP_KEY_PREFIX = "desktop:session:";

/**
 * L2b（多会话隔离）的桌面键：**每个会话自己的桌面**。
 *
 * 为什么不是同一个键：L2 里所有会话共用一块屏幕（所以必须全局独占）；L2b 里每个会话是
 * 一个独立 OS 会话，A 的窗口 B 根本看不见，也不共享前台焦点——让它们排队是把并行能力
 * 白白锁死。反过来，同一会话的两条动作序列仍然要串（同一个桌面、同一个焦点），所以键里
 * 必须带会话 id。
 *
 * 前缀是 `desktop:session:`，**不是** `desktop:`——`desktop:exclusive` 是全局键，用短前缀
 * 就会被一个叫 exclusive 的会话 id 撞上（lease 只把键当不透明字符串排，撞了就是两个不同的
 * 桌面被串成一把锁）。空 id 退回全局键：空 id 只会在调用方 bug 时出现，那种时候宁可退成
 * 一个保守的共享锁。
 */
export function sessionDesktopKey(sessionId: string): string {
  const raw = sessionId.trim();
  if (raw === "") return COMPUTER_USE_DESKTOP_KEY;
  return COMPUTER_USE_SESSION_DESKTOP_KEY_PREFIX + raw;
}

/** 浏览器键的前缀（lease.ts 靠它选策略；两端字符串必须一致） */
export const COMPUTER_USE_BROWSER_KEY_PREFIX = "browser:";

/**
 * 会话 → 它的浏览器资源键。
 *
 * 用**原始会话 id**，不用 safeBrowserSessionId 归一化后的桥侧键：那个键会把非法字符换成 `_`
 * 并截到 48 字，两个不同的宿主会话（`a/b` 与 `a_b`）会撞成同一个键，于是两个会话又被串到
 * 一把租约上——正是这一层要拆开的东西。空 id 退回 default（与桥的缺省会话同义）。
 */
export function browserKey(sessionId: string): string {
  const raw = sessionId.trim() === "" ? COMPUTER_USE_DEFAULT_BROWSER_SESSION : sessionId;
  return COMPUTER_USE_BROWSER_KEY_PREFIX + raw;
}

/**
 * 桌面键的数值。
 *
 * 桌面是**一份**（一块屏幕、一个前台焦点），而 agent 会话可以是**多个**（主会话 + 它派出的
 * 子会话真并发）。命令在 guest 桥里串行，但两条独立动作序列会任意交错：A 点框 → B 点另一个框
 * → A `computer_type`，文字进了 B 的框；A 用自己截图的坐标去点、屏幕已被 B 换掉 → 点错元素。
 * 两边都收到「成功」——这是零归属的并发，不是资源竞争。所以桌面对外是一个**独占租约**：
 * 拿到才下发，拿不到就给模型一句人话。数值定在这里（而不是 lease.ts 里）是因为两侧都要读：
 * 租约自己判超时，工具描述要告诉模型「会被占用」且不要重试。
 */
export const COMPUTER_USE_LEASE = {
  /**
   * 等别人让出沙箱的上限。比一条 guest 命令的 GUEST_COMMAND_TIMEOUT_MS 短一点：
   * 对方向前是一个正常动作时，等它做完比当场失败更接近用户的意图（子会话一次截图 3 秒）；
   * 再长就不值了——模型的耐心有限，等不到就该让它停手。
   */
  waitMs: 30_000,
  /** 排队者的上限。**满了直接拒绝，不排队**：无限队列只会把「等不到」变成「排到天荒地老」 */
  queueLimit: 8,
  /**
   * 最后一次续期之后多久算「放手了」。持有者每下发一条命令就续期一次，所以这条线只在
   * **持有者静默**时才到点（模型在想、在等审批、会话被搁置）。60s 是「一轮里正常的停顿」
   * 与「这个会话其实不会再用」之间的折中。
   */
  idleMs: 60_000,
  /**
   * 单次持有的硬上限。**不看续期**：一个会话若不停地截图（每张都在续期），光靠 idle 线
   * 永远放不掉，别的会话会饿死。15 分钟到点强制收回，持有者下一条命令拿到终态错误。
   */
  holdMaxMs: 15 * 60_000,
} as const;

/**
 * 浏览器键的数值：**不排队、不限时**。
 *
 * 键里带着会话 id，持有者只可能是它自己——所以 acquire 永远立刻成功（同会话幂等的续期），
 * 既没有 30 秒等待，也没有「占得太久」的硬上限（一个跑长网页任务的会话没有占着任何别人的
 * 东西）。idle 也不设：浏览器自己是否回收由桥的 COMPUTER_USE_BROWSER_IDLE_MS 管，租约只记
 * 归属，不替它决定生命周期。
 */
export const COMPUTER_USE_BROWSER_LEASE = {
  waitMs: 0,
  queueLimit: 0,
  idleMs: null,
  holdMaxMs: null,
} as const;

/**
 * 租约错误。文案是**给模型读的**：它看不见 UI，也不会自己想到「另一个会话占着」——
 * 不写清楚它会立刻重试，而重试正好是这里最不该做的事（对方还在用）。
 */
export const computerUseLeaseErrors = {
  /** 等不到（超时） */
  timeout: (holderTitle: string): string =>
    `沙箱桌面的操作权现在在另一个会话手里${holderSuffix(holderTitle)}，等了 ${COMPUTER_USE_LEASE.waitMs / 1000} 秒没等到。` +
    "不要重试：这一侧继续调 computer_* / sandbox_* 只会再等一轮。等对方那一轮结束后再试，或者请用户确认现在该由谁来操作沙箱。",
  /** 队列满 */
  queueFull: (holderTitle: string, queueLimit: number): string =>
    `沙箱桌面的操作权在另一个会话手里${holderSuffix(holderTitle)}，排队等它的会话已经排到上限（${queueLimit} 个）。` +
    "不要重试：请用户先让其它会话停下来，或者自己确认该由谁来操作沙箱。",
  /** 硬上限到点 */
  holdExpired: (holdMinutes: number): string =>
    `这个会话连续占用沙箱桌面已经超过 ${holdMinutes} 分钟，操作权被强制收回，这条命令没有下发。` +
    "不要重试：告诉用户沙箱刚才被收回，如果还要继续，让用户决定下一次由谁来操作。",
  /** 沙箱被停 / 进 error */
  revoked: (reason: string): string =>
    `沙箱已经关闭（${reason}），操作权全部作废，这条命令没有下发。` +
    "不要重试：先在「设置 › 实验功能 › 电脑使用」里重新启动沙箱，再从头开始。",
  /**
   * 不排队的资源被另一个会话持有。浏览器键按会话切分，正常走不到这里；这条只兜
   * 「调用方给错了键」的编程错误——仍然给一句模型能转告用户的话，而不是抛异常。
   */
  busy: (holderTitle: string): string =>
    `这个通道现在归另一个会话${holderSuffix(holderTitle)}，本操作不排队，这条命令没有下发。` +
    "不要重试：等对方那一轮结束后再试。",
} as const;

/** 文案里带占用者名字的尾巴（没有标题的会话——刚建、还没起名的——只报 id 少了信息量，就退成一句不带名字的话） */
function holderSuffix(title: string): string {
  const trimmed = title.trim();
  return trimmed === "" ? "" : `（「${trimmed}」）`;
}

/**
 * 取租约的结果。**ok:false 时 error 已经是可以直接交给模型的话**（同上文的理由），
 * 调用方不必再拼一遍。
 */
export type ComputerUseLeaseResult = { ok: true } | { ok: false; error: string };

// ── 租约审计（归属、等待与持有时长，决定后续路线用真实数据）──────────────

/**
 * 一条租约账：**每次** acquired / released / rejected 记一条（内存、进程生命周期内）。
 *
 * 为什么记 `waitedMs` 与 `heldMs` 两个时长而不是只记事件：v1.5-2 要回答的是
 * 「桌面到底挤不挤」——排了多久、占了多久，决定后面是继续拆资源、还是把像素工具也搬到
 * 每会话实例里。只有事件计数回答不了这个问题。
 */
export interface ComputerUseLeaseAuditRecord {
  kind: "acquired" | "released" | "rejected";
  /** 资源键（desktop:exclusive 或 browser:<session>） */
  key: string;
  sessionId: string;
  /** 从调用 acquire 到真正拿到手的毫秒数（立刻拿到为 0；released / rejected 带当初的等待） */
  waitedMs: number;
  /** 持有到放手的毫秒数（acquired / rejected 为 0） */
  heldMs: number;
  /** 记账时刻的队列深度（不含持有者） */
  queueDepth: number;
  /** 记账时刻（epoch ms） */
  at: number;
}

/** 按 key 聚合的租约统计（stats() 的返回项） */
export interface ComputerUseLeaseKeyStats {
  key: string;
  /** 成功拿到手的次数 */
  acquired: number;
  /** 放手的次数（主动 / idle / 硬上限 / revoke） */
  released: number;
  /** 被拒的次数（超时 / 队列满 / 不排队的资源被占） */
  rejected: number;
  /** 平均等待（只算真正拿到手的那些） */
  averageWaitMs: number;
  /** 平均持有（只算已放手的那些） */
  averageHeldMs: number;
  /** 此刻的队列深度（不含持有者） */
  queueDepth: number;
  /** 此刻的持有者会话 id（没有就是 null） */
  owner: string | null;
}

// ── 急停 ──────────────────────────────────────────────────────────────

/**
 * 急停热键的当前状态。`registered=false` 时 error 必须是一句用户能行动的话
 * （「快捷键被占用」），不能只在控制台留一行。
 */
export interface EmergencyStopStatus {
  /** 键位字符串（设置页展示） */
  accelerator: string;
  registered: boolean;
  error: string | null;
}

/**
 * 主进程 → renderer 的急停广播：按下了热键、这一轮已中断、这些会话的授权已撤销。
 * 走 `agentEvent` 同一条广播（AgentEvent 的 `computerUseEmergencyStop`），
 * 界面据此把授权标识复位并给一条「已急停」提示。**不关沙箱**——保留现场。
 */
export interface EmergencyStopBroadcast {
  at: number;
  /** 被中断并撤销授权的会话 id（当时正在跑的）；空数组 = 没有会话在跑 */
  sessionIds: string[];
}

// ── 沙箱状态机 ────────────────────────────────────────────────────────

export type SandboxState = "off" | "starting" | "running" | "stopping" | "error";

/**
 * 沙箱状态机的一帧。迁移：
 *   off → start() → starting → guest 桥 bridge.json 就绪 → running
 *                            ↘ 超时没等到通告 / spawn 失败 → error
 *   running → stop() / 用户关掉沙箱窗口 → (stopping) → off
 *   error → stop() 回 off，或直接 start() 重试。
 * 应用每次启动都从 off 开始（沙箱不跨应用存活），renderer 冷启动可直接按 off 画。
 */
export type SandboxStatus =
  | { state: "off" }
  | { state: "starting"; startedAt: number; backend?: ComputerUseBackend }
  | {
      state: "running";
      startedAt: number;
      bridgeVersion: string;
      /**
       * 这一局用的是哪个后端。**可选**：老记录 / 还没起过时没有。设置页用它区分
       * 「L2 沙箱」与「L2b 多会话隔离」，也用它决定桌面租约的粒度。
       */
      backend?: ComputerUseBackend;
      /** L2b：OS 为这个会话现造的 agent 账号（日志与设置页展示用，不是凭据） */
      agentUserName?: string;
    }
  | { state: "stopping" }
  | { state: "error"; message: string; backend?: ComputerUseBackend };

// ── 能力探测（全部只读；绝不自动执行提权命令）────────────────────────────

/**
 * Windows 版本档位（reg query 的 EditionID 归一化）。沙箱只有 Pro / Enterprise / Education 有
 * （官方明确 Home 不支持）；未知归 unknown，按不支持处理并如实告诉用户。
 */
export type WindowsEdition = "pro" | "enterprise" | "education" | "home" | "unknown";

/** 「Windows 沙箱」可选功能的状态——由 WindowsSandbox.exe 存在性推导（非提权进程查不了 DISM，错误 740）；unknown 留作契约兼容，当前实现不产出 */
export type SandboxFeatureState = "enabled" | "disabled" | "unknown";

/**
 * 虚拟化（Hyper-V 所需的 VT-x / AMD-V）在不在。
 *
 * 为什么要单独探这一项：BIOS/UEFI 里虚拟化被关的机器上，功能启用、exe 也在，但
 * WindowsSandbox.exe 一跑就退——只读探测报 ready、start 才失败，而失败现场（沙箱窗口
 * 一闪而过 / 一条没头没尾的退出码）对用户没有信息量。读 Win32_ComputerSystem 的
 * HypervisorPresent 是**非提权、瞬时**的信号（禁 wmic：24H2+ 已可选移除）。
 *   present  = 虚拟化在（含已在跑 Hyper-V）
 *   absent   = 被 BIOS/UEFI 关了，沙箱起不来
 *   unknown  = 查不成（PowerShell 不在 / 超时 / 输出不认识）——**不阻塞**：unknown 只是
 *             少一条信号，不能让探测把能用的机器判死。
 */
export type HypervisorState = "present" | "absent" | "unknown";

/**
 * 隔离档位。产品路线三级，今天只有前两级能到（L3 未实现，所以类型里没有 l3——
 * 加一档时先有能跑的代码，再加这个成员）。
 *
 *   l1  浏览器档：内置浏览器里的网页自动化（browser_* 工具）。**所有平台都有**——它就是
 *       Electron 自己的 WebContentsView，跑在宿主上，不依赖任何虚拟化。
 *   l2  Windows 沙箱档：沙箱里的像素操作（computer_*）与沙箱内 Edge（sandbox_*）。
 *       需要 Windows 专业版 / 企业版 / 教育版 + 已启用 Windows 沙箱 + 虚拟化开着。
 *
 *   l2b 多会话隔离档（Windows，MXC IsolationSession）：每个 agent 一个独立 OS 会话，
 *       宿主 EnumWindows 看不见它的窗口、别的会话也看不见。与 l2 的差别是**没有真实
 *       输入设备**（会话是 RDP 形态，SendInput 返回成功却毫无效果），所以像素点击/打字
 *       在 l2b 里一律被拒，动作走 UIA / CDP / 会话内 PostMessage 三条合成车道。
 *       出网也不能关（MXC 的 provision 只接受全 allow 的网络姿态）。
 *
 * 注意 l1 的实现是 browser_*，不是 sandbox_*：sandbox_* 的每条命令都走 guest 桥，而 guest
 * 桥只住在 Windows 沙箱里（main/computer-use/cdp.ts、guest-bridge/）。macOS 上没有「宿主
 * 浏览器版的 sandbox_*」——所以非 Windows 的文案只能承诺内置浏览器那条车道。
 */
export type IsolationTier = "l1" | "l2" | "l2b";

/**
 * 主进程该用哪个控制器起「隔离桌面」。
 *   wsb                   L2：Windows Sandbox（一份 VM、一个桌面，多 agent 共享）
 *   isolation-session     L2b：MXC IsolationSession（每个 agent 一个 OS 会话）
 *   qemu                  L3：QEMU + WHPX 起一台真 Linux 桌面 VM（XFCE + Xvnc），
 *                         宿主经 HTTP over hostfwd 让 agent 截屏与注入输入。
 *                         **没有 UIA 控件树、没有按窗口截图、没接 CDP**——它自己会明说
 *                         （见 main/computer-use/qemu.ts 的 QEMU_REFUSALS 与 capabilities）。
 *
 * 两端字符串必须一致（settings.json 里存的就是这些字面值）。默认 wsb——P2/P3 都是
 * **可选后端**，不是默认路径：它们的输入设备与能力边界都不同。
 */
export type ComputerUseBackend = "wsb" | "isolation-session" | "qemu";

export const COMPUTER_USE_DEFAULT_BACKEND: ComputerUseBackend = "wsb";

/**
 * 开发者后端的开关（**默认关**）。只有它开了，`qemu` 才会出现在设置页的可选列表里、
 * 主进程的 start 才会放行。
 *
 * 为什么要有这道门：L3 的 QEMU 后端是原型——`qemu-system-x86_64.exe`、`desktop.qcow2`、
 * `vmlinuz-virt`、`initramfs-orbita.cpio.gz` 四样都在仓外（要自己跑 `scripts/p3-desktop/` 的
 * 构建脚本），能力也只有截图 / 点击 / 打字（`uia` / `cdp` / `sandboxFiles` 全为 false，
 * `snapshot` 为 none）。普通用户点到一个必然起不来的选项，只会以为功能坏了。
 *
 * 值：`1` / `true` / `yes` / `on`（不区分大小写）都算开，其余（缺席、空串、其它字）都算关——
 * **缺席必须等于关**，这是这条门默认安全的前提。
 */
export const COMPUTER_USE_DEV_BACKENDS_ENV = "ORBITA_CU_DEV_BACKENDS";

/** 环境变量 → 开发者后端的开关（纯函数，主进程与单测共用；默认关） */
export function devBackendsEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[COMPUTER_USE_DEV_BACKENDS_ENV];
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * 设置页要列的一档后端。`experimental` 是给人看的标记（UI 用文字 / 图标，不靠颜色）；
 * 它由这里声明，而不是让 renderer 按 id 猜——与 provider 的能力声明同一条纪律。
 */
export interface ComputerUseBackendChoice {
  id: ComputerUseBackend;
  experimental: boolean;
}

/**
 * 可选后端列表（**唯一真源**，主进程经 `computer-use:backends` 发给设置页）。
 *
 * 开关关时只有两档（wsb / isolation-session），qemu 连出现都不出现；开关开时才把
 * 开发者后端放进来并标成实验。renderer 不再硬编码这三档——列表从主进程拿，
 * 免得「UI 能选、主进程不认」这种两处各说各话。
 */
export function computerUseBackendChoices(devEnabled: boolean): readonly ComputerUseBackendChoice[] {
  const base: readonly ComputerUseBackendChoice[] = [
    { id: "wsb", experimental: false },
    { id: "isolation-session", experimental: false },
  ];
  return devEnabled ? [...base, { id: "qemu", experimental: true }] : base;
}

/**
 * 开发者后端被拒时给**人**看的一句话（主进程 start 的返回值）。
 *
 * 三个要素必须同时在：① 这是什么（开发者后端、默认不开放）；② 为什么起不来
 * （镜像与 QEMU 二进制自备、能力只有截图/点击/打字）；③ 怎么才能用（环境变量）。
 * 它不是错误码——设置页会原样显示这句话，用户照着做就能继续。
 */
export function computerUseDevBackendRefusal(): string {
  return (
    "这是开发者后端（Linux 桌面 VM / L3），默认不开放：它要求自备 QEMU 与 Linux 桌面镜像" +
    "（在仓库里跑 scripts/p3-desktop/build-image.mjs 与 scripts/p3-desktop/build-ramdisk.mjs），" +
    "而且只有截图、点击与打字——没有 UIA 控件树、没有浏览器调试口、没有宿主文件映射、没有快照。" +
    `要启用它，请以环境变量 ${COMPUTER_USE_DEV_BACKENDS_ENV}=1 启动本应用，再回来启动。`
  );
}

export function isComputerUseBackend(value: unknown): value is ComputerUseBackend {
  return value === "wsb" || value === "isolation-session" || value === "qemu";
}

/**
 * 正在跑的那只隔离**在启动那一刻**定下来的两个事实。
 *
 * 为什么一定要记当时的、不能用当前的设置算：设置页的「隔离后端」与「允许沙箱出网」都是
 * **下次启动才生效**（backendPatch 明写不自动重启）。于是运行中改设置，模型那边就会拿到
 * 一组与真实沙箱无关的值——「设置选 wsb、实际跑着断不了网的 L2b」时被告知「你没有出网」，
 * 或者「运行中把开关关掉」时被告知「网页打不开」而沙箱其实还连着。这两句都是这次要修的那种谎，
 * 只是换了个触发路径。
 */
export interface ComputerUseRunningFacts {
  /** 真正在跑的那个后端（不是设置里选的那个） */
  backend: ComputerUseBackend;
  /**
   * 启动时读到的「允许沙箱出网」。L2b 也记：它不改变网络，但这个值仍是用户的意图，
   * 提示词靠它说「你要求断网，但这个后端断不了」。
   */
  allowNetwork: boolean;
}

/**
 * 「设置里的『允许沙箱出网』关掉」这件事，在某个后端上到底能不能兑现。
 *
 *   enforced          关掉就是真的没有出网，模型该知道「网页打不开是设置造成的」；
 *   not-enforceable   这个后端做不到断网，关掉开关也不改变什么——**不能**告诉模型它没网。
 *
 * 为什么必须收成一个谓词：同一个开关连着三个后端，其中只有一个能做得到。以前设置页与
 * 提示词都默认「关掉 = 没网」，于是 L2b 上模型被明确告知「你没有出网」，而它其实就在
 * 用户这台机器的网络上——查一次资料就成了一次说谎，用户也以为自己的隐私设置生效了。
 *
 * 三个后端的机制（改动任一处都要回来改这里）：
 *   wsb              宿主渲染的 .wsb 带 `<Networking>Disable</Networking>`
 *                    （main/computer-use/sandbox.ts 的 renderWsbXml）。
 *   qemu             桌面 VM 的 `-netdev user` 加 `restrict=on`：guest 出不了外网。
 *                    **restrict 不作用于显式的 hostfwd**，所以桌面 HTTP / RFB 两条
 *                    回环转发照通（main/computer-use/qemu-vm.ts 的 qemuNetdevSpec）。
 *   isolation-session 做不到。它跑在用户自己这台 Windows 的**另一个登录会话**里，
 *                    网就是这台机器的网；MXC 自己的文档写着 *IsolationSession cannot
 *                    restrict networking*。按账号 SID 限定的防火墙规则
 *                    （INetFwRule3::LocalUserAuthorizedList）是 app container 专用的，
 *                    不能用来「拦某个账号的出网」；真要做得自己写 WFP 过滤器，那是一周的
 *                    工程，这一轮不做，也不能假装已经做了。
 */
export type ComputerUseNetworkControl = "enforced" | "not-enforceable";

export function backendNetworkControl(backend: ComputerUseBackend): ComputerUseNetworkControl {
  // 只有明确做得到的两个返回 enforced，其余（含将来新增、还没在 这个谓词里表态的后端）
  // 一律 not-enforceable：默认「能断网」正是这次要修的那个谎，所以缺席时按做不到算。
  return backend === "wsb" || backend === "qemu" ? "enforced" : "not-enforceable";
}

/**
 * L2b 的依赖检查（设置页那一行：「可用 / 不可用 + 为什么」）。
 *
 * `available` 为 false 时 `reason` **必须有话**：只说一句「不可用」而不说是缺 Node、缺服务、
 * 还是非 Windows，用户没任何办法处置。
 */
export interface IsolationSessionCapability {
  available: boolean;
  /** 不可用的原因（人话）；可用时为 null */
  reason: string | null;
  /** 运行时 Node 版本（MXC 的 native stdio 要 ≥24.21 <25 或 ≥26.8；Electron 43 带的是 24.21.0） */
  nodeVersion: string;
  /** Node 版本够不够（单独一项：它是最常见的「SDK 装了但跑不了」） */
  nodeOk: boolean;
}

/**
 * WSL2 能不能用。**它不是隔离档**：WSL2 的所有发行版共享同一个 utility VM，里面的进程
 * 与 Windows 之间只是轻量边界，不是「一次性整机」那种隔离。它在这里只作能力信号
 * （虚拟化能不能用、为什么 L2 起不来），不参与档位判定。
 *   available   = System32 里有 wsl.exe，且 `wsl -l -v` 正常退出
 *   unavailable = System32 里没有 wsl.exe
 *   unknown     = wsl.exe 在但 `wsl -l -v` 没跑成（功能没启用 / 超时）——**不判死**，
 *                 与 hypervisorState 的 unknown 同一种态度
 */
export type WslState = "available" | "unavailable" | "unknown";

/** computerUseProbe 的结果。guidance 是给用户看的手动操作指引（弹窗文案），ready 时为 null */
export interface ComputerUseProbeResult {
  /** 是不是 Windows（非 Windows 平台一切免谈） */
  platformOk: boolean;
  edition: WindowsEdition;
  /** 版本档位支持沙箱（pro / enterprise / education） */
  editionOk: boolean;
  featureState: SandboxFeatureState;
  /** WindowsSandbox.exe 存在（System32 下） */
  sandboxExeFound: boolean;
  /** 虚拟化在不在（BIOS 关 VT-x 的机器会栽在这里）。unknown = 查不成，不阻塞 */
  hypervisorState: HypervisorState;
  /**
   * 这台机器实际能到的最高隔离档位：
   *   沙箱就绪 → l2；沙箱不就绪但 MXC IsolationSession 可用 → l2b；否则 l1（浏览器档任何平台都有）。
   * **l2b 不是 l2 的超集**：它的 UI 隔离更强（每个 agent 一个 OS 会话，宿主 EnumWindows 看不见、
   * 互相也看不见），但代价写在 `isolationSession` 与 `computerUseIsolationErrors` 里——
   * 出网**不能关**（MXC 的 provision 只接受「三个方向全 allow」）、**没有真实指针/键盘**
   * （SendInput 静默失效），像素点击/打字一律被拒。
   */
  isolationTier: IsolationTier;
  /**
   * MXC IsolationSession 的依赖检查（多会话隔离档）。**不可用时必须有 reason**：
   * 设置页不能只把开关画灰——用户要看得出「缺什么」。
   */
  isolationSession: IsolationSessionCapability;
  /** WSL2 的状态。**只是能力信号，不是隔离边界**，不参与档位判定 */
  wsl2: WslState;
  /** 四项全过（hypervisorState 为 unknown 也算过）。false 时看 guidance */
  ready: boolean;
  /** 不能就绪时的手动操作指引（含「启用或关闭 Windows 功能」路径与提权命令文本——只给文案，绝不代跑） */
  guidance: string | null;
}

// ── 四个 IPC 入口的载荷 ───────────────────────────────────────────────

export type ComputerUseStartResult = { ok: true } | { ok: false; error: string };

export type ComputerUseStopResult = { ok: true } | { ok: false; error: string };

/**
 * 一张截图的「遮罩 + 谁在场」信息（桥 0.12.0）。两类截图共用一份：整桌面与按窗口。
 *
 * 为什么要把它单独成一档（而不只写进正文）：审计（`details.computerUse`）要能事后回答
 * 「这张进过模型上下文的图，当时遮没遮密码框、人是不是正在里面打字」。存成结构化的几个数/布尔
 * 比从正文里正则抽可靠。
 */
export interface ComputerUseCaptureInfo {
  /** 这张图里被涂黑的密码框数（0 = 没有密码框需要遮，或没遮） */
  maskedRegions: number;
  /** 有没有「可用的」控件清单：false = 从没 uia-list 过（不知道密码框在哪），这张图没遮 */
  maskListed: boolean;
  /** 有清单但全部过期（> COMPUTER_USE_MASK_CACHE_MAX_AGE_MS）：这张图**没遮** */
  maskStale: boolean;
  /** 最近一份控件清单的年龄（毫秒；-1 = 没有任何清单） */
  maskCacheAgeMs: number;
  /** 拍这张图的那一刻用户是不是正在输入（桥的 input-status：lastRealAgeMs < 400ms） */
  userTyping: boolean;
}

/**
 * computerUseScreenshot 的回执：guest 桥按 maxWidth 缩放后的 JPEG + 两套尺寸。
 * width/Height 是**回图**的像素（模型看到的那张图），nativeWidth/Height 是**沙箱物理屏**
 * 的像素——模型给的坐标是前者，注入 SendInput 要的是后者，两者靠这一对尺寸换算
 * （screenshotPointToNative）。takenAt 是宿主收到图的时刻（毫秒），renderer 可拿来判图的新旧。
 */
export type ComputerUseScreenshotResult =
  | {
      ok: true;
      jpegBase64: string;
      /**
       * 图的 MIME 类型。**缺省 = image/jpeg**（Windows 沙箱与 L2b 的桥都出 JPEG）。
       * L3（Linux 桌面 VM）出的是 PNG：guest 里没有便宜的 JPEG 编码器（netpbm 装完要 6.9MiB，
       * 镜像预算只剩 8MiB），而 scrot 直接写 PNG。回执必须说出真话——工具层给模型的
       * mimeType 与设置页的 data URL 都取它，否则浏览器会拿 JPEG 的标签去解 PNG。
       */
      mime?: string;
      /** 回图尺寸（模型看到的像素） */
      width: number;
      height: number;
      /** 沙箱物理屏尺寸 */
      nativeWidth: number;
      nativeHeight: number;
      takenAt: number;
      /**
       * 密码框遮罩与用户在场（桥 0.12.0）。缺省 = 老桥（< 0.12.0）没这条信息：
       * 那时宿主不能断言「遮了」也不能断言「没遮」，所以不写进审计也不往正文添话。
       */
      capture?: ComputerUseCaptureInfo;
    }
  | { ok: false; error: string };

// ── 按窗口截图（win-list / win-shot，桥 0.9.0）────────────────────────────

/** win-list 的一项（字段名与 guest 的 WindowInfo 一一对应）。坐标是**屏幕**物理像素 */
export interface ComputerUseWindowInfo {
  /** 窗口句柄（传给 win-shot 的 hwnd）。原生指针在 64 位进程里可能超过 32 位，一律按 number 存 */
  hwnd: number;
  title: string;
  /** 进程名（受保护进程读不到时为空串，但窗口照样能拍） */
  process: string;
  className: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
  visible: boolean;
}

/**
 * 按窗口截图的回执。几何语义与整桌面截图**刻意同形**（width/height = 回图像素，
 * nativeWidth/Height = 窗口物理像素），但坐标**不能**混用：这里的 native 是窗口自己的
 * 坐标系，computer_click 要的是整屏的物理像素。所以工具层不会拿它更新「最近一次截图」的
 * 几何（详见 computer-tools.ts 的 window 分支）。
 */
export type ComputerUseWindowShotResult =
  | {
      ok: true;
      jpegBase64: string;
      /** 同 ComputerUseScreenshotResult.mime（缺省 = image/jpeg） */
      mime?: string;
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
      hwnd: number;
      title: string;
      /** 目标最小化过、已被 ShowWindow(SW_SHOWNOACTIVATE) 恢复（不抢焦点） */
      restoredFromMinimized: boolean;
      takenAt: number;
      /** 同 ComputerUseScreenshotResult.capture（桥 0.12.0；缺省 = 老桥） */
      capture?: ComputerUseCaptureInfo;
    }
  | { ok: false; error: string };

/** win-list 的回执（失败时 error 已经是给模型读的人话） */
export type ComputerUseWindowListResult =
  | { ok: true; windows: ComputerUseWindowInfo[] }
  | { ok: false; error: string };

// ── UI Automation 车道（uia-list / uia-act，桥 0.10.0）──────────────────────
//
// 为什么需要它：像素输入（click / type / key / scroll）走 SendInput，那是**全局输入**——
// 抢焦点、打到当前前台窗口，多个会话只能靠 desktop:exclusive 串行。UIA 换了一条入口：
// 针对某个窗口/控件直接调它的模式（InvokePattern / ValuePattern / SelectionItemPattern），
// 不需要那个窗口在前台。于是「在后台窗口里点一个按钮」不再需要独占整块桌面。
//
// 三个必须处理的坑（实现都在 guest-bridge/Uia.cs）：
//   ① IUIAutomation 默认 AutoSetFocus = true：一调用模式就把目标窗口带到前台。宿主侧
//      无法代关，所以桥在 COM 层把 IUIAutomation2 的 AutoSetFocus 置 false 并**读回确认**；
//      关不掉时（极老的系统 / QI 失败）回执里的 autoSetFocus 为 true，宿主会把「可能抢焦点」
//      写进给模型的正文。
//   ② UIA 调用会阻塞在跨进程消息上（目标进程忙就卡住），而这是 CPU 级阻塞，没有超时 API
//      能打断。桥把每次 UIA 调用放进一条独立的 STA 线程，等 COMPUTER_USE_UIA_TIMEOUT_MS
//      就放弃那条线程（后台线程，不拖住桥也不拖住命令循环），下一次命令起一条新的。
//   ③ 不支持模式的控件只能退回像素输入。失败文案必须点名它支持哪些模式，并告诉模型
//      「改用 computer_click / computer_type 的像素路径」——它看不见 UI，不会自己想到。
//   ④ **focus 不是本车道的动作**（桥 0.11.0 删除）：Element.SetFocus 移动的是整块桌面
//      共享的键盘焦点，是这条车道唯一的桌面级副作用——一旦允许，车道「不占桌面」的前提
//      就不成立了（并发会话的 SendInput 会打进来）。要移动焦点用 computer_click 点到目标，
//      或直接用 invoke（通常同时给焦点）/ setValue（不需要焦点）。别把它加回来。

/**
 * UIA 动作。**这是动作而不是像素坐标**：invoke = InvokePattern（按钮/链接/菜单项），
 * setValue = ValuePattern（输入框/文档），selection = SelectionItemPattern（列表/标签项）。
 *
 * **没有 focus**：Element.SetFocus 动的是桌面级全局资源，与车道「不碰桌面」的不变量冲突
 * （替代路径见上面 ④，拒绝文案见 computerUseUiaErrors）。
 *
 * 「点击」不在这里：UIA 的 InvokePattern 是「执行这个控件的默认动作」，比在坐标上按下
 * 更稳（不依赖控件位置、不被遮挡影响）。需要真的按坐标就仍用 computer_click。
 */
export type ComputerUseUiaAction = "invoke" | "setValue" | "selection";

/**
 * uia-list 的一项：一个**可动作**的控件。字段名与 guest 的 UiaItemInfo 序列化结果一一对应。
 * 坐标是**屏幕物理像素**（窗口被移动到哪都行，模型不需要它；它给的是可读定位信息）。
 */
export interface ComputerUseUiaItem {
  /**
   * **带代次的引用**，形如 `g12:r3`（桥 0.14.0）= 该窗口第 12 次清单里的第 3 个控件。
   *
   * 为什么不再是纯序号：序号只说「这次的第几个」。窗口一变（页面跳转、弹了个对话框、
   * 列表滚了），同一个序号就指向**另一个控件**，而模型看不出来——它会静默点到别的东西上。
   * 代次把「哪一次的清单」焊进这个值里，`uia-act` 拿它跟该窗口**最近一次** list 比，
   * 对不上就明确拒绝。所以：照抄，不要自己拼。
   */
  ref: string;
  /**
   * 稳定 id（桥 0.14.0）：UIA RuntimeId 优先，取不到时是属性哈希（`h:` 前缀）。
   * 同一个控件在同一棵树里两次 list 必须一样——`since` 的 diff 就是按它比对的。
   * 模型一般用不到它；它出现在 `removed`（消失的控件只有这个身份）里。
   */
  stableId: string;
  /** 控件的可读名字（UIA Name；空串只在有 automationId 时出现） */
  name: string;
  /** 控件类型的小写名（button / edit / list-item / tab-item / menu-item…） */
  controlType: string;
  /** 开发者给控件的 id（浏览器里常空，Win32 应用里常是控件 id） */
  automationId: string;
  /** 窗口类名（诊断用） */
  className: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 这个控件实际支持的动作（只列本车道能执行的三条：invoke / value / selectionItem）。
   * 空数组 = 这条车道没有能动它的模式（也不代表能 focus——focus 已不是动作）。
   */
  patterns: string[];
  enabled: boolean;
  /** 控件不在可见区域（滚动到它 / 切到那个标签页之后才可动作） */
  offscreen: boolean;
  /**
   * 密码框（UIA_IsPasswordPropertyId）。**两项用途**：
   *   ① 告诉模型「这一条是密码框」——别把秘密 setValue 进去，也别去读它；
   *   ② 截图遮罩的数据源就是这个字段的矩形（guest 桥 Mask.cs）。
   */
  isPassword: boolean;
  /**
   * 只在 `since` 的 diff 回执里有（桥 0.14.0）：`added` = 这一代新出现的控件，
   * `changed` = 还在、但某些字段变了。全量回执里没有这个字段。
   */
  change?: "added" | "changed";
  /** `change: "changed"` 时，具体变了哪些字段（name / patterns / enabled / offscreen / rect / …） */
  changed?: string[];
}

/**
 * diff 回执里「消失的控件」（桥 0.14.0）：上一代有、这一代没有。
 * **不带 ref**——它已经没有当前清单里的位置了；模型认得它靠 `stableId` 与名字。
 * 这是重要信号：模型上一轮 invoke 过的东西不见了（弹框关掉、列表项被删）。
 */
export interface ComputerUseUiaRemovedItem {
  stableId: string;
  name: string;
  controlType: string;
}

/** uia-list 回执里的窗口信息（从 UIA 根元素读，读不到时用 Win32 标题兜底） */
export interface ComputerUseUiaWindowInfo {
  title: string;
  className: string;
}

/**
 * uia-list 的**回执载荷**（成功那一支）。宿主侧控制器把它包成带 ok 的联合类型
 * （ComputerUseUiaListResult），与按窗口截图同形。
 */
export interface ComputerUseUiaListReply {
  hwnd: number;
  window: ComputerUseUiaWindowInfo;
  /**
   * 这一次清单是该窗口的第几代（桥 0.14.0）。**下一次带 `since` 就传它**；
   * 每条 item 的 ref token 里的 g 也是这个数。
   */
  generation: number;
  /** `full` = 全量；`diff` = 只回了 since 之后的变化 */
  mode: "full" | "diff";
  /** mode === "diff" 时回显用的基准代次（请求里的 since） */
  since?: number;
  /**
   * 全量时是全部可动作控件；diff 时只有 `change` 非空的那几条（新增 + 改了）。
   * 没变的控件不在里面——它们贡献 `unchanged` 计数。
   */
  items: ComputerUseUiaItem[];
  /** diff 时：上一代有、这一代没有的控件（带 stableId 与名字；不带 ref） */
  removed: ComputerUseUiaRemovedItem[];
  /** diff 时有多少控件完全没变（全量时是 0） */
  unchanged: number;
  /**
   * diff 时有多少控件**只是位置挪了**（名字/模式/状态都没变，全量时是 0）。
   * 不逐条列：Edge 的控件 rect 一直在微动（实测 21 条里 16 条），逐条列出来会让 diff
   * 比全量还大，而模型拿到 ref 就能动作，不需要知道它挪了几个像素（要按坐标点就看截图）。
   */
  rectMoved: number;
  /** 命中的控件超过 maxItems，后面的没回（模型可以调大 maxItems，或者按 name 直接动作） */
  truncated: boolean;
  /**
   * 本窗口里看到几个密码框（桥 0.12.0）。位置已被记进桥的遮罩缓存：接下来的截图会遮住它们。
   * 0 也可能是「这个窗口没有密码框」或「老桥不报这个字段」——两者对模型都没有区别。
   */
  passwordFields: number;
  /**
   * 树里有多少个输入框（`edit` 类型）。用来在「有输入框、但一个密码框都没认出来」时提醒
   * 模型：刚打开的登录页控件树可能还没长完（实测 +2.5s 只有 17 条 / 0 个密码框，
   * +4.5s 才 20 条 / 1 个），这时截图不会遮——等它长完再 list 一次才是安全的。
   */
  editFields: number;
  /**
   * 桥给模型的一句解释（桥 0.14.0）。目前只有一种：带了 since 但那一代已经被淘汰 / 不是
   * 这个窗口的代次 → 回全量，并说明「记不住那么早的清单了，这是全量」。
   */
  note?: string;
}

/** uia-act 的回执载荷（成功那一支） */
export interface ComputerUseUiaActReply {
  hwnd: number;
  /** 执行的动作（与请求里的 perform 一致；桥回显便于日志对号） */
  action: ComputerUseUiaAction;
  /** 真正用到的模式：invoke / value / selectionItem */
  usedPattern: string;
  /** 目标控件的可读名字 */
  name: string;
  controlType: string;
  /**
   * AutoSetFocus 是否已成功关掉。true = 已关（不会因为这次调用把窗口带到前台）；
   * false = 关不掉（降级），这一次可能抢了焦点。模型需要知道这件事。
   */
  autoSetFocus: boolean;
  /**
   * AutoSetFocus 关不掉时桥给的原因（人话）。缺省 = 已关掉，没有这句。
   * 不是错误：动作照样做了，只是这一次可能抢了焦点，模型要被告知。
   */
  autoSetFocusWarning?: string;
  /** 应用级准入（桥的观察模式）：目标控件所在窗口的进程不一定是我们的。缺省 = 老桥没这一项 */
  admission?: ComputerUseAdmission;
  /**
   * setValue 的读回档位（桥 0.15.0）：设完之后桥读回控件当前值并与期望比较。
   * 缺省 = 老桥 / 其它动作（invoke / selection）—— 不猜，上层按「桥没说」处理。
   */
  delivery?: ComputerUseDelivery;
  /**
   * 读回证据（只有 setValue 且读回成功时才有）：{kind:"value", detail}。
   * 密码框的 detail 只有「一致 / 不一致」，**不带值本身**——密码不该因为一次确认进模型上下文。
   */
  evidence?: ComputerUseEvidence;
  elapsedMs: number;
}

/** uia-list 的完整回执（控制器层：桥的人话原样放在 error 里，不改写） */
export type ComputerUseUiaListResult =
  | ({ ok: true } & ComputerUseUiaListReply)
  | { ok: false; error: string };

/**
 * uia-act 的完整回执（同上）。
 *
 * 失败分支的 `delivery` 只在**桥明确拒绝**（回执 `ok:false`）时才有，而且只有 `refused`：
 * 参数不合法 / 这个控件不支持该模式 / 窗口已经不在 / UIA 调用自己报 E_FAIL —— 这些都已
 * 确定「动作没有发生」。缺省 = 超时或响应畸形：那时我们不知道模式调用有没有落下去
 * （UIA 是跨进程调用，宿主的 45s 放弃线与 guest 的 5s 看门狗都可能切在一次真的调用之后），
 * **不能替它断言**。这跟像素命令的 failedReply 是同一条纪律。
 */
export type ComputerUseUiaActResult =
  | ({ ok: true } & ComputerUseUiaActReply)
  | { ok: false; error: string; delivery?: ComputerUseDelivery };

/**
 * UIA 调用的看门狗上限（毫秒，桥的默认值；guest-bridge/Uia.cs 里有同一个数字）。
 *
 * 5 秒不是「一条命令的预算」（那条是 GUEST_COMMAND_TIMEOUT_MS = 45s，要容纳文件协议
 * 的传播），而是**跨进程 UIA 调用的上限**：本机控件树的一轮读取是毫秒级，5 秒还没回来
 * 就说明目标进程忙着 / 卡在模态框上，再等也不会好。超时后桥放弃那条 STA 线程、继续服务
 * 后续命令——所以模型看到的是一句「目标窗口没有响应」，而不是整条桥没反应。
 */
export const COMPUTER_USE_UIA_TIMEOUT_MS = 5_000;

/**
 * 这条请求是不是走 UIA 车道（uia-list / uia-act）。
 *
 * 宿主拿它决定**要不要桌面租约**——与按窗口截图同一条理由，只是方向相反：窗口截图是
 * 「只读也不占」，UIA 是「**写也不占**」。UIA 的模式调用直接进目标控件，不需要那个窗口在前台、
 * 不移动前台焦点（AutoSetFocus 被关掉），所以两个会话可以各自驱动各自的窗口。
 * 像素输入（click / type / key / scroll）仍然必须持 desktop:exclusive：它们共用唯一一个前台焦点。
 *
 * 这条判据成立的前提是**动作集里没有 focus**（桥 0.11.0 删除）：Element.SetFocus 动的是
 * 桌面级键盘焦点。谁要把它加回来，必须同时给那条取 desktop:exclusive——否则这里的「不占桌面」
 * 会变成一个假的陈述。
 */
export function isUiaRequest(request: ComputerUseToolRequest): boolean {
  return request.action === "uia-list" || request.action === "uia-act";
}

/**
 * 给模型的「focus 已删除」文案。宿主（dispatch 的兜底拦截、agent 工具的参数校验）与桥
 * guest-bridge/Uia.cs 的 FocusRemovedMessage 是同一句话的副本：两层各有一道闸，改时两处一起改。
 */
export const computerUseUiaErrors = {
  focusRemoved:
    "focus 动作已删除：Element.SetFocus 会移动整块桌面的键盘焦点，与 UIA 车道「不碰桌面」的前提冲突。" +
    "要移动焦点，用 computer_click 点到目标控件；或者直接用 invoke（通常同时给焦点）/ setValue（不需要焦点）。",
} as const;

/**
 * L2b（多会话隔离）里像素输入车道的拒用文案。
 *
 * **为什么必须明拒而不是发出去让桥自己回**：在 IsolationSession 里 `SendInput` 返回 3、
 * `err=0`，看起来完全成功，而光标永远停在 (0,0)（会话是 RDP 形态，`SM_REMOTESESSION=1`，
 * 没有接真实输入设备）。它不会报错，只会什么都不做——而模型看到「已点击」会接着往下走，
 * 错的是一整条动作序列。所以在**下发之前**就拒，并把可用的三条车道写进同一句话里。
 *
 * 三个要素必须同时在：① 为什么不行；② 换哪条路（UIA / CDP / 会话内 PostMessage）；
 * ③ 提醒它别重试同一个动作（模型看不见 UI，不告诉它换什么它只会重试）。
 */
export const computerUseIsolationErrors = {
  noPointer:
    "这个隔离档位（多会话隔离 / L2b）没有真实的鼠标键盘：会话是 RDP 形态，" +
    "SendInput 会返回成功但光标不动——所以像素点击 / 打字 / 按键 / 滚动一律不下发。" +
    "改用：uia-list + uia-act（Win32 控件与大部分桌面程序）、sandbox_*（浏览器，走 CDP）、" +
    "或 screenshot + window 看一眼现状。不要重试同一个像素动作。",
  /** 像素动作的降级只在隔离档上发生；这条给工具描述 / 设置页复用同一句 */
  noPointerShort: "多会话隔离档没有真实鼠标键盘，像素输入不可用（SendInput 静默失效）。",
} as const;

/**
 * 这四条命令在 L2b 里一律不发：它们都靠 SendInput 注入当前桌面的真实输入流。
 * 判据与桥的命令名同源（`computerUseGuestCommands`），改名字不会漏。
 */
export function isPixelInputCommand(command: ComputerUseGuestCommand): boolean {
  return (
    command === computerUseGuestCommands.click ||
    command === computerUseGuestCommands.type ||
    command === computerUseGuestCommands.key ||
    command === computerUseGuestCommands.scroll
  );
}

/**
 * 这条请求是不是那个**已删除**的 focus 动作（uia-act + perform=focus）。
 *
 * 类型与工具 schema 都不再产出它；这条判据只为两层兜底存在：接线层（dispatch.ts）拒掉旧
 * agent / 旧会话记录里的迟到请求并给出换路文案，以及测试把「删了」这件事钉住。
 *
 * 为什么删而不是给它取桌面租约：Element.SetFocus 移动的是桌面级焦点。取租约也能保证正确性，
 * 但租约要持有到 idle 超时（60s），一次 focus 就会把别的会话的像素动作堵在这把锁上一分钟——
 * 那恰好废掉这条车道「不占桌面」的全部意义。而 focus 本身可替代（invoke 通常同时给焦点，
 * setValue 不需要焦点，要移动焦点用 computer_click 点过去），所以直接删。
 */
export function isUiaFocusRequest(request: ComputerUseToolRequest): boolean {
  return request.action === "uia-act" && String(request.perform) === "focus";
}

// ── agent 的像素工具组（PR2）───────────────────────────────────────────

/** 鼠标键。缺省 left——绝大多数操作是左键 */
export type ComputerUseButton = "left" | "right" | "middle";

/**
 * agent 工具 → 主进程的请求。**坐标一律是沙箱物理屏像素**：换算在工具层做
 * （computer-tools.ts 拿最近一次截图的几何把模型给的图像坐标还原），主进程与桥
 * 只认物理像素——这两端不该各自再猜一遍缩放。
 */
export type ComputerUseToolRequest =
  | {
      action: "screenshot";
      maxWidth?: number;
      /**
       * 只拍这一个窗口（桥 0.9.0）：数字 = hwnd（win-list 回执里的那个），字符串 = 标题的
       * 不区分大小写包含匹配。缺省 = 整块桌面（与改动前逐字同行为）。
       *
       * **这条路径不占桌面租约**：PrintWindow 读窗口自己的 surface，被遮挡也拍得到、不抢焦点，
       * 所以多个会话可以各拍各的窗口（desktop:exclusive 仍归整桌面截图与像素输入）。
       */
      window?: string | number;
    }
  | { action: "click"; x: number; y: number; button?: ComputerUseButton; double?: boolean }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; x: number; y: number; deltaY: number }
  // ── UIA 车道（桥 0.10.0）：按控件动作，不按坐标、不抢前台 ──────────────
  //
  // 字段名与 guest 命令一致（window = hwnd 数字或标题片段，ref 来自上一次 uia-list）。
  // **不占桌面租约**（isUiaRequest）：这是整个车道的意义，别在接线层又把它塞进队列。
  // 动作集里没有 focus（桥 0.11.0 删掉）：它动的是桌面级焦点，见 computerUseUiaErrors。
  /**
   * 列出窗口里的可动作控件。只读、不抢焦点。
   * `since` 缺省 = 全量（与改之前逐字同行为）；给了上一代的 generation 就只回变化。
   */
  | { action: "uia-list"; window?: string | number; maxItems?: number; since?: number }
  /**
   * 对一个控件执行 UIA 模式。ref 与 name 至少给一个（ref 优先，且必须是同一窗口里
   * uia-list 回执的那个序号）；perform 是动作，不是像素坐标。
   * focus 不在动作集里：发了它会被接线路拒，并回一句带替代路径的话。
   */
  | {
      action: "uia-act";
      window?: string | number;
      /** 带代次的 ref token（"g12:r3"），必须是该窗口最近一次 list 的那一代；旧代次会被拒 */
      ref?: string;
      name?: string;
      perform: ComputerUseUiaAction;
      /** setValue 的新值（可以直接清空：value: ""）；其余动作忽略 */
      value?: string;
      /** 桥的看门狗上限（缺省 COMPUTER_USE_UIA_TIMEOUT_MS） */
      timeoutMs?: number;
    }
  // ── sandbox_* 浏览器工具（PR3）。**动作名带 `sandbox-` 前缀**：像素组的
  // screenshot / click / type 已经占用了那几个动词，同一个联合里不能重名。
  // 每个动作由主进程翻成一条 cdp-* guest 命令（一次文件往返）。
  //
  // **错误语义（与像素组一致）**：任何失败都是 `{ok:false, error}`，error 是给模型读的
  // 人话，且必须说清下一步怎么做。CDP 侧失败时要带「可以退回 computer_* 像素工具」——
  // 模型看不见 UI，不告诉它它就会重试同一个动作。选择器失效 / 页面未导航 / ref 作废
  // 都属于这一类，文案里点名重新 sandbox_observe。
  /** 打开网址并等加载；沙箱里的 Edge 没起来时先自动 cdp-start（模型不必知道这一步） */
  | { action: "sandbox-navigate"; url: string; timeoutMs?: number }
  /** 正文 + 可交互元素清单。返回的是**给模型读的文本**，不是 DOM 树 */
  | { action: "sandbox-observe"; maxElements?: number }
  /** 按 sandbox_observe 给的选择器点击。element 是一句人话，审批卡上给用户看 */
  | { action: "sandbox-click"; selector: string; element?: string }
  /** 聚焦选择器并输入；submit = 输入后回车。clear 缺省 true（换掉旧值而不是追加） */
  | { action: "sandbox-type"; selector: string; text: string; submit?: boolean; clear?: boolean; element?: string }
  /** 取页面正文（或某个选择器的）文本 */
  | { action: "sandbox-extract"; selector?: string }
  /** 等选择器出现（timeoutMs 上限 10s）或等固定毫秒数 */
  | { action: "sandbox-wait"; selector?: string; ms?: number; timeoutMs?: number }
  /** 页面截图（JPEG 兄弟文件）；width/height 是图，nativeWidth/Height 是视口 CSS 像素 */
  | { action: "sandbox-screenshot"; maxWidth?: number }
  /** 把宿主文件拷进映射目录再喂给 <input type=file>。path 是**宿主**绝对路径 */
  | { action: "sandbox-upload"; selector: string; path: string; element?: string }
  /** 点一个下载链接，文件落映射目录，回执带宿主侧落点与文件名。dir = 可选子目录名（相对 downloads/） */
  | { action: "sandbox-download"; selector: string; dir?: string; element?: string }
  /** 标签页：list = 看有哪些（弹窗 / target=_blank 会新开一个），switch = 切到第 index 个 */
  | { action: "sandbox-tabs"; op?: "list" | "switch"; index?: number };

/**
 * 这个动作走 CDP 通道（sandbox_*）还是像素通道（computer_*）。主进程按它分流：
 * 前者要一个长期存活的 CdpSession，后者只需要沙箱状态机。
 */
export function isSandboxBrowserAction(action: ComputerUseToolRequest["action"]): boolean {
  return action.startsWith("sandbox-");
}

/**
 * 这条请求是不是**按窗口**截图（screenshot + window 字段）。
 *
 * 宿主拿它决定**要不要桌面租约**：整桌面截图与像素输入共用唯一一块屏幕与前台焦点，必须排队；
 * 而按窗口截图走 PrintWindow——读的是那个窗口自己的合成 surface，别人的窗口挡着也拍得到，
 * 也不移动焦点、不改变前后台（2026-10-25 真沙箱实测：被 900×700 不透明窗口完全遮住的 Edge
 * 拍出来与可见时逐像素一致）。所以它**不占** desktop:exclusive，多个会话可以同时各拍各的。
 *
 * 唯一的共享副作用是「目标最小化时要先恢复」：ShowWindow(SW_SHOWNOACTIVATE) 会让那个窗口
 * 重新出现在桌面上（不抢焦点）。这是 win-shot 能拍到最小化窗口的前提，权衡下仍然值得——
 * 否则最小化的窗口就只能回「拍不到」。
 */
export function isWindowScreenshotRequest(request: ComputerUseToolRequest): boolean {
  return request.action === "screenshot" && request.window !== undefined;
}

/**
 * 一张截图的全部几何 + 字节：工具层存下它，把模型随后给的图像坐标换算成物理像素。
 * data 是 JPEG 的 base64（与 browser_screenshot 同款：pi 的图片块直接吃它）。
 */
export interface ComputerUseShot {
  /** 回图尺寸（模型看到的像素） */
  width: number;
  height: number;
  /** 沙箱物理屏尺寸 */
  nativeWidth: number;
  nativeHeight: number;
  data: string;
  /** 图的 MIME（缺省 = image/jpeg；L3 的 Linux 桌面出 PNG，见 ComputerUseScreenshotResult.mime） */
  mime?: string;
}

// ── 像素输入的交付语义（五档）─────────────────────────────────────────
//
// 为什么要有这一层：`SendInput` 的返回值只说明**事件进了窗口队列**，不说明动作生效
// （窗口可能卡住、焦点可能被别人抢走、目标控件可能压根不接受输入）。以前回执只有
// `ok:true`，模型读成「我点到了 / 打进去了」就接着往下走，出了错也发现不了，甚至会
// 重放同一个动作。交付档位把「已送出」「已生效」与「有读回但值没变」分开。
//
// 五档（2026-11 由三档扩成五档，对标 OpenAI cua driver 的回执口径）：
//   confirmed        有读回证据（控件值 / 文档 URL / 窗口状态），可以继续
//   partial          只完成了一部分（桥 0.15.0：SendInput 只插入部分事件，已补发松开按下键）
//   unverifiable     已经发出去了，但没有生效证据——**先看一眼再决定，不要立刻重放**
//   suspected_noop   有读回、但读回的值没变——大概率没生效，换做法
//   refused          没有发出去（参数非法 / 发送失败 / 后端明确拒绝）——可以修参数重试
//
// 谁真的产出哪一档（2026-11 桥 0.15.0）：
//   · UIA setValue → confirmed / suspected_noop（读回该元素当前值，带 evidence）
//   · 像素输入 → partial（SendInput 插入数 < 请求数）；其余成功仍是 unverifiable
//   · 任何后端 → refused（没发出去）
//
// **硬规矩：没有读回证据就不许说 confirmed。** 截图变了 / API 返回成功 / 事件被收到都
// 不算证据：它们最多证明「有变化」，证明不了「你要的那一下生效了」。所以
// settleComputerUseDelivery 把无证据的 confirmed 降回 unverifiable——不抛错、也不保留
// 一个假的确认。
//
// 兼容老桥（三档时代只发 applied / dispatched / failed）：parseComputerUseDelivery 归一
// 成新值，语义不变。老桥不说话（缺失 / 不认识）仍然是 undefined：不猜。

/** 五档的**唯一顺序表**：文案拼接、测试与迭代都按它来，不要在别处再手写一份 */
export const COMPUTER_USE_DELIVERIES = [
  "confirmed",
  "partial",
  "unverifiable",
  "suspected_noop",
  "refused",
] as const;

/** 一条像素输入命令的交付档位（guest 桥写在回执的 `delivery` 上） */
export type ComputerUseDelivery = (typeof COMPUTER_USE_DELIVERIES)[number];

/** 是不是五档之一（运行时收窄用；老值不算，归一交给 parseComputerUseDelivery） */
function isComputerUseDelivery(raw: unknown): raw is ComputerUseDelivery {
  return typeof raw === "string" && (COMPUTER_USE_DELIVERIES as readonly string[]).includes(raw);
}

/**
 * 回执里的 `delivery` → 契约值。
 *
 * 新值原样返回；**老桥的三个老值归一**：applied → confirmed、dispatched → unverifiable、
 * failed → refused（只改名字，不改语义）。不认识 / 缺失一律 `undefined`——老桥不说话时
 * 按「没说」处理，由调用方决定兜底档位，而不是猜一个：把失败记成成功比少一条信息坏得多。
 */
export function parseComputerUseDelivery(raw: unknown): ComputerUseDelivery | undefined {
  if (isComputerUseDelivery(raw)) return raw;
  if (raw === "applied") return "confirmed";
  if (raw === "dispatched") return "unverifiable";
  if (raw === "failed") return "refused";
  return undefined;
}

/**
 * 一次动作之后**读回来**的东西。
 *
 * 只有精确读回才算证据：控件值（value）、文档 URL（url）、窗口状态（window）、
 * 一段可对照的文本（text）。`detail` 是给人/模型看的具体内容（例如 `value="已提交"`）。
 * 截图、API 的 ok、事件被收到**都不在这个类型里**——它们证明不了「你要的那一下生效了」。
 */
export type ComputerUseEvidence = { kind: "value" | "window" | "url" | "text"; detail: string };

/**
 * 回执里的 `evidence` → 契约值。**不认识 / 缺字段一律当作没有证据**（undefined），不抛错。
 *
 * 为什么这么严：resp 是 guest 进程写的内容，是协议里唯一的不可信输入。一份形状不对的证据
 * 如果被原样当成证据，`settleComputerUseDelivery` 就会放行一个假的 confirmed——那是本轮
 * 要消灭的那类谎报。反向也不行：为一个字段问题把整条回执写成工具错误，模型会重试一个
 * 已经生效的动作。所以：「无效证据」与「没证据」同一个结果，都是降档。
 */
export function parseComputerUseEvidence(raw: unknown): ComputerUseEvidence | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const kind: unknown = (raw as { kind?: unknown }).kind;
  const detail: unknown = (raw as { detail?: unknown }).detail;
  if (typeof detail !== "string" || detail === "") return undefined;
  if (kind !== "value" && kind !== "window" && kind !== "url" && kind !== "text") return undefined;
  return { kind, detail };
}

/**
 * 交付档位的**降级闸门**：`confirmed` 但没有读回证据 → `unverifiable`，其余原样返回。
 *
 * 为什么是降级而不是抛异常：调用点拿到一个「不能继续确认」的档位，模型会按 unverifiable
 * 的口径先看一眼；抛异常会把一次已经发生的注入变成一条工具错误，模型反而可能重试。
 * 为什么不改 `ok`：`ok` 讲的是「命令走完了没有」，与「生效了没有」是两件事，不能混。
 */
export function settleComputerUseDelivery(
  delivery: ComputerUseDelivery,
  evidence?: ComputerUseEvidence,
): ComputerUseDelivery {
  if (delivery === "confirmed" && evidence === undefined) return "unverifiable";
  return delivery;
}

/**
 * 五档各一句**给模型的口径**。**唯一来源**：工具描述（click / type / key / scroll /
 * screenshot）与调用回执都从这里取，别在别处再写第二套说法——模型从两处读到两种说法时，
 * 会挑那个更省事的信。
 *
 * 为什么 unverifiable 必须写「不要立刻重放」：模型看到「已送出」的自然反应就是接着下一步；
 * 如果那一下其实已经生效（只是我们没证据），重放就是双击 / 双份文字。先看一眼屏幕再决定，
 * 代价是一张图，收益是不会有「同一动作做两遍」。
 * **必须点名 computer_screenshot**：只说「先截一张图」模型不知道调哪个工具（它看不到实现），
 * 可能去用内置浏览器截图、或者干脆跳过；工具名是它唯一能执行的指令。
 */
export const COMPUTER_USE_DELIVERY_HINTS: Record<ComputerUseDelivery, string> = {
  confirmed: "读回证据对上了，动作已经生效，可以继续下一步。",
  // partial 从桥 0.15.0 起真的会出现了（SendInput 只插入一部分事件）。它的正文不能写
  // 「把剩下的步骤补上」——那些事件根本没送出去，桌面上的真实状态是「半个动作」，盲目补
  // 到底会重做前半段。所以这里说的是「先看一眼，再决定补哪几步」。
  partial:
    "只完成了一部分（剩下的输入事件没有送出去）：先截一张图（computer_screenshot）确认现在的状态，" +
    "再决定补哪几步；不要原样重放整条动作（会重复前半段）。",
  unverifiable:
    "已经发出去了，但没拿到生效证据：先截一张图（computer_screenshot）看一眼再决定下一步，不要立刻重放同一个动作（会变成双击或双份文字）。",
  suspected_noop:
    "有读回，但读回的值没变：大概率没生效，换个做法（比如改用 UIA 命中或换坐标），不要原样重试。",
  refused: "没有发出去（参数不合法、发送失败或后端明确拒绝）：可以修参数后重试。",
};

/**
 * 后端声明 `evidence: "none"`（没有任何精确读回）时，追加在交付说明后面的一句。
 * **唯一来源**：回执正文从这里取，不在 agent-requests.ts 里再写一份。
 *
 * 为什么要单独一句：unverifiable 那句讲的是「这一次没拿到证据」，而这类后端是**永远**
 * 拿不到证据——模型如果只读前一句，会以为「再试一次也许就能确认」，于是反复重试同一个
 * 动作。这一句把事实说死：别等了，确认只能靠你自己截图看。
 * 为什么也点名 computer_screenshot：与上一句同一个理由（模型只认工具名）。
 */
export const COMPUTER_USE_NO_EVIDENCE_HINT =
  " 这个后端拿不到任何读回（没有控件树，也没有按窗口截图），所以这个动作永远不会被自动确认：" +
  "点完之后用 computer_screenshot 截图确认结果，再决定下一步。";

/**
 * 电脑使用的**会话授权**（2026-11-27）——「这台沙箱桌面，本会话里 agent 能不能碰」。
 *
 * 为什么是会话元数据上的一个三态字段，而不是权限档位 / 审批卡：2026-11-16 用户删掉了
 * 整套 PermissionMode 与审批卡（理由：不带上下文、卡住长程任务）。授权不是「每个动作
 * 问一次」，而是「本会话用不用这台桌面」问一次、答一次、随时可撤；工具审批系统不参与。
 *
 * - `unset`：还没问过（也含撤销 / 急停之后）——下一次电脑操作会问一次用户；
 * - `allowed`：用户点了「允许本会话」——本会话内所有电脑操作直接放行；
 * - `denied`：用户拒绝 / 没人能回答（超时、窗口已关、会话已删）——工具当场失败，
 *   回一句固定文本给模型（`COMPUTER_USE_CONSENT_DENIED_TEXT`）。
 *
 * **授权只能来自用户回答或这条持久记录**：模型没有任何通路把 unset 写成 allowed。
 * **fail closed**：没人能回答时一律落到 denied，绝不静默放行。
 */
export type ComputerUseConsent = "unset" | "allowed" | "denied";

/**
 * 等用户回答的上限（120s）。超时按 **denied** 落库——这条语义没有例外：
 * 「让模型先干着，人回来再补票」正是这一刀要消灭的静默放行。
 */
export const COMPUTER_USE_CONSENT_TIMEOUT_MS = 120_000;

/**
 * 拒绝时回给模型的**固定**文本（也是界面上「已告知模型」那一行显示的原文）。
 * 单一来源：闸门、记录行、测试都从这里取——三处各写一句就会漂成三种说法。
 */
export const COMPUTER_USE_CONSENT_DENIED_TEXT = "用户拒绝了电脑操作，本会话不要再请求";

/**
 * 本轮被停掉时回给模型的文本（2026-11-27 验收 P1）：用户按了停止 / 抢跑 / 会话被删，
 * 挂起的提问被取消。**这不是拒绝**——用户没有表态，不写 meta，下一次电脑操作会重新问。
 * 为什么必须与拒绝分开说：模型看到「用户拒绝」会记住「本会话不能碰桌面」，而用户只是
 * 停了一下这一轮；下次它就不敢再请求了。
 */
export const COMPUTER_USE_CONSENT_STOPPED_TEXT =
  "这一轮已停止，电脑操作没有执行。这不是拒绝：本会话没有记录任何决定，下次需要时会重新询问用户。";

/**
 * 电脑使用**只在主会话里可用**（2026-11-27 验收 P3 裁决）。
 *
 * 为什么：授权确认行画在它自己那条会话的视图里，子会话 / 自动化跑出来的会话用户根本
 * 看不到——等下去就是 120s 超时、还把会话永久写成 denied。先例：deepseek-harness 的
 * `SYSTEM_INPUT_UNAVAILABLE`、ZCode 的「Main agent only. Never delegate Computer Use to a
 * subagent.」——同一个结论。子会话 / 自动化在闸门处**立刻**收到这句，不要白等 120s。
 *
 * 下面英文那句进工具描述（描述面是英文，口径相同）。
 */
export const COMPUTER_USE_MAIN_SESSION_ONLY_TEXT =
  "电脑使用只在主会话里可用：子会话 / 自动化任务看不到授权确认行，因此不能操作沙箱桌面。需要的话，把这一步交回给主会话来做。";
export const COMPUTER_USE_MAIN_SESSION_ONLY_SCOPE =
  "**Main session only**: a delegated sub-session or an automation run cannot use computer use (its consent " +
  "prompt would be invisible to the user) — hand this step back to the main conversation instead.";

/**
 * 这一轮是谁发起的（2026-11-27 验收后）。主进程在开轮那一刻记下，闸门只看一个值：
 * 只有 `user`（用户在输入框里手点发出去的）才可能弹授权。
 *
 * - `user`：renderer 的 `agent:submit` / `agent:interrupt`
 * - `automation`：自动化调度（含 `this_session` 把一轮投回用户的会话——那一轮用户很可能不在电脑前）
 * - `channel`：编排线投递（子会话 / 派活），子会话在会话身份那一层已经挡住了
 */
export type ComputerUseTurnOrigin = "user" | "automation" | "channel";

/** 判「用户此刻能不能看到并回答」时，闸门需要的会话身份字段（结构类型，不拉 SessionMeta 进来） */
export interface ComputerUseSessionShape {
  parentId?: string;
  automationId?: string;
  backstage?: "avatar";
  promoted?: boolean;
}

/**
 * 自动化发起的轮次里，电脑使用不弹授权（用户不在看，问不到就是 120s 超时→永久 denied）。
 * 与“子会话”那句不同：这条会话本身是用户的，只是这一轮不是他发起的。
 */
export const COMPUTER_USE_UNATTENDED_TEXT =
  "这一轮不是你手动发起的（自动化 / 定时任务），电脑使用不会为它弹授权。要操作沙箱桌面，请在主会话里手动发起。";

/**
 * 电脑使用的**唯一判据**：这一条会话、这一轮，用户能不能看到并回答那个授权提问。
 * null = 能，可以提问；否则就是回给模型的那句拒绝文本（当场拒，不白等 120s）。
 *
 * 两件事一起判，**不拆成两套口径**：
 *   1. **会话身份**：子会话（parentId）/ 幕后会话（backstage）/ 自动化新开的会话（automationId，
 *      除非用户点了「转成普通会话」→ promoted，那条会话从左栅进、用户看得见）；
 *   2. **这一轮是谁发起的**：`this_session` 自动化会把一轮投回**用户的会话**——会话身份完全正常，
 *      但那一轮用户根本不在看，问一个看不见的问题就是重演「未经同意的拒绝」。
 *
 * 为什么不用「该会话此刻有没有可见视图」做判据：那要 renderer 把「我在看谁」上报给主进程，
 * 是另一条 IPC；而本轮要堵的是「自动化把拒绝写进用户会话」这个入口，发起者是主进程本来就知道的
 * 事实。两者不混用：这里只看上面两件。
 */
export function computerUseBlockedReason(
  session: ComputerUseSessionShape,
  origin: ComputerUseTurnOrigin,
): string | null {
  const userFacing =
    session.parentId === undefined &&
    session.backstage === undefined &&
    (session.automationId === undefined || session.promoted === true);
  if (!userFacing) return COMPUTER_USE_MAIN_SESSION_ONLY_TEXT;
  if (origin !== "user") return COMPUTER_USE_UNATTENDED_TEXT;
  return null;
}

/** 授权状态变化的原因（事件里带上，renderer 据此决定要不要清挂起的提问行） */
export type ComputerUseConsentSource =
  | "answered"
  | "timeout"
  | "unavailable"
  | "cancelled"
  | "revoked"
  | "emergency-stop";

/**
 * meta 读回时的归一化：只认三个值，其余（老会话缺席、坏值）一律当 `unset`。
 * 缺席 = 没问过——老会话不会因为加了字段就凭空获得桌面权限。
 */
export function parseComputerUseConsent(raw: unknown): ComputerUseConsent {
  return raw === "allowed" || raw === "denied" ? raw : "unset";
}

/**
 * 主进程 → renderer：某条会话的电脑操作被闸门挡住，等用户点头（挂起状态）。
 * requestId 是这次提问的号，回答时原样带回；renderer 按它渲染确认行、并按它清掉。
 */
export interface ComputerUseConsentAskEvent {
  type: "computerUseConsentAsk";
  sessionId: string;
  requestId: string;
  /** 触发这次提问的工具动作（renderer 只用它显示「哪类操作要用桌面」） */
  action: ComputerUseToolRequest["action"];
  askedAt: number;
}

/**
 * 主进程 → renderer：挂起的提问被**撤掉**（本轮结束：停止 / 抢跑 / 会话删除 / 进程退出）。
 * 这不是拒绝：没有写 meta，确认行要从界面上撤下。
 */
export interface ComputerUseConsentAskCancelledEvent {
  type: "computerUseConsentAskCancelled";
  sessionId: string;
  requestId: string;
  /** 只有一种：这一轮已经结束了，那个提问不可能再被回答 */
  reason: "turn-ended";
}

/**
 * 主进程 → renderer：授权状态变了（回答 / 超时 / 撤销 / 急停）。
 * `requestId` 只在它由一次提问结出来时带着——renderer 按它清挂起的确认行。
 */
export interface ComputerUseConsentStateEvent {
  type: "computerUseConsentState";
  sessionId: string;
  state: ComputerUseConsent;
  source: ComputerUseConsentSource;
  requestId?: string;
}

/** computerUseRequest 的回执载荷：主进程组装，agent 进程翻成 pi 工具结果（browserResult 同款） */
export type ComputerUseToolOutcome =
  | {
      ok: true;
      /** 给模型的正文（纯文本：做了什么、屏幕现在什么样、下一步该干什么） */
      text: string;
      /** 只有 screenshot 带：回图字节与两套尺寸（工具层换算坐标要靠它） */
      shot?: ComputerUseShot;
      /**
       * 像素输入的交付档位（可选：截图 / UIA / sandbox_* 这些通道不说这一档，缺省即可）。
       * 主进程从桥的回执里取；桥没说时按 `unverifiable` 兜底（SendInput 成功入队就是这个含义）。
       */
      delivery?: ComputerUseDelivery;
      /**
       * 只有截图带：遮罩结果与用户是否正在输入（桥 0.12.0）。
       * 工具层拿它写审计（`details.computerUse` 的 maskedRegions / userTypingAtCapture）；
       * **模型看不到这些字段**——它看到的是 text 里那句人话。
       */
      capture?: ComputerUseCaptureInfo;
    }
  | {
      ok: false;
      error: string;
      /** 桥**明确拒绝**了这条命令时是 `refused`；超时 / 沙箱没在跑这类「不知道」的失败不带这一档 */
      delivery?: ComputerUseDelivery;
    };

/**
 * 一次 computer_* 调用的审计载荷（pi 工具结果的 `details.computerUse`）。
 *
 * **只给 UI 与日志、不入模型上下文**（pi 对 details 的通路就是这样）；模型看到的是
 * 工具结果正文。字段刻意只留「发生了什么」：动作名、模型给的原始入参、时刻。
 * 坐标是**模型看到的截图像素**（不是物理像素）——审计要回答的是「它点了图里的哪里」，
 * 换算后的物理像素对回看的人没有意义。
 *
 * 转录本身（tool call + result 记录）已经是审计主通道，这里补的是 renderer 不解析
 * 正文也能画的一层结构化摘要（browser 的 details.browser.handoff 同款）。
 */
export interface ComputerUseAudit {
  action: ComputerUseToolRequest["action"];
  /** 模型给的原始入参（未换算、未改写） */
  args: Record<string, unknown>;
  /** 调用发起的时刻（毫秒） */
  at: number;
  /**
   * 这一下是**谁**干的。现在只有 agent 自己能用这些工具，所以永远是 "agent"；
   * 留成字段是为了让会话记录能回答「这一下是不是人亲自做的」（以后接用户优先的车道时
   * 才有第二个值）。像素四件、UIA、sandbox_* 写件、截图都记它。
   */
  inputOrigin: "agent";
  /** 截图专用：拍的那一刻用户是不是正在沙箱里输入（桥的 input-status，< 400ms 算在打） */
  userTypingAtCapture?: boolean;
  /** 截图专用：图里被涂黑的密码框数（0 = 没有密码框 / 清单过期没遮） */
  maskedRegions?: number;
}

/**
 * 审计载荷的唯一工厂（`details.computerUse` 的真源）。像素 / UIA / 沙盒浏览器三条车道
 * 共用一份：字段名与顺序在一处定，免得三处各拼一遍、拼出三种形状。
 */
export function computerUseAudit(
  action: ComputerUseAudit["action"],
  args: Record<string, unknown>,
  at: number = Date.now(),
): ComputerUseAudit {
  return { action, args, at, inputOrigin: "agent" };
}

/**
 * 截图回执正文后面要追的那句「遮了 / 没遮」人话（**纯函数**，两条截图路径共用，单测直接验）。
 *
 * 三条规则，对应三种真实处境：
 *   · 遮了 → 告诉模型「这几块是故意的黑块，密码不该进你的上下文，也别去读」；
 *   · 有清单但过期 → **必须明说没遮**：让模型以为遮了的代价比不遮更大（它会放心读图）；
 *   · 从没 list 过 → 同上，并给出它当下能做的事（先 list 再截图）。
 * 没有密码框且清单是新的（`maskListed && !maskStale && maskedRegions === 0`）什么都不说：
 * 正常截图一个字都不该变——那些文案已经在真实会话里被稳住了。
 */
export function captureNote(capture: ComputerUseCaptureInfo | undefined): string {
  if (capture === undefined) return "";
  let note = "";
  if (capture.maskedRegions > 0) {
    const fields = capture.maskedRegions === 1 ? "field" : "fields";
    note +=
      ` ${capture.maskedRegions} password ${fields} in this image ${capture.maskedRegions === 1 ? "was" : "were"} ` +
      "blacked out — a password must never reach you, and the black block is deliberate. Do not try to read it; " +
      "if you need a password, ask the user.";
  } else if (capture.maskStale) {
    const ageSeconds = Math.max(0, Math.round(capture.maskCacheAgeMs / 1000));
    note +=
      " WARNING: this image is NOT masked. The last computer_uia list of what you captured is " +
      `${ageSeconds}s old, and password field positions are only remembered for ` +
      `${COMPUTER_USE_MASK_CACHE_MAX_AGE_MS / 1000}s — so if a password field is visible in this image, ` +
      "do not read it. Run computer_uia list on that window again, then take the screenshot again.";
  } else if (!capture.maskListed) {
    note +=
      " WARNING: this image is NOT masked — nothing has been listed with computer_uia yet, so password fields " +
      "could not be found and covered. If a password field is visible in this image, do not read it. " +
      "Run computer_uia list on that window first, then take the screenshot again.";
  }
  // P2-2 的那半句实话：桌面车道只认 UIA 的 IsPassword。网页里点过「显示密码」的框已经被翻成
  // 普通输入框，**在本次 list 之前**就翻开的那种桌面车道根本没见过——不能装作能遮。
  note +=
    " This is the desktop lane: it knows password fields only from the last computer_uia list, so a web page " +
    "field already switched to plain text by \"show password\" before that list is invisible to it — for web " +
    "pages use sandbox_screenshot, which masks by DOM.";
  if (capture.userTyping) {
    note +=
      " A person was typing in the sandbox while this was captured (their input takes priority over yours), " +
      "so parts of the image may already be out of date.";
  }
  return note;
}

/** 只用到尺寸的那部分几何（换算函数的最小输入，测试与工具层都不必凑齐字节） */
/**
 * 页面侧的一张图（sandbox-screenshot）。字段与像素组**刻意同形**：工具层与读图的代码不必
 * 分叉。差异只在语义——这里的 width/height 是 JPEG 的像素，nativeWidth/Height 是视口 CSS
 * 像素（DPR=1 时两者相等；缩放只由 maxWidth 引起）。
 */
export interface SandboxShot {
  /** JPEG 字节的 base64 */
  data: string;
  /** JPEG 像素尺寸（模型看到的那张图） */
  width: number;
  height: number;
  /** 视口 CSS 像素尺寸（页面坐标系的参照） */
  nativeWidth: number;
  nativeHeight: number;
}

/** cdp-observe 的一行可交互元素（字段名与 guest 回执一一对应） */
export interface SandboxElement {
  /** 可直接传给 sandbox_click / sandbox_type 的 CSS 选择器（页面导航后全部作废） */
  selector: string;
  /** 标签名；输入类带上 type，如 `input[email]` */
  tag: string;
  /** 可读文本（aria-label / placeholder / innerText / value 里第一个非空的，截到 80 字） */
  text: string;
  /** 元素中心点的视口 CSS 像素坐标 */
  x: number;
  y: number;
  /** 元素上显式的 role 属性（没有就是空串） */
  role: string;
  /** 是不是可输入控件（input / textarea / contenteditable） */
  editable: boolean;
}

/**
 * cdp-shot 的回执（宿主只读这几个字段；jpeg 是**纯文件名**，读盘前必须过
 * isPlainScreenshotFileName 那道闸门）。
 */
export interface CdpShotReply {
  jpeg: string;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  url: string;
  title: string;
}

export interface ComputerUseShotGeometry {
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}

/**
 * 回图坐标 → 沙箱物理屏坐标。**越界一律 null，不做猜测性钳制**：
 * 模型给了图外一个很远的点（比如把 2560 当成图宽）时，悄悄钳到边缘等于替它点了个
 * 它没打算点的东西；回一句「这张图只有 1280×720」它才知道自己算错了。
 * 边界值（x == width / y == height）算合法——那是「贴右 / 下边缘」的正常写法，
 * 四舍五入后落在最后一个像素上。
 *
 * 回图与物理屏的比例两个轴各算各的：桥按长边等比缩放，正常两轴同比例，
 * 但这里不假设——等比是桥的实现细节，不是协议。
 */
export function screenshotPointToNative(
  shot: ComputerUseShotGeometry,
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > shot.width || y > shot.height) return null;
  return {
    x: clamp(Math.round((x * shot.nativeWidth) / shot.width), 0, shot.nativeWidth - 1),
    y: clamp(Math.round((y * shot.nativeHeight) / shot.height), 0, shot.nativeHeight - 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
