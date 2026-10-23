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
 * 宿主↔guest 协议 v1（宿主在 src/main/computer-use/ 实现，guest 桥是独立 exe，两边必须严格一致）：
 *   - 通道 = **映射文件夹里的文件对**，不走网络。反面教材：宿主防火墙把宿主↔沙箱的 TCP 当
 *     不可测（2026-10-10 真机：ICMP 通、TCP 被丢，且随每次启动时好时坏；guest 回连方向更是
 *     稳定被丢），加防火墙规则要提权弹窗，本地优先不接受。而 .wsb 读写映射文件夹双向实时同步、
 *     每次都可靠。
 *   - 命令：宿主写 out/cmd/<名字>.req.json（tmp+rename 原子写）→ 桥轮询执行 →
 *     写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件，先于 resp 落盘）→ 删 req；
 *     宿主读完响应后负责清理 resp / jpg。
 *   - 就绪：桥启动后写 out/bridge.json（tmp+rename）——它出现即代表命令循环已上线。
 *   - 隔离即鉴权：命令目录在宿主用户目录下、沙箱是会话级一次性环境，协议里不再要 token。
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

  // ── CDP 浏览器通道（PR3）：一条命令内部 3~4 条 CDP 消息，但只算**一次**文件往返 ──
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
 * 沙箱里那份 Edge 的 profile 目录（guest 绝对路径）。**每次沙箱一次性**：不映射到宿主，
 * 沙箱销毁即丢——登录态不跨会话，这是产品语义（与 Operator 的 ephemeral VM 同构）。
 * 桥的 cdp-start 在 guest 里建它；宿主不读它，只把它写进错误文案。
 */
export const COMPUTER_USE_GUEST_BROWSER_PROFILE = "C:\\orbita-browser\\profile";

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
 * 放在 shared（而不是定义它的 bridge-client）是因为 agent 侧的 computer-tools 也要读它：
 * broker 的兜底超时必须比这条线更长，否则主进程还在等、agent 先把真成功判成
 * 「主进程没有回执」（computer-tools.ts 的 BROKER_TIMEOUT_MS）。agent 进程不能
 * import 主进程模块，跨进程共享的常量只有这里能放。
 */
export const GUEST_COMMAND_TIMEOUT_MS = 45_000;

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

// ── agent 的像素工具组（PR2）───────────────────────────────────────────

/** 鼠标键。缺省 left——绝大多数操作是左键 */
export type ComputerUseButton = "left" | "right" | "middle";

/**
 * agent 工具 → 主进程的请求。**坐标一律是沙箱物理屏像素**：换算在工具层做
 * （computer-tools.ts 拿最近一次截图的几何把模型给的图像坐标还原），主进程与桥
 * 只认物理像素——这两端不该各自再猜一遍缩放。
 */
export type ComputerUseToolRequest =
  | { action: "screenshot"; maxWidth?: number }
  | { action: "click"; x: number; y: number; button?: ComputerUseButton; double?: boolean }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; x: number; y: number; deltaY: number }
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
  /** 点一个下载链接，文件落映射目录，回执带宿主侧落点与文件名 */
  | { action: "sandbox-download"; selector: string; dir?: string; element?: string };

/**
 * 这个动作走 CDP 通道（sandbox_*）还是像素通道（computer_*）。主进程按它分流：
 * 前者要一个长期存活的 CdpSession，后者只需要沙箱状态机。
 */
export function isSandboxBrowserAction(action: ComputerUseToolRequest["action"]): boolean {
  return action.startsWith("sandbox-");
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
