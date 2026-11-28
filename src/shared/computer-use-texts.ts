/**
 * 电脑使用的**界面文案表**（2026-11-28，「中文与英文两个模式各自纯净」）。
 *
 * 为什么要有它：软件有中文 / 英文两个界面。会出现在界面上的字（设置页的每一行、沙箱状态行、
 * 聊天里的工具回执原文、toast）必须跟着 `settings.language` 走；而这类文案以前散在主进程各模块
 * 的中文常量里，英文界面下就是夹生字。这里收成**一张表**，每个键给 zh / en 两份，调用点按
 * 「现在是哪种界面语言」取一份。
 *
 * 与 `computerUseConsentTexts` 是同一个模式（那也是这张表的前身）：中文原文各有自己的出处，
 * 这张表的 zh 半边**直接复用那些常量**（不抄第二份，改一处就两处都变），en 半边是完整句子
 * 的英文（不是逐词直译——英文要把话说全，模型/用户读到的信息量一致）。
 *
 * 边界（与 2026-11-28 的裁决一致）：
 *   · 进界面的字 → 在这里；
 *   · 只给模型看的（工具描述、system prompt、回执里的诊断建议）→ **不在这里**，保持现状
 *     （`COMPUTER_USE_DELIVERY_HINTS` 同时喂工具描述，所以它留在原处不跟语言走；
 *     回执专用的一份是 `deliveryConfirmed…` 这几个键）；
 *   · 日志（`[computer-use] …`）→ 不在这里，AGENTS.md 规定日志用中文。
 *
 * 纯数据 + 纯函数：不 import node 内置、不 import electron，主进程任何模块与单测都能直接加载。
 */
import {
  COMPUTER_USE_BROWSER_IDLE_MS,
  COMPUTER_USE_DEV_BACKENDS_ENV,
  COMPUTER_USE_LEASE,
  COMPUTER_USE_NO_EVIDENCE_HINT,
  computerUseBrowserErrors,
  computerUseDevBackendRefusal,
  computerUseIsolationErrors,
  computerUseLeaseErrors,
  computerUseUiaErrors,
} from "./computer-use.ts";

/**
 * 「哪个动作」——`…没有在运行，X 不可用` 这类句子里要填的那个名词。
 * 用枚举而不是调用方传字符串：中文句子与英文句子的语序不同（`再截图` vs `take a screenshot`），
 * 交给调用方拼字符串必然有一边读起来是翻译腔。
 */
export type ComputerUseUiAction =
  | "screenshot"
  | "windowShot"
  | "windowList"
  | "uiaList"
  | "uiaAct"
  | "pixels"
  | "browser";

export interface ComputerUseUiTexts {
  // ── 动作名词（拼进「没有在运行」那类句子）──────────────────────────────
  /** 「…不可用」里的那个动作（`screenshot` → 截图 / take a screenshot） */
  actionName(action: ComputerUseUiAction): string;

  // ── 设置页 · 能力探测（capability.ts / runtime.ts / mxc-*.ts）──────────
  /** 非 Windows：macOS 那条要给出路（浏览器档照常可用） */
  guidancePlatformDarwin: string;
  guidancePlatformOther: string;
  guidanceHomeEdition: string;
  guidanceEditionUnknown: string;
  guidanceSandboxFeatureDisabled: string;
  guidanceHypervisorConflict: string;
  guidanceVirtualizationOff: string;
  /** 多会话隔离只在 Windows 上（`${platform}` 填进去） */
  isolationWindowsOnly(platform: string): string;
  isolationProbeNotWired: string;
  isolationProbeFailed(cause: string): string;
  /** 依赖不满足、又没有更具体原因时的兜底 */
  isolationUnavailable: string;
  /** 探测自己挂了：设置页仍要给出一份结果，而不是空白 */
  probeCrashReason: string;
  probeCrashGuidance: string;
  isolationBackendUnavailable: string;
  mxcNativeLoadFailed(cause: string): string;
  mxcProvisionIncomplete: string;
  nodeTooOld(version: string): string;

  // ── 状态行 / 启动停止回执（三个后端共用）──────────────────────────────
  unknownError: string;
  startFailed: string;
  startCancelled: string;
  sandboxAlreadyStarting: string;
  sandboxAlreadyRunning: string;
  sandboxAlreadyStopping: string;
  /** 沙箱（WSB）没在运行：`截图不可用` 与「去设置里启动」 */
  sandboxNotRunning(what: ComputerUseUiAction, state: string): string;
  /** 已经有一只 WSB 在跑（Windows 同时只允许一只） */
  anotherSandboxRunning(names: string): string;
  bridgeExeMissing(path: string): string;
  sandboxExeMissing(path: string): string;
  /** 等 guest 桥就绪超时（bridge-ready.ts）：把「旧沙箱没退干净」这条最常见的坑说清 */
  bridgeReadyTimeout(seconds: number): string;
  /** 同一件事的短句（隔离会话那条路自己会接一句「bridge.json 没写出来」） */
  bridgeWaitTimedOut(seconds: number): string;
  sandboxWindowClosedEarly(code: string): string;
  wsbLaunchFailed(cause: string): string;
  /** 停止后宿主里可能留着孤儿 VM（状态转 error 时那句） */
  sandboxLeftoverVms(left: string): string;
  /** `left` 的兜底：观测不到具体 PID */
  unknownPids: string;

  // ── provider：一个后端都没在跑时回给用户/模型的话 ─────────────────────
  sandboxNotRunningHint: string;
  sandboxStartingHint: string;
  sandboxStoppingHint: string;
  sandboxErrorStateHint: string;
  sandboxNotImplemented: string;

  // ── 隔离会话（isolation-session.ts）─────────────────────────────────
  isolationStartingOrStopping: string;
  isolationBridgeNoAnnouncement: string;
  isolationBridgePingFailed(message: string): string;
  isolationBridgeNotAnnounced(logPath: string, tail: string | null): string;
  isolationBridgeLogMissing: string;
  isolationBridgeLogTail(tail: string): string;
  isolationBridgeExeMissing(source: string): string;
  isolationWorkspaceWriteFailed(workspacePath: string, message: string): string;
  isolationStopSessionFailed(cause: string): string;
  isolationReleaseFailed(cause: string): string;
  isolationResidue(left: string): string;
  isolationNoWorkspace: string;
  isolationUnknownReason: string;
  /** 隔离会话没在运行 / 出错 / 正在启停时，命令道回的那句 */
  isolationNotRunning(what: ComputerUseUiAction, state: string): string;
  isolationErrorState(reason: string): string;
  isolationBusy(what: ComputerUseUiAction, starting: boolean): string;

