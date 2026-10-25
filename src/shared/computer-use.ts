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
 * 出网：.wsb 的 <Networking> 用 Default（沙箱能上网）。v1 要的就是网页自动化，所以这是
 * **有意放开的攻击面**：沙箱内的进程（含 agent 打开的网页）能访问网络与宿主所在内网，
 * 别把它当成「防网络的隔离层」。将来考虑加一个开关（禁出网 = 只做本地桌面自动化）。
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
} as const;

export type ComputerUseChannel = (typeof computerUseChannels)[keyof typeof computerUseChannels];

// ── 协议常量（宿主与 guest 桥共用的数字/路径，改动即破坏两端）──────────────

/** guest 桥在沙箱内的落点（.wsb 用 junction 把映射目录并到这里，协议按这个路径执行） */
export const COMPUTER_USE_GUEST_BRIDGE_DIR = "C:\\orbita-bridge";
/** 输出目录在沙箱内的落点（读写映射：桥写在这里，沙箱销毁后宿主目录里仍在——产物回传通道） */
export const COMPUTER_USE_GUEST_OUT_DIR = "C:\\orbita-out";
/** 桥的地址通告文件名（落在 out 目录下；宿主轮询它等桥上线） */
export const BRIDGE_INFO_FILE = "bridge.json";
/** 命令目录名（out 目录下；宿主写 req、桥写 resp 的地方） */
export const COMPUTER_USE_CMD_DIR = "cmd";

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
   * action = invoke / setValue / selection / focus。**不抢前台**（桥把 IUIAutomation2 的
   * AutoSetFocus 置 false），所以这条路径不占桌面租约（见 isUiaRequest）。
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
  /** 起沙箱内的 Edge 并等到 CDP 可用（幂等）。端口取 0 让系统分配，桥读 DevToolsActivePort */
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
 * 桥不应答时的放弃线（主进程等一条 **像素 / 桌面** guest 命令的上限）。
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
  | { state: "starting"; startedAt: number }
  | { state: "running"; startedAt: number; bridgeVersion: string }
  | { state: "stopping" }
  | { state: "error"; message: string };

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
  /** 四项全过（hypervisorState 为 unknown 也算过）。false 时看 guidance */
  ready: boolean;
  /** 不能就绪时的手动操作指引（含「启用或关闭 Windows 功能」路径与提权命令文本——只给文案，绝不代跑） */
  guidance: string | null;
}

// ── 四个 IPC 入口的载荷 ───────────────────────────────────────────────

export type ComputerUseStartResult = { ok: true } | { ok: false; error: string };

export type ComputerUseStopResult = { ok: true } | { ok: false; error: string };

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
      /** 回图尺寸（模型看到的像素） */
      width: number;
      height: number;
      /** 沙箱物理屏尺寸 */
      nativeWidth: number;
      nativeHeight: number;
      takenAt: number;
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
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
      hwnd: number;
      title: string;
      /** 目标最小化过、已被 ShowWindow(SW_SHOWNOACTIVATE) 恢复（不抢焦点） */
      restoredFromMinimized: boolean;
      takenAt: number;
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

/**
 * UIA 动作。**这是动作而不是像素坐标**：invoke = InvokePattern（按钮/链接/菜单项），
 * setValue = ValuePattern（输入框/文档），selection = SelectionItemPattern（列表/标签项），
 * focus = Element.SetFocus（唯一一个**有意**移动键盘焦点的动作，模型点了它才做）。
 *
 * 「点击」不在这里：UIA 的 InvokePattern 是「执行这个控件的默认动作」，比在坐标上按下
 * 更稳（不依赖控件位置、不被遮挡影响）。需要真的按坐标就仍用 computer_click。
 */
export type ComputerUseUiaAction = "invoke" | "setValue" | "selection" | "focus";

/**
 * uia-list 的一项：一个**可动作**的控件。字段名与 guest 的 UiaItemInfo 序列化结果一一对应。
 * 坐标是**屏幕物理像素**（窗口被移动到哪都行，模型不需要它；它给的是可读定位信息）。
 */
export interface ComputerUseUiaItem {
  /** 稳定序号（同一窗口内按遍历顺序从 1 起）。uia-act 用它或 name 指定目标 */
  ref: number;
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
  /** 这个控件实际支持的动作（只列本车道能执行的三条：invoke / value / selectionItem）。focus 恒可用，不列 */
  patterns: string[];
  enabled: boolean;
  /** 控件不在可见区域（滚动到它 / 切到那个标签页之后才可动作） */
  offscreen: boolean;
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
  items: ComputerUseUiaItem[];
  /** 命中的控件超过 maxItems，后面的没回（模型可以调大 maxItems，或者按 name 直接动作） */
  truncated: boolean;
}

/** uia-act 的回执载荷（成功那一支） */
export interface ComputerUseUiaActReply {
  hwnd: number;
  /** 执行的动作（与请求里的 perform 一致；桥回显便于日志对号） */
  action: ComputerUseUiaAction;
  /** 真正用到的模式：invoke / value / selectionItem / focus（focus 动作没有模式，回 focus） */
  usedPattern: string;
  /** 目标控件的可读名字 */
  name: string;
  controlType: string;
  /** 这次动作**是否**请求了键盘焦点。只有 action=focus 才是 true */
  focused: boolean;
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
  elapsedMs: number;
}

/** uia-list 的完整回执（控制器层：桥的人话原样放在 error 里，不改写） */
export type ComputerUseUiaListResult =
  | ({ ok: true } & ComputerUseUiaListReply)
  | { ok: false; error: string };

/** uia-act 的完整回执（同上） */
export type ComputerUseUiaActResult =
  | ({ ok: true } & ComputerUseUiaActReply)
  | { ok: false; error: string };

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
 */
export function isUiaRequest(request: ComputerUseToolRequest): boolean {
  return request.action === "uia-list" || request.action === "uia-act";
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
  /** 列出窗口里的可动作控件。只读、不抢焦点 */
  | { action: "uia-list"; window?: string | number; maxItems?: number }
  /**
   * 对一个控件执行 UIA 模式。ref 与 name 至少给一个（ref 优先，且必须是同一窗口里
   * uia-list 回执的那个序号）；perform 是动作，不是像素坐标。
   */
  | {
      action: "uia-act";
      window?: string | number;
      ref?: number;
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
}

/** computerUseRequest 的回执载荷：主进程组装，agent 进程翻成 pi 工具结果（browserResult 同款） */
export type ComputerUseToolOutcome =
  | {
      ok: true;
      /** 给模型的正文（纯文本：做了什么、屏幕现在什么样、下一步该干什么） */
      text: string;
      /** 只有 screenshot 带：回图字节与两套尺寸（工具层换算坐标要靠它） */
      shot?: ComputerUseShot;
    }
  | { ok: false; error: string };

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