  // ── guest 桥命令通道（bridge-client.ts / bridge-ready.ts）─────────────
  bridgeWindowShotShape: string;
  bridgeWindowListShape: string;
  bridgeUiaListHwnd: string;
  bridgeUiaListItems: string;
  bridgeUiaListGeneration: string;
  bridgeUiaActHwnd: string;
  bridgeUiaActAction: string;
  bridgeUiaActPattern: string;
  bridgePingShape: string;
  bridgeShotShape: string;
  bridgeJpegMissing(command: string): string;
  bridgeJpegFieldMissing(command: string): string;
  bridgeJpegNameInvalid(name: string): string;
  bridgeJpegFileMissing: string;
  bridgeNoReason: string;
  tcpConnectError(cause: string): string;
  tcpClosed: string;
  tcpHelloFail: string;
  tcpHelloUnexpected(type: string): string;
  tcpReadTimeout(ms: number): string;
  tcpWriteFailed: string;
  tcpClientClosed: string;
  tcpHelloTimeout(ms: number): string;
  tcpFrameTooLarge: string;
  tcpConnectFailed(reason: string): string;
  tcpConnectTimeout(ms: number): string;
  tcpHandshakeFailed(address: string, why: string): string;
  tcpNoAddresses: string;
  /** TCP 回执形状不对（会被拼进「命令通道中断了」那句） */
  tcpReplyMalformed: string;
  tcpChannelBroke(command: string, cause: string): string;
  guestBrowserTimeout(command: string, budget: string): string;
  guestDesktopTimeout(command: string, budget: string): string;

  // ── 沙箱浏览器车道（cdp.ts / agent-requests.ts）───────────────────────
  browserNoPage: string;
  browserUploadNotFound(path: string): string;
  browserUploadNotFile(path: string): string;
  browserUploadEmpty(path: string): string;
  browserUploadBadName(path: string): string;
  browserShotShape: string;
  /** 宿主管道里的编程错误（动作被送错了车道）：不是给用户看的操作建议，但它会进回执 */
  internalWrongLane(action: string, lane: string): string;
  tooManyBrowsers(max: number): string;

  // ── L3 桌面 VM（qemu*.ts，开发者后端）───────────────────────────────
  qemuRefuseUia: string;
  qemuRefuseWindowShot: string;
  qemuRefuseCdp: string;
  qemuStarting: string;
  qemuStopFailed(cause: string): string;
  qemuListFailed: string;
  qemuWindowListShape: string;
  qemuClickMissing: string;
  qemuTypeEmpty: string;
  qemuTypeFailed: string;
  qemuKeyEmpty: string;
  qemuKeyFailed: string;
  qemuScrollMissing: string;
  qemuUnknownCommand(command: string, supported: string): string;
  qemuGuestTimeout(ms: number, port: number): string;
  qemuGuestUnreachable(port: number, reason: string): string;
  qemuGuestHttp(status: number, port: number): string;
  qemuGuestNotJson(snippet: string): string;
  qemuGuestNotObject: string;
  qemuGuestRefusedNoReason: string;
  qemuShotHttp(status: number): string;
  qemuNoShot(reason: string): string;
  qemuShotBadPng: string;
  qemuNoFreePorts(range: string): string;
  qemuVmFilesMissing(missing: string): string;
  qemuSpawnNoPid: string;
  qemuMonitorTimeout: string;
  qemuWaitNotTried: string;
  qemuWaitCancelled: string;
  qemuDesktopWrongSize: string;
  qemuDesktopNotUp: string;
  qemuNoReason: string;
  qemuWaitTimeout(seconds: number, lastError: string): string;
  rfbClosed: string;
  rfbUnreachable(port: number): string;
  rfbNotRfb(version: string): string;
  rfbRefused: string;
  rfbAuthTypes(types: string): string;
  rfbNoneRejected: string;

  // ── 后端切换 / 急停 / 租约（runtime.ts / emergency-stop.ts / ipc.ts / lease.ts）─
  backendSwitchStopFailed(backend: string, error: string): string;
  emergencyHotkeyTaken(attempts: string): string;
  emergencyNotWired: string;
  /** 租约被撤时填进「沙箱已经关闭（…）」里那个缘故（四种撤因 + 两种退出，index.ts 传入） */
  leaseReasonSessionStopped: string;
  leaseReasonSandboxStopped: string;
  leaseReasonSandboxError: string;
  leaseReasonIsolationStopped: string;
  leaseReasonIsolationError: string;
  leaseReasonAgentExited: string;
  leaseReasonAppExiting: string;

  // ── 回执里的固定句子（shared 的租约 / UIA / 交付说明）─────────────────
  leaseTimeout(holderTitle: string): string;
  leaseQueueFull(holderTitle: string, queueLimit: number): string;
  leaseHoldExpired(holdMinutes: number): string;
  leaseRevoked(reason: string): string;
  leaseBusy(holderTitle: string): string;
  uiaFocusRemoved: string;
  isolationNoPointer: string;
  deliveryConfirmed: string;
  deliveryPartial: string;
  deliveryUnverifiable: string;
  deliverySuspectedNoop: string;
  deliveryRefused: string;
  noEvidenceHint: string;
  devBackendRefusal: string;
  /**
   * guest 桥（C#）报了一个认不出的错误：英文界面只给这句通用话，原文进日志
   * （见 main/computer-use/bridge-error-text.ts 的兜底）。
   */
  guestErrorGeneric: string;
  /** 同上，但原文里有网络错误码（`ERR_*`）——那个码是「为什么打不开」的证据，留着 */
  guestErrorGenericCode(code: string): string;
}

/** 文案里带占用者名字的尾巴（与 shared/computer-use.ts 的 holderSuffix 同一份规则） */
function holderSuffix(title: string): string {
  const trimmed = title.trim();
  return trimmed === "" ? "" : `（「${trimmed}」）`;
}

function holderSuffixEn(title: string): string {
  const trimmed = title.trim();
  return trimmed === "" ? "" : ` ("${trimmed}")`;
}

const ACTION_ZH: Record<ComputerUseUiAction, string> = {
  screenshot: "截图",
  windowShot: "按窗口截图",
  windowList: "列窗口",
  uiaList: "列 UIA 控件",
  uiaAct: "操作 UIA 控件",
  pixels: "像素操作",
  browser: "浏览器操作",
};

const ACTION_EN: Record<ComputerUseUiAction, string> = {
  screenshot: "take a screenshot",
  windowShot: "take a window screenshot",
  windowList: "list windows",
  uiaList: "list UIA controls",
  uiaAct: "operate UIA controls",
  pixels: "send pixel input",
  browser: "drive the sandbox browser",
};

const ZH: ComputerUseUiTexts = {
  actionName: (action) => ACTION_ZH[action],

  guidancePlatformDarwin:
    "Windows 沙箱用不上 macOS——这是 Windows 自己的功能，不是 Orbita 还没做。" +
    "macOS 上能用的是浏览器档：内置浏览器里的 browser_navigate / browser_observe / browser_click 等工具不受影响，网页任务照做；" +
    "沙箱里的像素操作与沙箱浏览器（computer_* / sandbox_*）在 macOS 上没有：所有隔离后端（Windows 沙箱、多会话隔离、" +
    "Linux 桌面虚拟机）都建在 Windows 宿主之上，没有可替代的隔离桌面。",
  guidancePlatformOther:
    "电脑使用沙箱只在 Windows 上提供（且需要专业版 / 企业版 / 教育版）；当前平台用不了这些工具。",
  guidanceHomeEdition: "Windows 家庭版没有 Windows 沙箱功能，需要专业版 / 企业版 / 教育版。",
  guidanceEditionUnknown: "读不到 Windows 版本档位（reg query 失败），无法确认沙箱可用。",
  guidanceSandboxFeatureDisabled:
    "Windows 沙箱功能未启用（System32 下找不到 WindowsSandbox.exe）。手动开启：Win+R 输入 optionalfeatures.exe 回车 → " +
    "勾选「Windows 沙箱」→ 确定 → 重启；或在管理员 PowerShell 运行：" +
    'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All。' +
    "Orbita 不会替你执行这条提权命令。",
  guidanceHypervisorConflict:
    "注意：启用 Windows 沙箱会同时打开 Hyper-V 平台。微软明确说明它与第三方虚拟机不兼容——" +
    "这台机器上已有的 VMware / VirtualBox 虚拟机可能起不来或明显变慢（新版本可以用兼容模式，但仍会变慢）。" +
    "还要用它们的话，先在别的机器上启用沙箱，或者做好取舍。",
  guidanceVirtualizationOff:
    "这台机器的虚拟化（VT-x / AMD-V）在 BIOS/UEFI 里被关了，Windows 沙箱起不来。" +
    "重启进 BIOS/UEFI → 打开虚拟化（各厂商名字不同：Intel Virtualization Technology / VT-x、AMD-V / SVM Mode）→ 保存重启后回来重试。" +
    "（Windows 里也可确认：任务管理器 › 性能 › CPU 的「虚拟化」应为「已启用」。）",
  isolationWindowsOnly: (platform) => `多会话隔离只在 Windows 上有（当前平台 ${platform}）`,
  isolationProbeNotWired: "本次没有接 MXC 探测（多会话隔离需要 @microsoft/mxc-sdk）",
  isolationProbeFailed: (cause) => `MXC 探测失败：${cause}`,
  isolationUnavailable: "多会话隔离不可用",
  probeCrashReason: "探测失败",
  probeCrashGuidance: "能力探测失败——看主进程日志",
  isolationBackendUnavailable:
    "这台机器上没有可用的 IsolationSession 后端（Windows 的 IsoSession 服务不在 / 被策略关掉了）",
  mxcNativeLoadFailed: (cause) => `MXC 原生库加载或探测失败：${cause}`,
  mxcProvisionIncomplete: "MXC 的 provision 没有返回 agent 账号与工作区（无法把桥送进会话）",
  nodeTooOld: (version) =>
    `当前 Node ${version} 太旧：MXC 的 native stdio 要求 Node 24.21 以上（或 26.8 以上）。` +
    "Electron 43 自带 24.21.0，够用；开发时把 Electron 降级就会撞上这条。",

  unknownError: "未知错误",
  startFailed: "启动失败",
  startCancelled: "启动已取消",
  sandboxAlreadyStarting: "沙箱已经在启动中",
  sandboxAlreadyRunning: "沙箱已经在运行",
  sandboxAlreadyStopping: "沙箱正在关闭，等它关完再启动",
  sandboxNotRunning: (what, state) =>
    `沙箱没有在运行（当前状态：${state}），${ACTION_ZH[what]}不可用——先在「设置 › 实验功能 › 电脑使用」里启动沙箱`,
  anotherSandboxRunning: (names) =>
    `已经有一只 Windows 沙箱在运行（Windows 同时只允许一只）：${names}。` +
    "如果那是上一只没退干净的，等它自己退（通常 10–20 秒）；一直不退就在任务管理器里结束 " +
    "WindowsSandboxRemoteSession / vmwp.exe / vmmemWindowsSandbox，然后再点一次启动。",
  bridgeExeMissing: (path) => `guest 桥不存在（${path}）——先运行 bun run build:bridge 构建`,
  sandboxExeMissing: (path) =>
    `找不到 ${path}——Windows 沙箱功能可能未启用，先「检测能力」看开启指引`,
  bridgeReadyTimeout: (seconds) =>
    `${seconds} 秒内没等到 guest 桥就绪（bridge.json 未出现）——` +
    "沙箱可能还在启动，或桥启动失败。**如果之前有一只沙箱没退干净，就会一直卡在这里**" +
    "（Windows 同时只允许一只沙箱，旧的那只占着位置、新的一只永远起不来）：" +
    "去任务管理器结束 WindowsSandboxRemoteSession / vmwp.exe / vmmemWindowsSandbox，" +
    "或等它们自己退出（通常 10–20 秒），然后再点一次启动。",
  bridgeWaitTimedOut: (seconds) => `${seconds} 秒内没等到 guest 桥就绪（bridge.json 未出现）——`,
  sandboxWindowClosedEarly: (code) => `沙箱窗口在 guest 桥就绪前就关闭了（exit code ${code}）`,
  wsbLaunchFailed: (cause) => `WindowsSandbox.exe 启动失败：${cause}`,
  sandboxLeftoverVms: (left) =>
    `沙箱没有在 1–2 分钟内退干净（还剩进程 ${left}），宿主里可能留着孤儿 VM（每个约 3~6GB）。` +
    "能手动结束的是 WindowsSandboxRemoteSession / WindowsSandboxServer（任务管理器 → 结束任务）；" +
    "vmwp.exe / vmmemWindowsSandbox 结束不了（拒绝访问），只能等它自己退或重启电脑。" +
    "确认干净后再点一次「停止」复位这个状态。",
  unknownPids: "（观测不到具体 PID）",

  sandboxNotRunningHint: "隔离桌面没有在运行——先在「设置 › 实验功能 › 电脑使用」里启动它",
  sandboxStartingHint:
    "隔离桌面还在启动，桥还没有就绪——这次命令没有执行。等设置页显示「运行中」再试" +
    "（首次启动要一两分钟；超时可以点停止再启动）",
  sandboxStoppingHint: "隔离桌面正在关闭，这次命令没有执行。等它关完再启动后再试",
  sandboxErrorStateHint:
    "隔离桌面处于错误状态、没有在运行——这次命令没有执行。先去「设置 › 实验功能 › 电脑使用」里" +
    "点停止复位、再启动；起不来时看设置页那几行提示",
  sandboxNotImplemented: "这个隔离后端还没接上（P3-2 才实现）",

  isolationStartingOrStopping: "隔离会话正在启动或停止中，等它结束再试",
  isolationBridgeNoAnnouncement: "隔离会话起来了，但桥没有通告（等 bridge.json 超时）——看会话里的 bridge.log",
  isolationBridgePingFailed: (message) => `桥起来了但命令通道 ping 不通：${message}`,
  isolationBridgeNotAnnounced: (logPath, tail) =>
    `隔离会话起来了，但会话里的桥没把 bridge.json 写出来。` +
    `先看会话里的 ${logPath}` +
    (tail === null ? "（这次连日志都没生成：launcher 没跑起来，检查工作区写入权限）" : `，最后几行：${tail}`),
  isolationBridgeLogMissing: "（这次连日志都没生成：launcher 没跑起来，检查工作区写入权限）",
  isolationBridgeLogTail: (tail) => `，最后几行：${tail}`,
  isolationBridgeExeMissing: (source) => `宿主的桥 exe 不在：${source}（先跑 node guest-bridge/build.mjs）`,
  isolationWorkspaceWriteFailed: (workspacePath, message) =>
    `写不进会话工作区（${workspacePath}）：${message}。` +
    "工作区在会话账号的 profile 下，宿主需要管理员权限才能写——确认运行 Orbita 的账号在管理员组里",
  isolationStopSessionFailed: (cause) => `停会话失败：${cause}`,
  isolationReleaseFailed: (cause) => `释放会话失败（账号与工作区可能还在）：${cause}`,
  isolationResidue: (left) => `会话已释放，但这些残留还在：${left}（可能要注销后才删得掉；重启一次应用会再试）`,
  isolationNoWorkspace: "隔离会话没有工作区（未在运行）",
  isolationUnknownReason: "未知原因",
  isolationNotRunning: (what, state) =>
    state === "off"
      ? `隔离会话没有在运行——先启动它，再${ACTION_ZH[what]}`
      : `隔离会话正在${state === "starting" ? "启动" : "停止"}，等它结束再${ACTION_ZH[what]}`,
  isolationErrorState: (reason) => `隔离会话出错了（${reason}）——先停止并重新启动`,
  isolationBusy: (what, starting) =>
    `隔离会话正在${starting ? "启动" : "停止"}，等它结束再${ACTION_ZH[what]}`,

  bridgeWindowShotShape:
    "guest 桥的窗口截图响应缺字段（width / height / nativeWidth / nativeHeight / hwnd / title / jpeg）",
  bridgeWindowListShape: "guest 桥的窗口列表响应缺 windows 数组",
  bridgeUiaListHwnd: "guest 桥的 UIA 控件列表响应缺 hwnd",
  bridgeUiaListItems: "guest 桥的 UIA 控件列表响应缺 items 数组",
  bridgeUiaListGeneration:
    "guest 桥的 UIA 控件列表响应缺 generation（桥低于 0.14.0？ref 没有代次就没法判断旧 ref）",
  bridgeUiaActHwnd: "guest 桥的 UIA 动作响应缺 hwnd",
  bridgeUiaActAction: "guest 桥的 UIA 动作响应缺 action（或动作名不认识）",
  bridgeUiaActPattern: "guest 桥的 UIA 动作响应缺 usedPattern",
  bridgePingShape: "guest 桥的 ping 响应畸形",
  bridgeShotShape: "guest 桥的截图响应缺字段（width / height / nativeWidth / nativeHeight / jpeg）",
  bridgeJpegMissing: (command) => `guest 桥的 ${command} 响应缺 jpeg（TCP 回执里也没有 jpegBase64）`,
  bridgeJpegFieldMissing: (command) => `guest 桥的 ${command} 响应缺 jpeg 字段（应是兄弟文件名）`,
  bridgeJpegNameInvalid: (name) => `guest 桥回了非法的截图文件名：${name}`,
  bridgeJpegFileMissing: "guest 桥的响应引用的 JPEG 文件不存在",
  bridgeNoReason: "guest 桥执行失败（没给原因）",
  tcpConnectError: (cause) => `连接出错：${cause}`,
  tcpClosed: "连接被关",
  tcpHelloFail: "桥回 hello-fail（令牌不符）",
  tcpHelloUnexpected: (type) => `桥的握手回执异常：${type}`,
  tcpReadTimeout: (ms) => `读回执超时（${ms}ms）`,
  tcpWriteFailed: "写入失败",
  tcpClientClosed: "客户端关闭连接",
  tcpHelloTimeout: (ms) => `握手超时（${ms}ms）`,
  tcpFrameTooLarge: "单帧超过 16MB",
  tcpConnectFailed: (reason) => `连接失败：${reason}`,
  tcpConnectTimeout: (ms) => `连接超时（${ms}ms）`,
  tcpHandshakeFailed: (address, why) => `${address} 握手失败：${why}`,
  tcpNoAddresses: "bridge.json 的 ipv4 是空的",
  tcpReplyMalformed: "回执缺 resp 或 ok 字段",
  tcpChannelBroke: (command, cause) =>
    `沙箱的命令通道中断了（${command} 走 TCP 时${cause}）——` +
    "下一条命令起会自动走文件通道；可以直接重试，或先用 computer_screenshot 确认桌面还在不在",
  guestBrowserTimeout: (command, budget) =>
    `沙箱里的浏览器没有响应（${command} 超时 ${budget}）——可能是浏览器卡住了：` +
    "用 cdp-status 确认会话状态，或改用 computer_screenshot / computer_click 像素工具",
  guestDesktopTimeout: (command, budget) =>
    `沙箱里的桌面没有响应（${command} 超时 ${budget}）——也许是沙箱卡住了或正在重置：` +
    "先用 computer_screenshot 确认桌面状态，必要时重启沙箱",

  browserNoPage:
    "沙箱里的浏览器还没有打开任何页面。先调用 sandbox_navigate 打开一个网址——它会把 Edge 拉起来，" +
    "之后 sandbox_observe / sandbox_click 才能用。CDP 起不来时再退回 computer_screenshot 像素工具",
  browserUploadNotFound: (path) => `找不到要上传的文件：${path}`,
  browserUploadNotFile: (path) => `这不是一个文件：${path}`,
  browserUploadEmpty: (path) => `这个文件是空的（0 字节）：${path}`,
  browserUploadBadName: (path) => `文件名不可用：${path}`,
  browserShotShape: "cdp-shot 的回执缺尺寸字段（width / height / nativeWidth / nativeHeight）",
  internalWrongLane: (action, lane) => `内部错误：${action} 不该进 ${lane} 这一层。`,
  tooManyBrowsers: (max) => computerUseBrowserErrors.tooMany(max),

  qemuRefuseUia:
    "这个隔离后端（L3 Linux 桌面 VM）没有 UI Automation 控件树：Linux 侧的等价物是 AT-SPI，" +
    "本版没接。改用 computer_screenshot 看清界面，再用 computer_click / computer_type 按图像坐标操作——" +
    "点之前先截图，点之后立刻再截一张确认结果。",
  qemuRefuseWindowShot:
    "这个后端只能整桌面截图：Linux guest 里没有 PrintWindow 的对等物，按窗口拍只能拍到屏幕上那块像素" +
    "（被别的窗口遮住时拍到的是遮挡者）。请用不带 window 的 computer_screenshot，坐标就是整屏像素。",
  qemuRefuseCdp:
    "这个后端还没接浏览器调试车道（sandbox_*）：L3 的 guest 里有 chromium，但调试口与 sandbox_* 的接线还没做。" +
    "网页自动化请用内置浏览器，或者在这台桌面上走 computer_* 的像素路径（截图 + 点击 + 打字）。",
  qemuStarting: "L3 桌面 VM 正在启动，稍等几秒再试",
  qemuStopFailed: (cause) => `停 L3 桌面 VM 时出错：${cause}`,
  qemuListFailed: "列窗口失败",
  qemuWindowListShape: "guest 的窗口清单格式不对（windows 不是数组）",
  qemuClickMissing: "click 缺 x / y（沙箱物理像素）",
  qemuTypeEmpty: "type 的 text 是空的",
  qemuTypeFailed: "打字失败",
  qemuKeyEmpty: "key 的按键名是空的",
  qemuKeyFailed: "按键失败",
  qemuScrollMissing: "scroll 缺 x / y / deltaY",
  qemuUnknownCommand: (command, supported) =>
    `这个隔离后端（L3 Linux 桌面 VM）不认命令 ${command}：它只接了 ` +
    `${supported}（外加截图与 win-list）。` +
    "UIA 控件树、按窗口截图、CDP 浏览器车道在这个后端都没有，详见 capabilities。",
  qemuGuestTimeout: (ms, port) => `guest 服务 ${ms}ms 没有回应（127.0.0.1:${port}）`,
  qemuGuestUnreachable: (port, reason) =>
    `L3 桌面 VM 里的服务没有应答（宿主 127.0.0.1:${port}）：${reason}。` +
    "这台 VM 可能没起来、已经退出，或者 guest 里的 orbita-desk 服务没启动" +
    "（日志在镜像目录的 logs/ 下：qemu-*.log 与 serial-*.log）。",
  qemuGuestHttp: (status, port) => `guest 服务回了 HTTP ${status}（127.0.0.1:${port}）`,
  qemuGuestNotJson: (snippet) => `guest 服务的回执不是 JSON：${snippet}`,
  qemuGuestNotObject: "guest 服务的回执不是对象",
  qemuGuestRefusedNoReason: "guest 服务拒绝了这条命令（没有给原因）",
  qemuShotHttp: (status) => `guest 服务回了 HTTP ${status}（要截图时）`,
  qemuNoShot: (reason) => `guest 没给出截图：${reason}`,
  qemuShotBadPng: "guest 回的截图不是合法 PNG（PNG 头不对）",
  qemuNoFreePorts: (range) => `没有空闲端口（在 ${range} 找三个）`,
  qemuVmFilesMissing: (missing) =>
    `L3 镜像或 QEMU 不全，缺：${missing}。` +
    "先在仓里跑 scripts/p3-desktop/build-ramdisk.mjs 与 build-image.mjs（产物在仓外，别拷进仓）。",
  qemuSpawnNoPid: "QEMU 没起来（spawn 没有 pid）",
  qemuMonitorTimeout: "QEMU monitor 超时",
  qemuWaitNotTried: "还没试过",
  qemuWaitCancelled: "等 guest 服务就绪时被取消",
  qemuDesktopWrongSize: "桌面尺寸不对",
  qemuDesktopNotUp: "桌面还没起来（xfwm4 不在）",
  qemuNoReason: "没有原因",
  qemuWaitTimeout: (seconds, lastError) => `等不到 L3 桌面服务（${seconds}s）：${lastError}`,
  rfbClosed: "RFB 连接已断开",
  rfbUnreachable: (port) => `连不上 guest 的 RFB（127.0.0.1:${port}）`,
  rfbNotRfb: (version) => `不是 RFB 服务：${version}`,
  rfbRefused: "RFB 服务拒绝了连接",
  rfbAuthTypes: (types) =>
    `guest 的 RFB 只接受 None 认证之外的方案（${types}），本机镜像应该用 -SecurityTypes None`,
  rfbNoneRejected: "RFB 的 None 认证被拒（SecurityResult != 0）",

  backendSwitchStopFailed: (backend, error) => `切换后端前停不掉 ${backend}：${error}`,
  emergencyHotkeyTaken: (attempts) =>
    `急停快捷键 ${attempts} 都被其它应用占用，急停不可用——请关掉占用这些组合的应用后重启本应用`,
  emergencyNotWired: "急停没有接线（主进程未注册热键）",
  leaseReasonSessionStopped: "会话已停止",
  leaseReasonSandboxStopped: "沙箱已停止",
  leaseReasonSandboxError: "沙箱出错",
  leaseReasonIsolationStopped: "隔离会话已停止",
  leaseReasonIsolationError: "隔离会话出错",
  leaseReasonAgentExited: "agent 进程退出",
  leaseReasonAppExiting: "应用退出",

  leaseTimeout: (title) => computerUseLeaseErrors.timeout(title),
  leaseQueueFull: (title, limit) => computerUseLeaseErrors.queueFull(title, limit),
  leaseHoldExpired: (minutes) => computerUseLeaseErrors.holdExpired(minutes),
  leaseRevoked: (reason) => computerUseLeaseErrors.revoked(reason),
  leaseBusy: (title) => computerUseLeaseErrors.busy(title),
  uiaFocusRemoved: computerUseUiaErrors.focusRemoved,
  isolationNoPointer: computerUseIsolationErrors.noPointer,
  deliveryConfirmed: "读回证据对上了，动作已经生效，可以继续下一步。",
  deliveryPartial:
    "只完成了一部分（剩下的输入事件没有送出去）：先截一张图（computer_screenshot）确认现在的状态，" +
    "再决定补哪几步；不要原样重放整条动作（会重复前半段）。",
  deliveryUnverifiable:
    "已经发出去了，但没拿到生效证据：先截一张图（computer_screenshot）看一眼再决定下一步，不要立刻重放同一个动作（会变成双击或双份文字）。",
  deliverySuspectedNoop:
    "有读回，但读回的值没变：大概率没生效，换个做法（比如改用 UIA 命中或换坐标），不要原样重试。",
  deliveryRefused: "没有发出去（参数不合法、发送失败或后端明确拒绝）：可以修参数后重试。",
  noEvidenceHint: COMPUTER_USE_NO_EVIDENCE_HINT,
  devBackendRefusal: computerUseDevBackendRefusal(),
  guestErrorGeneric: "沙箱报了一个错误，细节见应用日志。",
  guestErrorGenericCode: (code) => `沙箱报了一个错误（${code}），细节见应用日志。`,
};

const EN: ComputerUseUiTexts = {
  actionName: (action) => ACTION_EN[action],

  guidancePlatformDarwin:
    "The Windows Sandbox is not available on macOS — it is a Windows feature, not something Orbita has left " +
    "undone. On macOS the browser lane still works: browser_navigate, browser_observe, browser_click and the " +
    "other tools that drive the built-in browser are unaffected, so web tasks are fine. The pixel tools and the " +
    "sandboxed browser (computer_* / sandbox_*) are not available on macOS: every isolation backend (Windows " +
    "Sandbox, the isolated Windows session, the Linux desktop VM) is built on a Windows host, and there is no " +
    "substitute isolated desktop.",
  guidancePlatformOther:
    "The computer-use sandbox is only available on Windows (and needs Pro, Enterprise or Education). These tools " +
    "cannot run on this platform.",
  guidanceHomeEdition:
    "Windows Home has no Windows Sandbox feature; it needs Windows Pro, Enterprise or Education.",
  guidanceEditionUnknown:
    "Could not read the Windows edition (the reg query failed), so whether the sandbox works is unknown.",
  guidanceSandboxFeatureDisabled:
    "The Windows Sandbox feature is not enabled (WindowsSandbox.exe is missing from System32). To turn it on " +
    "yourself: press Win+R, run optionalfeatures.exe, tick \"Windows Sandbox\", click OK, then restart. Or run " +
    "this in an elevated PowerShell: " +
    'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All. ' +
    "Orbita will not run that elevated command for you.",
  guidanceHypervisorConflict:
    "Note: enabling Windows Sandbox also turns on the Hyper-V platform. Microsoft states plainly that Hyper-V is " +
    "incompatible with third-party virtual machines — VMware or VirtualBox VMs already on this machine may stop " +
    "booting or get noticeably slower (newer versions can run in a compatibility mode, but still slower). If you " +
    "still need them, enable the sandbox on another machine, or accept the trade-off.",
  guidanceVirtualizationOff:
    "Hardware virtualization (VT-x / AMD-V) is disabled in this machine's BIOS/UEFI, so the Windows Sandbox cannot " +
    "start. Reboot into BIOS/UEFI, turn virtualization on (the setting is named differently per vendor: Intel " +
    "Virtualization Technology / VT-x, AMD-V / SVM Mode), save and reboot, then try again. You can also confirm it " +
    "in Windows: Task Manager › Performance › CPU should show Virtualization: Enabled.",
  isolationWindowsOnly: (platform) => `The isolated session backend only exists on Windows (this platform is ${platform})`,
  isolationProbeNotWired: "The MXC probe was not wired up this time (the isolated session needs @microsoft/mxc-sdk)",
  isolationProbeFailed: (cause) => `The MXC probe failed: ${cause}`,
  isolationUnavailable: "The isolated session is not available",
  probeCrashReason: "The probe failed",
  probeCrashGuidance: "The capability probe failed — see the main-process log",
  isolationBackendUnavailable:
    "This machine has no usable IsolationSession backend (Windows' IsoSession service is missing or blocked by policy)",
  mxcNativeLoadFailed: (cause) => `The MXC native library failed to load or probe: ${cause}`,
  mxcProvisionIncomplete: "MXC provision returned no agent account and no workspace (so the bridge cannot be staged into the session)",
  nodeTooOld: (version) =>
    `Node ${version} is too old: MXC's native stdio needs Node 24.21 or newer (or 26.8+). Electron 43 ships ` +
    "24.21.0, which is fine; downgrading Electron in development hits this.",

  unknownError: "Unknown error",
  startFailed: "Start failed",
  startCancelled: "Start cancelled",
  sandboxAlreadyStarting: "The sandbox is already starting",
  sandboxAlreadyRunning: "The sandbox is already running",
  sandboxAlreadyStopping: "The sandbox is shutting down; start it again once it has closed",
  sandboxNotRunning: (what, state) =>
    `The sandbox is not running (current state: ${state}), so you cannot ${ACTION_EN[what]} — start it in ` +
    "Settings › Experimental features › Computer use first",
  anotherSandboxRunning: (names) =>
    `Another Windows Sandbox is already running (Windows allows one at a time): ${names}. If that is an earlier ` +
    "sandbox that never shut down, give it 10–20 seconds to exit on its own; if it never does, end " +
    "WindowsSandboxRemoteSession / vmwp.exe / vmmemWindowsSandbox in Task Manager, then press Start again.",
  bridgeExeMissing: (path) => `The guest bridge is missing (${path}) — build it first with bun run build:bridge`,
  sandboxExeMissing: (path) =>
    `${path} was not found — the Windows Sandbox feature is probably not enabled; run “Check capability” for the ` +
    "setup instructions",
  bridgeReadyTimeout: (seconds) =>
    `The guest bridge did not become ready within ${seconds} seconds (bridge.json never appeared). The sandbox may ` +
    "still be starting, or the bridge failed to start. **If an earlier sandbox never shut down, it will hang " +
    "here forever** (Windows allows one sandbox at a time: the old one holds the slot and a new one can never " +
    "boot). End WindowsSandboxRemoteSession / vmwp.exe / vmmemWindowsSandbox in Task Manager, or wait for them to " +
    "exit on their own (usually 10–20 seconds), then press Start again.",
  bridgeWaitTimedOut: (seconds) =>
    `The guest bridge did not become ready within ${seconds} seconds (bridge.json never appeared). `,
  sandboxWindowClosedEarly: (code) => `The sandbox window closed before the guest bridge was ready (exit code ${code})`,
  wsbLaunchFailed: (cause) => `WindowsSandbox.exe failed to start: ${cause}`,
  sandboxLeftoverVms: (left) =>
    `The sandbox did not shut down cleanly within 1–2 minutes (processes still running: ${left}), so an orphaned VM ` +
    "may still be on the host (3–6 GB each). WindowsSandboxRemoteSession / WindowsSandboxServer can be ended by " +
    "hand (Task Manager › End task); vmwp.exe / vmmemWindowsSandbox cannot (access denied) — they only go away on " +
    "their own or after a reboot. Once it is clean, press Stop once to reset this state.",
  unknownPids: "(no PID could be observed)",

  sandboxNotRunningHint: "The isolated desktop is not running — start it in Settings › Experimental features › Computer use",
  sandboxStartingHint:
    "The isolated desktop is still starting and its bridge is not ready yet, so this command did not run. Wait " +
    "until Settings shows it as running (the first start takes a minute or two; if it times out, press Stop and " +
    "then Start again)",
  sandboxStoppingHint:
    "The isolated desktop is shutting down, so this command did not run. Start it again once it has finished closing",
  sandboxErrorStateHint:
    "The isolated desktop is in an error state and is not running, so this command did not run. Go to Settings › " +
    "Experimental features › Computer use, press Stop to reset it, then start it again; if it will not start, read " +
    "the notes on that settings page",
  sandboxNotImplemented: "This isolation backend is not connected yet (it lands in P3-2)",

  isolationStartingOrStopping: "The isolated session is starting or stopping; try again once it has finished",
  isolationBridgeNoAnnouncement:
    "The isolated session came up, but its bridge never announced itself (timed out waiting for bridge.json) — " +
    "check bridge.log inside the session",
  isolationBridgePingFailed: (message) => `The bridge started but its command channel does not answer ping: ${message}`,
  isolationBridgeNotAnnounced: (logPath, tail) =>
    "The isolated session came up, but the bridge inside it never wrote bridge.json. Look at " +
    `${logPath} inside the session` +
    (tail === null
      ? " (not even that log exists this time: the launcher never ran — check write access to the workspace)"
      : `; its last lines: ${tail}`),
  isolationBridgeLogMissing:
    " (not even that log exists this time: the launcher never ran — check write access to the workspace)",
  isolationBridgeLogTail: (tail) => `; its last lines: ${tail}`,
  isolationBridgeExeMissing: (source) =>
    `The host's bridge executable is missing: ${source} (run node guest-bridge/build.mjs first)`,
  isolationWorkspaceWriteFailed: (workspacePath, message) =>
    `Could not write into the session workspace (${workspacePath}): ${message}. The workspace lives under the ` +
    "session account's profile, so the host needs administrator rights to write there — make sure the account " +
    "running Orbita is in the Administrators group",
  isolationStopSessionFailed: (cause) => `Stopping the session failed: ${cause}`,
  isolationReleaseFailed: (cause) => `Releasing the session failed (its account and workspace may still exist): ${cause}`,
  isolationResidue: (left) =>
    `The session has been released, but this is still on disk: ${left} (it may only disappear after signing out; ` +
    "restarting the app will retry)",
  isolationNoWorkspace: "The isolated session has no workspace (it is not running)",
  isolationUnknownReason: "unknown reason",
  isolationNotRunning: (what, state) =>
    state === "off"
      ? `The isolated session is not running — start it, then ${ACTION_EN[what]}`
      : `The isolated session is ${state === "starting" ? "starting" : "stopping"}; once it has finished, ${ACTION_EN[what]}`,
  isolationErrorState: (reason) =>
    `The isolated session is in an error state (${reason}) — stop it and start it again`,
  isolationBusy: (what, starting) =>
    `The isolated session is ${starting ? "starting" : "stopping"}; once it has finished, ${ACTION_EN[what]}`,

  bridgeWindowShotShape:
    "The guest bridge's window screenshot reply is missing fields (width / height / nativeWidth / nativeHeight / " +
    "hwnd / title / jpeg)",
  bridgeWindowListShape: "The guest bridge's window list reply has no windows array",
  bridgeUiaListHwnd: "The guest bridge's UIA control list reply has no hwnd",
  bridgeUiaListItems: "The guest bridge's UIA control list reply has no items array",
  bridgeUiaListGeneration:
    "The guest bridge's UIA control list reply has no generation (bridge older than 0.14.0? without a generation " +
    "a stale ref cannot be told apart)",
  bridgeUiaActHwnd: "The guest bridge's UIA action reply has no hwnd",
  bridgeUiaActAction: "The guest bridge's UIA action reply has no action (or an unknown action name)",
  bridgeUiaActPattern: "The guest bridge's UIA action reply has no usedPattern",
  bridgePingShape: "The guest bridge's ping reply is malformed",
  bridgeShotShape:
    "The guest bridge's screenshot reply is missing fields (width / height / nativeWidth / nativeHeight / jpeg)",
  bridgeJpegMissing: (command) =>
    `The guest bridge's ${command} reply has no jpeg (and the TCP reply carried no jpegBase64)`,
  bridgeJpegFieldMissing: (command) =>
    `The guest bridge's ${command} reply has no jpeg field (it should be the sibling file name)`,
  bridgeJpegNameInvalid: (name) => `The guest bridge returned an invalid screenshot file name: ${name}`,
  bridgeJpegFileMissing: "The JPEG file referenced by the guest bridge's reply does not exist",
  bridgeNoReason: "The guest bridge reported a failure without a reason",
  tcpConnectError: (cause) => `the connection failed: ${cause}`,
  tcpClosed: "the connection was closed",
  tcpHelloFail: "the bridge answered hello-fail (token mismatch)",
  tcpHelloUnexpected: (type) => `the bridge's handshake reply was unexpected: ${type}`,
  tcpReadTimeout: (ms) => `reading the reply timed out (${ms}ms)`,
  tcpWriteFailed: "the write failed",
  tcpClientClosed: "the client closed the connection",
  tcpHelloTimeout: (ms) => `the handshake timed out (${ms}ms)`,
  tcpFrameTooLarge: "a single frame exceeded 16MB",
  tcpConnectFailed: (reason) => `connect failed: ${reason}`,
  tcpConnectTimeout: (ms) => `connect timed out (${ms}ms)`,
  tcpHandshakeFailed: (address, why) => `${address}: handshake failed: ${why}`,
  tcpNoAddresses: "bridge.json lists no ipv4 address",
  tcpReplyMalformed: "the reply has no resp / ok field",
  tcpChannelBroke: (command, cause) =>
    `The sandbox's command channel broke (${command} over TCP: ${cause}). The next command will use the file ` +
    "channel automatically; you can retry right away, or take a computer_screenshot first to confirm the desktop " +
    "is still there",
  guestBrowserTimeout: (command, budget) =>
    `The browser in the sandbox did not answer (${command} timed out after ${budget}) — it may be stuck: use ` +
    "cdp-status to check the session, or switch to the pixel tools computer_screenshot / computer_click",
  guestDesktopTimeout: (command, budget) =>
    `The desktop in the sandbox did not answer (${command} timed out after ${budget}) — the sandbox may be stuck ` +
    "or resetting: take a computer_screenshot to check the desktop, and restart the sandbox if needed",

  browserNoPage:
    "The sandbox browser has not opened any page yet. Call sandbox_navigate with a URL first — that starts Edge, " +
    "and only then do sandbox_observe / sandbox_click work. If CDP cannot start, fall back to the pixel tools " +
    "(computer_screenshot).",
  browserUploadNotFound: (path) => `The file to upload was not found: ${path}`,
  browserUploadNotFile: (path) => `That is not a file: ${path}`,
  browserUploadEmpty: (path) => `That file is empty (0 bytes): ${path}`,
  browserUploadBadName: (path) => `The file name is unusable: ${path}`,
  browserShotShape:
    "The cdp-shot reply is missing size fields (width / height / nativeWidth / nativeHeight)",
  internalWrongLane: (action, lane) => `Internal error: ${action} must not reach the ${lane} layer.`,
  tooManyBrowsers: (max) =>
    `The sandbox can run at most ${max} browsers at once; stop one with cdp-stop before starting another (an idle ` +
    `instance is reclaimed after ${Math.round(COMPUTER_USE_BROWSER_IDLE_MS / 60_000)} minutes). If you only want ` +
    "a different page, open it with sandbox_navigate instead of starting another instance.",

  qemuRefuseUia:
    "This isolation backend (the L3 Linux desktop VM) has no UI Automation control tree: the Linux equivalent is " +
    "AT-SPI, which is not wired up in this version. Use computer_screenshot to see the interface, then " +
    "computer_click / computer_type with image coordinates — screenshot before clicking, and screenshot again " +
    "right after to confirm the result.",
  qemuRefuseWindowShot:
    "This backend can only capture the whole desktop: a Linux guest has no PrintWindow equivalent, so a " +
    "window capture would only grab those pixels off the screen (and would capture whatever covers the window). " +
    "Use computer_screenshot without window; its coordinates are whole-screen pixels.",
  qemuRefuseCdp:
    "This backend has no browser debugging lane yet (sandbox_*): the L3 guest does run chromium, but the wiring " +
    "between its debug port and sandbox_* is not done. Use the built-in browser for web automation, or drive this " +
    "desktop through the computer_* pixel path (screenshot + click + type).",
  qemuStarting: "The L3 desktop VM is starting; try again in a few seconds",
  qemuStopFailed: (cause) => `Stopping the L3 desktop VM failed: ${cause}`,
  qemuListFailed: "Listing windows failed",
  qemuWindowListShape: "The guest's window list is malformed (windows is not an array)",
  qemuClickMissing: "click is missing x / y (sandbox physical pixels)",
  qemuTypeEmpty: "type was given empty text",
  qemuTypeFailed: "Typing failed",
  qemuKeyEmpty: "key was given an empty key name",
  qemuKeyFailed: "Pressing the key failed",
  qemuScrollMissing: "scroll is missing x / y / deltaY",
  qemuUnknownCommand: (command, supported) =>
    `This isolation backend (the L3 Linux desktop VM) does not support the command ${command}: it only takes ` +
    `${supported} (plus screenshots and win-list). It has no UIA control tree, no per-window screenshot and no CDP ` +
    "browser lane; see capabilities.",
  qemuGuestTimeout: (ms, port) => `The guest service did not answer within ${ms}ms (127.0.0.1:${port})`,
  qemuGuestUnreachable: (port, reason) =>
    `The service inside the L3 desktop VM did not answer (host 127.0.0.1:${port}): ${reason}. The VM may not have ` +
    "booted, may have exited, or the orbita-desk service inside the guest is not running (its logs are under logs/ " +
    "in the image directory: qemu-*.log and serial-*.log).",
  qemuGuestHttp: (status, port) => `The guest service answered HTTP ${status} (127.0.0.1:${port})`,
  qemuGuestNotJson: (snippet) => `The guest service's reply is not JSON: ${snippet}`,
  qemuGuestNotObject: "The guest service's reply is not an object",
  qemuGuestRefusedNoReason: "The guest service refused the command without a reason",
  qemuShotHttp: (status) => `The guest service answered HTTP ${status} (while capturing a screenshot)`,
  qemuNoShot: (reason) => `The guest did not produce a screenshot: ${reason}`,
  qemuShotBadPng: "The guest's screenshot is not a valid PNG (bad PNG header)",
  qemuNoFreePorts: (range) => `No free ports (needed three in ${range})`,
  qemuVmFilesMissing: (missing) =>
    `The L3 image or QEMU is incomplete; missing: ${missing}. Run scripts/p3-desktop/build-ramdisk.mjs and ` +
    "build-image.mjs in the repository first (their output lives outside the repository; do not copy it in).",
  qemuSpawnNoPid: "QEMU did not start (spawn returned no pid)",
  qemuMonitorTimeout: "The QEMU monitor timed out",
  qemuWaitNotTried: "not tried yet",
  qemuWaitCancelled: "Waiting for the guest service was cancelled",
  qemuDesktopWrongSize: "The desktop size is wrong",
  qemuDesktopNotUp: "The desktop is not up yet (xfwm4 is not running)",
  qemuNoReason: "no reason given",
  qemuWaitTimeout: (seconds, lastError) => `The L3 desktop service did not come up within ${seconds}s: ${lastError}`,
  rfbClosed: "The RFB connection was closed",
  rfbUnreachable: (port) => `Cannot reach the guest's RFB server (127.0.0.1:${port})`,
  rfbNotRfb: (version) => `Not an RFB server: ${version}`,
  rfbRefused: "The RFB server refused the connection",
  rfbAuthTypes: (types) =>
    `The guest's RFB server only accepts security types other than None (${types}); the local image should use ` +
    "-SecurityTypes None",
  rfbNoneRejected: "The RFB None authentication was rejected (SecurityResult != 0)",

  backendSwitchStopFailed: (backend, error) => `Could not stop ${backend} before switching backends: ${error}`,
  emergencyHotkeyTaken: (attempts) =>
    `Every emergency-stop hotkey (${attempts}) is taken by another application, so emergency stop is unavailable — ` +
    "close the applications holding those combinations and restart this application",
  emergencyNotWired: "Emergency stop is not wired up (the main process never registered the hotkey)",
  leaseReasonSessionStopped: "the session was stopped",
  leaseReasonSandboxStopped: "stopped",
  leaseReasonSandboxError: "the sandbox reported an error",
  leaseReasonIsolationStopped: "stopped",
  leaseReasonIsolationError: "the isolated session reported an error",
  leaseReasonAgentExited: "the agent process exited",
  leaseReasonAppExiting: "the app is quitting",

  leaseTimeout: (title) =>
    `Another session currently holds the sandbox desktop${holderSuffixEn(title)}; this call waited ` +
    `${COMPUTER_USE_LEASE.waitMs / 1000} seconds without getting it. Do not retry: another computer_* / sandbox_* ` +
    "call from this side would only wait another round. Try again after that session's turn ends, or ask the user " +
    "which session should be driving the sandbox.",
  leaseQueueFull: (title, queueLimit) =>
    `Another session currently holds the sandbox desktop${holderSuffixEn(title)}, and the queue waiting for it has ` +
    `reached its limit (${queueLimit}). Do not retry: ask the user to stop the other sessions first, or to decide ` +
    "which session should be driving the sandbox.",
  leaseHoldExpired: (holdMinutes) =>
    `This session has held the sandbox desktop for more than ${holdMinutes} minutes, so control was taken back and ` +
    "this command was not sent. Do not retry: tell the user that control was taken back, and let them decide who " +
    "drives the sandbox next if the work should continue.",
  leaseRevoked: (reason) =>
    `The sandbox was closed (${reason}), so all control was revoked and this command was not sent. Do not retry: ` +
    "restart the sandbox in Settings › Experimental features › Computer use, then start over.",
  leaseBusy: (title) =>
    `This channel is now held by another session${holderSuffixEn(title)}; this operation does not queue, so the ` +
    "command was not sent. Do not retry: wait until that session's turn ends.",
  uiaFocusRemoved:
    "The focus action has been removed: Element.SetFocus moves the keyboard focus of the whole desktop, which " +
    "contradicts the UIA lane's premise that it does not touch the desktop. To move focus, click the target " +
    "control with computer_click, or use invoke (which usually focuses it too) / setValue (which needs no focus).",
  isolationNoPointer:
    "This isolation tier (isolated session / L2b) has no real mouse or keyboard: the session is RDP-shaped, so " +
    "SendInput returns success while the pointer never moves. Pixel click / type / key / scroll are therefore " +
    "never sent. Use instead: uia-list + uia-act (Win32 controls and most desktop applications), sandbox_* (the " +
    "browser, over CDP), or screenshot + window to look at the current state. Do not retry the same pixel action.",
  deliveryConfirmed: "The read-back matched, so the action took effect. You can continue.",
  deliveryPartial:
    "Only part of it went through (the remaining input events were not sent): take a screenshot " +
    "(computer_screenshot) to see the current state, then decide which steps to add. Do not replay the whole " +
    "action as-is (that would repeat the first half).",
  deliveryUnverifiable:
    "It was sent, but there is no evidence it took effect: take a screenshot (computer_screenshot) and look " +
    "before deciding the next step. Do not immediately repeat the same action (that would turn it into a double " +
    "click or duplicate text).",
  deliverySuspectedNoop:
    "The read-back succeeded but the value did not change, so it most likely did nothing: change the approach " +
    "(for example hit it through UIA, or use different coordinates) instead of retrying as-is.",
  deliveryRefused:
    "It was not sent (invalid arguments, the send failed, or the backend refused): fix the arguments and retry.",
  noEvidenceHint:
    " This backend can never produce any read-back (no control tree and no per-window screenshot), so this action " +
    "will never be confirmed automatically: after it, take a computer_screenshot to confirm the result, and only " +
    "then decide the next step.",
  devBackendRefusal:
    "This is a developer backend (the Linux desktop VM / L3) and is off by default: it needs your own QEMU and a " +
    "Linux desktop image (run scripts/p3-desktop/build-image.mjs and scripts/p3-desktop/build-ramdisk.mjs in the " +
    "repository), and it only does screenshots, clicks and typing — no UIA control tree, no browser debug port, no " +
    "host file mapping, no snapshots. To enable it, start this application with the environment variable " +
    `${COMPUTER_USE_DEV_BACKENDS_ENV}=1 and then start it again.`,
  guestErrorGeneric: "The sandbox reported an error. Details are in the application log.",
  guestErrorGenericCode: (code) =>
    `The sandbox reported an error (${code}). Details are in the application log.`,
};

/**
 * 界面语言 → 那份文案。认不出的取值（缺省 / 脏数据）按**英文**——与 `effectiveLanguage`
 * 的兜底一致（界面缺省就是英文）。
 *
 * 注意：这里只做「取哪一份」，不做「现在是什么语言」的判断——那个由主进程按
 * `settings.language` 决定（见 main/computer-use/ui-language.ts）。
 */
export function computerUseUiTexts(language: string | undefined): ComputerUseUiTexts {
  return language === "zh" ? ZH : EN;
}
