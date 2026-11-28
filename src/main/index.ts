/**
 * 主进程入口。职责边界（AGENTS.md「架构边界」）：只负责窗口、IPC 与持久化。
 * agent runtime 将跑在独立 utility 进程，不在这里 —— 见 docs/single-agent-guideline.md §二。
 */
import { OutboxStore } from "./session/outbox.ts";
import { registerOutboxIpc } from "./session/outbox-ipc.ts";
import { broadcastAvatarJob, loadSurface, registerAvatarIpc, registerPlanetIpc } from "./planet/ipc.ts";
import { AVATAR_PLUGIN, AVATAR_SKILL, AvatarJobs, execPluginScript } from "./planet/avatar.ts";
import { SubAgentStore } from "./planet/sub-agents.ts";
import { applySubAgentRequest } from "./planet/sub-agent-requests.ts";
import { preferIPv4 } from "../shared/dial-v4.ts";
import { CATALOG_CACHE_ENV } from "../shared/agent-ipc.ts";
import { catalogIdsOfProviders } from "../shared/known-providers.ts";
import { app, BrowserWindow, globalShortcut, nativeTheme, powerMonitor, powerSaveBlocker, shell, type WebPreferences } from "electron";
import { randomUUID } from "node:crypto";
import { cpus, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import { resolveAvatarModel } from "../shared/planet-avatar.ts";
import {
  effectiveAllowNetwork,
  effectiveComputerUseBackend,
  effectiveGuestAllowExe,
  effectiveGuestBrowser,
  effectiveLanguage,
  lastUsedPair,
  type Language,
  type ThemePreference,
} from "../shared/settings.ts"
import { AgentHost, resolveRuntimePath } from "./agent/host.ts";
import { agentEnv, bundledBinDir } from "./agent/search-bins.ts";
import { PI_PACKAGE_DIR_ENV, piPackageDir } from "./agent/pi-package.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { applyMcpWrite, applySkillWrite } from "./agent/write-requests.ts";
import { applyReadTask } from "./session/read-task.ts";
import { registerImportIpc } from "./session/import-ipc.ts";
import { CustomRootsStore, dirsOf, mergeCustomRoots } from "./session/import-custom-roots.ts";
import { baseDir, DATA_ROOT_SPECS, findDataRoots, hasDirectory } from "./session/import-locate.ts";
import { createKimiExternalSessionReader, kimiWorkDataRoot } from "./session/external-session.ts";
import { broadcastAgentEvent, registerAgentIpc, resolveProviderSecrets } from "./agent/ipc.ts";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import { MemoryServiceHost, resolveMemoryRuntimePath } from "./memory/host.ts";
import { MemoryServiceHostCore } from "./memory/host-core.ts";
import { registerMemoryIpc } from "./memory/ipc.ts";
import { forwardMemoryTool } from "./memory/tool-forward.ts";
import {
  MEMORY_VECTOR_MODELS,
  memoryScopeOf,
  type MemoryModelFileState,
  type MemoryRecallOutcome,
} from "../shared/memory.ts";
import { MemoryTurnTracker } from "./memory/turn-tracker.ts";
import { MemoryHistoryJob, parseHistoryStatus } from "./memory/history-job.ts";
import { EpisodeStore, EPISODE_IDLE_CLOSE_MS } from "../memory/episodes.ts";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-write.ts";
import { isNotFound } from "./fs-errors.ts";
import { choreModelPayload } from "./memory/chore.ts";
import { llamaServerCandidates } from "./memory/llama-bin.ts";
import {
  effectiveVectorSettings,
  modelDownloadSources,
  vectorChangeCancelsDownload,
  modelFilePath,
  vectorServiceConfig,
} from "./memory/vector-setup.ts";
import { IntentIngestTracker } from "./agent/intent-ingest.ts";
import { postIntentIngest, postIntentInvalidate } from "./agent/intent-lab-client.ts";
import { effectiveIntentSettings } from "../shared/settings.ts";
import { broadcastChannelEvent, broadcastClosureNotices, registerChannelIpc } from "./channel/ipc.ts";
import { StartupClosureQueue } from "./channel/startup-closures.ts";
import { ChannelReconciler } from "./channel/reconcile.ts";
import { broadcastAutomationEvent, registerAutomationIpc } from "./automation/ipc.ts";
import { KeepAwake } from "./automation/keep-awake.ts";
import { deliverAutomationRun, launchAutomationRun, type LaunchDeps } from "./automation/launch.ts";
import { applyAutomationRequest, type AutomationRequestDeps } from "./automation/requests.ts";
import { AutomationScheduler } from "./automation/scheduler.ts";
import { AutomationStore } from "./automation/store.ts";
import { applyChannelSend, applyDelegate, type ChannelDeps } from "./channel/requests.ts";
import { ChannelStore } from "./channel/store.ts";
import { registerProviderIpc } from "./provider/ipc.ts";
import { QuotaCache } from "./provider/quota-cache.ts";
import { quotaHintOf, type QuotaExhaustedHint } from "../shared/quota.ts";
import { registerSessionIpc } from "./session/ipc.ts";
import { moveSessions } from "./session/move.ts";
import { registerMcpIpc } from "./mcp/ipc.ts";
import { McpStore } from "./mcp/store.ts";
import { PluginAgentRequests } from "./plugin/agent-requests.ts";
import { DraftSessionBook } from "./plugin/draft-sessions.ts";
import { scanDrafts } from "./plugin/drafts.ts";
import { builtinPluginsDir } from "./plugin/builtin.ts";
import { BoardTemplateStore, PluginBoards, boardPluginsIn } from "./plugin/board-snapshot.ts";
import { registerChatEmbedIpc } from "./chat-embed/ipc.ts";
import { registerBoardIpc } from "./plugin/board-ipc.ts";
import { BOARD_TEMPLATES_DIR } from "../shared/plugin-board.ts";
import { registerPluginIpc } from "./plugin/ipc.ts";
import { PanelFrames, isPanelFrameUrl } from "./plugin/panel-frame.ts";
import { installPanelProtocol, registerPanelScheme } from "./plugin/panel-protocol.ts";
import { PluginPanels } from "./plugin/panel-service.ts";
import { PluginStore } from "./plugin/store.ts";
import { registerSkillIpc } from "./skill/ipc.ts";
import { SkillStore } from "./skill/store.ts";
import { createSessionRecorder } from "./session/recorder.ts";
import { SessionStore } from "./session/store.ts";
import { StatusDigestStore } from "./session/status-digest.ts";
import { ExcerptStore } from "./excerpt/store.ts";
import { priceChartSourceOf, registerPriceChartIpc, registerUsageIpc, startTaskLedger } from "./usage/ipc.ts";
import { applyModelCosts } from "./usage/model-costs.ts";
import { readPiThinkingTimeline, TaskLedger } from "./usage/task-ledger.ts";
import { Updater } from "./updater/service.ts";
import { registerUpdaterIpc } from "./updater/ipc.ts";
import { GitHubClient } from "./updater/github-client.ts";
import { applyEnvProxy, electronGitHubTransport } from "./updater/github-net.ts";
import { createRecentReleases } from "./updater/recent-releases.ts";
import { applyNativeTheme, registerSettingsIpc } from "./settings/ipc.ts";
import { SettingsStore } from "./settings/store.ts";
import { registerWindowIpc } from "./window/ipc.ts";
import { installCloseToTray, loadTrayIcon, type AppTray } from "./window/tray.ts";
import { registerWorkspaceIpc } from "./workspace/ipc.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { registerFilesIpc } from "./files/ipc.ts";
import { installMediaProtocol, registerMediaScheme } from "./files/media-protocol.ts";
import { MediaTokens } from "./files/media-stream.ts";
import { applyDocRequest } from "./doc-panel/agent-requests.ts";
import { printDocPdf } from "./doc-panel/print-doc-pdf.ts";
import { registerDocIpc } from "./doc-panel/ipc.ts";
import { applySlidesRequest } from "./slides/agent-requests.ts";
import { exportDeck } from "./slides/export.ts";
import { registerSlidesIpc } from "./slides/ipc.ts";
import { resolveFileRoots } from "./files/roots.ts";
import { TerminalService } from "./terminal/service.ts";
import { registerTerminalIpc } from "./terminal/ipc.ts";
import { registerReviewIpc } from "./review/ipc.ts";
import { registerFocusIpc } from "./focus/ipc.ts";
import { registerPowerIpc } from "./power/ipc.ts";
import { ChimeLog } from "./notify/chime-log.ts";
import { registerNotifyIpc } from "./notify/ipc.ts";
import { registerBrowserIpc } from "./browser/ipc.ts";
import { registerExcerptIpc } from "./excerpt/ipc.ts";
import { registerPanelUsageIpc } from "./panel-usage/ipc.ts";
import { PanelUsageStore } from "./panel-usage/store.ts";
import { registerRightPanelMemoryIpc } from "./right-panel-memory/ipc.ts";
import { RightPanelMemoryStore } from "./right-panel-memory/store.ts";
import { isSystemHandoffLink, isWebLink } from "./browser/address.ts";
import { BrowserSandbox } from "./browser/sandbox.ts";
import { windowsSandboxExePath } from "./computer-use/capability.ts";
import { broadcastComputerUseStatus, registerComputerUseIpc } from "./computer-use/ipc.ts";
import { cuLanguage, cuTexts, setComputerUseUiLanguage } from "./computer-use/ui-language.ts";
import { guestErrorText } from "./computer-use/bridge-error-text.ts";
import { createEmergencyStop } from "./computer-use/emergency-stop.ts";
import { buildCloseSandboxWindowScript } from "./computer-use/close-window-script.ts";
import { sendGuestCommand } from "./computer-use/bridge-client.ts";
import {
  BRIDGE_INFO_FILE,
  COMPUTER_USE_SHUTDOWN_REQUEST_FILE,
  computerUseBackendChoices,
  computerUseBlockedReason,
  computerUseConsentTexts,
  computerUseGuestCommands,
  devBackendsEnabled,
  parseComputerUseConsent,
  parseComputerUseConsentSource,
  type ComputerUseTurnOrigin,
} from "../shared/computer-use.ts";
import { ComputerUseConsentWaiter, createComputerUseConsentGate } from "./computer-use/consent.ts";

import { parseSandboxProcesses, type SandboxProcessInfo } from "./computer-use/process-list.ts";
import { SandboxController } from "./computer-use/sandbox.ts";
import { IsolationSessionController } from "./computer-use/isolation-session.ts";
import { createMxcSdk } from "./computer-use/mxc-sdk.ts";
import { createComputerUseRuntime } from "./computer-use/runtime.ts";
import { applyComputerUseRequest } from "./computer-use/agent-requests.ts";
import { applySandboxBrowserRequest, CdpSession } from "./computer-use/cdp.ts";
import { createComputerUseDispatcher } from "./computer-use/dispatch.ts";
import { createComputerUseLease } from "./computer-use/lease.ts";
import { PAGE_BACKGROUNDS, pageBackgroundColor } from "./browser/page-background.ts";
import { applyBrowserRequest } from "./browser/agent-requests.ts";
import { applyTerminalRequest } from "./terminal/agent-requests.ts";
import { browserDownloadDir } from "./browser/download-dir.ts";
import { resolveTurnDirectories } from "./agent/turn-directories.ts";
import { mainWindows } from "./window/main-windows.ts";
import { isOwnRendererPage, type RendererOriginDeps } from "./window/renderer-origin.ts";
import { SafeStorageSecrets } from "./provider/safe-storage-secrets.ts";
import { devDataDirs } from "./data-dirs.ts";
import { ProviderStore } from "./provider/store.ts";
import { createDoubaoProtocol } from "./voice/doubao-protocol.ts";
import { DictationSessions } from "./voice/dictation.ts";
import { registerVoiceIpc } from "./voice/ipc.ts";
import { diagnoseOverHttps, openUndiciSocket } from "./voice/socket.ts";
import { VoiceStore } from "./voice/store.ts";

// 出站固定 IPv4：双栈 WAF + 本机无全局 v6 的间歇超时，见 dial-v4.ts 的取证
preferIPv4();

// 插件面板的 iframe 协议（orbita-panel://）：Electron 要求自定义协议在 app ready 之前登记
registerPanelScheme();
// 文件面板的音视频协议（orbita-media://）：同样要在 app ready 之前登记
registerMediaScheme();

// Windows 的系统通知按 AUMID 归到应用（否则打包版可能根本不弹，或弹成 Electron 的
// 默认名）。与 electron-builder 的 appId 同值；要在任何通知发出前设（模块顶层即可）。
app.setAppUserModelId("com.orbita.desktop");

// 开发版与正式版各用各的数据（理由见 data-dirs.ts）。**必须在任何人读 userData 之前**：
// 放在模块顶层、whenReady 之前——Chromium 的 Local Storage / 缓存也在 ready 时按它定位
const devDirs = devDataDirs({
  packaged: app.isPackaged,
  appData: app.getPath("appData"),
  home: homedir(),
  // 隔离实例（--user-data-dir）：锁与 userData 由 Chromium 分开，工作区根在 devDataDirs 里跟着目录名派生
  userDataSwitch: app.commandLine.getSwitchValue("user-data-dir"),
  // 隔离实例（ORBITA_DEV_INSTANCE）：按名字分 userData 与工作区根，appData 由 Electron 按平台给
  instance: process.env.ORBITA_DEV_INSTANCE,
});
// 显式给了 `--user-data-dir`（CDP 验收用隔离目录的惯例）就听它的：不然这里会把隔离目录盖回 orbita-dev
if (devDirs !== null && !app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", devDirs.userData);

/*
 * 假麦克风（只给开发版的无人验收用）：夜里没人点系统的麦克风授权框，也不许替用户改系统设置，
 * 于是让 Chromium 用一段 wav 当麦克风、免掉页内授权。**只在开发版 + 显式环境变量下生效**：
 * ORBITA_FAKE_MIC_WAV=<wav 绝对路径>（播完即静音，不循环）。打包版不认这个变量。
 */
const fakeMicWav = app.isPackaged ? undefined : process.env["ORBITA_FAKE_MIC_WAV"];
if (fakeMicWav !== undefined && fakeMicWav !== "") {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${fakeMicWav}%noloop`);
  // 音频服务默认在沙箱里的独立进程，读不到这个文件（实测报 Failed to read … Try disabling the sandbox）：
  // 假麦克风开着时让它跑在主进程里、不进沙箱——只影响这种开发验收实例
  app.commandLine.appendSwitch("disable-features", "AudioServiceOutOfProcess,AudioServiceSandbox");
}

/*
 * 单实例锁。「关窗 = 收进托盘」之后，双击桌面图标必须回到原进程——否则两个进程
 * 同时写同一份会话 JSONL / settings（「读全量 → 改写 → rename」的原子写挡不住
 * 两个写入者，会互相覆盖丢更新）。锁按 userData 目录划分，dev 与打包版、显式
 * `--user-data-dir` 的隔离实例互不干扰。
 */
if (!app.requestSingleInstanceLock()) {
  // exit 而不是 quit：锁拿不到说明本进程还在最顶层、没建窗没接 IPC，没有要清理的东西
  app.exit(0);
} else {
  app.on("second-instance", () => {
    // 已有进程的窗口可能收在托盘里（hidden）或最小化：叫出来，不另起一窗
    for (const window of mainWindows.list()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
}

/** 26-entry-layer §9.2 安全不变量：三条都不许放松。 */
const SECURITY_INVARIANTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

/**
 * macOS 上的窗口形态。**边界卡就是窗口本身**——我们不画背景，背景是用户自己的桌面。
 *
 * 三个选项各有各的必须：
 *  - `titleBarStyle: "hiddenInset"` —— 去掉标题栏但**留下红黄绿三个键**，让它们落进边界卡里。
 *    渲染层给侧栏顶部留出净空并标 `-webkit-app-region: drag`，否则窗口就拖不动了。
 *  - `vibrancy` —— CSS 的 `backdrop-filter` **模糊不了窗口背后的桌面**（合成器里根本没有那块内容），
 *    真正的「透出桌面」只能由系统材质给。边界卡在它上面再画一层 `--glass-bg`，
 *    合出来就是设计系统要的 layer 1。
 *  - **不设 `backgroundColor`** —— 设了 vibrancy 的窗口由 Electron 自己把底色清掉，额外给
 *    `#00000000` 是多余的一笔。（它曾被怀疑与双击缩放有关，已排除，见 MAC_WINDOW 内注释。）
 *
 * 非 macOS 没有等价物，退回不透明底色；边界卡的圆角那时由渲染层自己画。
 */
const MAC_WINDOW = {
  /**
   * hiddenInset 与 hidden 在这里等价：红绿灯位置由 trafficLightPosition 定死，
   * 取 hiddenInset 只是与 Proma 保持一致。**它不是双击缩放那个 bug 的修复**——
   * 那一刀在依赖里：拖拽区的双击缩放要 Electron ≥ 43（见 package.json 的 electron）。
   * Electron 38 把双击交给 AppKit，而 AppKit 只认原生标题栏矩形（窗口顶部约 30px），
   * `-webkit-app-region: drag` 只接管拖拽——于是拖拽带 y 12–66 全程能拖，y ≥ 34 却不缩放。
   */
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 18, y: 19 },
  vibrancy: "under-window",
  // 失焦不要把整面 UI 变灰——安静的工作台不该闪
  visualEffectState: "active",
} as const;

/**
 * `theme` 是这次启动（或这次 `activate` 重开）读到的设置里的主题偏好，原样塞进
 * `--orbita-theme=` 命令行参数（`webPreferences.additionalArguments`）——preload
 * 的 `initial-theme.ts` 原样读出来，渲染层 `main.tsx` 用它在 `createRoot` 之前
 * 同步写好 `data-theme`，不必等 `settings:get` 那趟 IPC 跑完再套一层交叉淡入。
 * 不走 IPC / localStorage：这是窗口创建时刻就同步可得的值，硬塞一条通道或另存
 * 一份缓存反而多造一个真源（同 preload 里 `platform` 的先例）。
 */
/**
 * 托盘（Windows / Linux，见 window/tray.ts）。退出前必须销毁，否则进程退不掉。
 */
let appTray: AppTray | null = null;

function createMainWindow(
  theme: ThemePreference,
  language: Language | undefined,
  openLink: (url: string) => void,
  readLanguage: () => Promise<Language>,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? MAC_WINDOW
      : // Windows/Linux：转帧式窗口——最小化/最大化/关闭由渲染层标题栏自绘
        // （标题栏上还有「复制 transcript」与「抽屉开关」，这是 right-drawer-X 的落位）。
        // resizable 的帧式窗口在 Windows 上保留系统缩放边，不受 frame:false 影响。
        { frame: false, backgroundColor: PAGE_BACKGROUNDS.light }),
    webPreferences: rendererPreferences(theme, language),
  });
  mainWindows.track(window);

  // 只在内容就绪后显示，避免空窗口先出现
  window.once("ready-to-show", () => window.show());

  // 外链不在应用内开新窗：交给 openLink（网页进内置浏览器，其余协议交给系统）
  window.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });

  /*
   * 页内发起的导航（拖链接进窗、页面动 location）不许顶掉我们自己的页面：preload 跟着
   * WebContents 走，换成任何别的页面都等于把整面 IPC 交给它。renderer 侧 main.tsx 只拦
   * 带文件的拖拽，链接拖拽（text/uri-list）没人拦，所以这道闸必须在主进程。我们自己的
   * 页面（dev 同源 / 包内 renderer）放行——reload 与 HMR 全量刷新走的都是这条；其余一律
   * preventDefault，网页链接转交 openLink，非网页协议由 openLink 的白名单处置。
   */
  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnRendererPage(url, ownRendererOrigin())) return;
    event.preventDefault();
    openLink(url);
  });

  /*
   * 子框架的导航：renderer 里唯一的子框架是插件面板的 iframe（orbita-panel://），它是不可信模板的家——
   * 模板里 location.href / <a> / <meta refresh> 想把自己（或拿着 preload 的主框架）带去别处，一律拦。
   * 主框架由上面的 will-navigate 管；这里只管 isMainFrame 为 false 的。
   */
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    if (!isPanelFrameUrl(event.url)) event.preventDefault();
  });

  /*
   * 关窗 = 收进托盘（Windows / Linux）。**托盘先建成功，才接这道闸门**：藏了却找不回来
   * 比直接退出更糟，所以图标缺失时这里什么都不做，关窗保持原语义。
   * macOS 不接——那边关窗本来就留进程，点 Dock 回来，与这套闸门是两种惯例。
   */
  if (process.platform !== "darwin" && appTray === null) {
    const icon = loadTrayIcon();
    if (icon === null) {
      console.warn("[tray] 托盘图标缺失（build/tray.png），关窗仍然是退出");
    } else {
      appTray = installCloseToTray({
        window,
        icon,
        language: effectiveLanguage(language),
        readLanguage,
      });
    }
  }

  // Windows 注销 / 关机：系统要收这扇窗，别让「关窗 = 隐藏」把关机拦住
  // （session-end 是 BrowserWindow 上的事件，不在 app 上）
  window.on("session-end", () => appTray?.beginQuit());

  loadRendererPage(window, "index.html");
  return window;
}

/**
 * 我们自己的 renderer 页面的 webPreferences：主窗口与沙盒浏览器窗口的工具条共用。
 * 工具条走同一个 preload——它是我们自己的页面，信任级与主窗口相同；网页本身在另一个
 * WebContentsView 里，不加载任何 preload（browser/sandbox.ts）。
 */
function rendererPreferences(theme: ThemePreference, language: Language | undefined): WebPreferences {
  return {
    ...SECURITY_INVARIANTS,
    preload: join(__dirname, "../preload/index.js"),
    // 语言同理（`--orbita-language=`，preload 的 readInitialLanguage）：没选过就不传
    additionalArguments: [`--orbita-theme=${theme}`, ...(language === undefined ? [] : [`--orbita-language=${language}`])],
  };
}

/**
 * 把 renderer 的某个 HTML 入口载入窗口：主窗口是 index.html，沙盒窗口的工具条是
 * browser-toolbar.html（electron-vite 的第二个 renderer 入口）。
 */
function loadRendererPage(window: BrowserWindow, page: "index.html" | "browser-toolbar.html"): void {
  // 打包产物一律读包内 renderer，不认这个环境变量：在 dev 版 orbita 的 agent 终端里
  // 直接启动打包产物时，这个变量会从 electron-vite dev 一路继承下来，不拦就会连到 dev server
  const devServerUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) {
    const pageUrl = page === "index.html" ? devServerUrl : new URL(page, `${devServerUrl.replace(/\/?$/, "/")}`).href;
    // 两类 dev 首载故障都会把窗口留在底色上（真实事故 2026-09-10：白屏只能手动 Ctrl+R）：
    // ① server 未就绪 loadURL 拒绝——退避重试；ready-to-show 没到窗口不可见，重试无感。
    // ② 首帧合成失败——页面加载零错误、DOM 完整，但画面停在窗口底色（reload 能救活）；
    //    落定后 executeJavaScript 探到内容即 invalidate() 强制重绘上屏。
    const load = (attempt: number): void => {
      window.loadURL(pageUrl).catch(() => {
        if (window.isDestroyed() || attempt >= 10) return;
        setTimeout(() => load(attempt + 1), 500 * attempt);
      });
    };
    load(0);
    window.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        void window.webContents
          .executeJavaScript(`Boolean(document.getElementById("root")?.children.length)`)
          .then((hasContent) => {
            if (hasContent) window.webContents.invalidate();
          })
          .catch(() => {});
      }, 1500);
    });
  } else void window.loadFile(join(__dirname, "../renderer", page));
}

/**
 * will-navigate 闸门的真实环境值：判定逻辑与注入参数见 window/renderer-origin.ts。
 * 与 loadRendererPage 同一套取值口径（isPackaged 先于读环境变量），两处不会各说各话。
 */
function ownRendererOrigin(): RendererOriginDeps {
  return {
    devServerUrl: app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"],
    rendererDir: join(__dirname, "../renderer"),
  };
}

/**
 * 记忆召回的转发（index.ts 的 onEvent 用）：agent → 主进程 → 记忆服务进程。
 * 作用域在主进程解析（memoryScopeOf：workspaceId ?? cwd，agent 不做路径策略）；
 * 服务不在 / 转发超时 / 服务内部出错都回空命中——召回在轮前的同步路径上，
 * 记忆的任何问题都不该拦住开轮（agent 侧另有 6 秒硬超时兑主进程失联）。
 */
async function forwardMemoryRecall(
  host: MemoryServiceHostCore,
  event: Extract<AgentEvent, { type: "memoryRecallRequest" }>,
  ensureStarted: () => Promise<boolean>,
): Promise<MemoryRecallOutcome> {
  try {
    if (!host.isRunning()) await ensureStarted();
    const hits = await host.recall({
      sessionId: event.sessionId,
      scopeId: memoryScopeOf(event.scope),
      turn: event.turn,
      query: event.query,
    });
    return { ok: true, hits };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

void app.whenReady().then(async () => {
  // 配置落在 Electron 的 userData 目录，不再依赖 pi 的 ~/.pi/agent。
  // 从旧 models.json / auth.json 的迁移等到真有旧数据的用户时再单独立项（落库纪律：没有消费者不写）。
  const configDir = app.getPath("userData");
  // 一个 secrets.json 一个实例：provider 的 API key 与语音厂商的密钥共用，读改写不互相踩
  const secrets = new SafeStorageSecrets(configDir);
  const providers = new ProviderStore(configDir, secrets);
  // workspace 的 IPC 在下面注册（要一并注入 skills 的连带清理，见 registerWorkspaceIpc）

  /*
   * 主题先于窗口生效——这里真的等它生效，不再是「先发个 promise 就当数」：
   * 改动前 `void settings.read().then(applyNativeTheme)` 不 await，窗口在下面
   * 同步创建，两条路径实际在赛跑，vibrancy 材质的第一帧仍可能按系统外观画。
   * 现在 await 出这次启动要用的设置，applyNativeTheme 定下 nativeTheme 之后，
   * 同一份 initialSettings.theme 再传给 createMainWindow（塞进
   * additionalArguments，渲染层首帧同步读出，见 preload/initial-theme.ts）。
   */
  const settings = new SettingsStore(configDir);
  // 子智能体档案（工作区 planet/agents/<id>/agent.json）：面板 IPC、agent 工具、指名派活共用一个
  const subAgentStore = new SubAgentStore();
  // 设置写入的观察：「阻止睡眠」设置变了按当前在跑数重对一次（keepAwake 在后面定义；
  // 设置写入只发生在窗口起来之后，那时已就绪）。记忆服务与自动化 2026-11-06 转正，
  // 不再随设置开关拉起 / 停
  registerSettingsIpc(settings, (next) => {
    void keepAwake.sync().catch(() => undefined);
    // 切了语言，电脑使用那批文案下一条回执就跟上（与 consent 文本同一套「现读」纪律）
    setComputerUseUiLanguage(effectiveLanguage(next.language));
  });
  registerWindowIpc();
  const initialSettings = await settings.read();
  applyNativeTheme(initialSettings);
  // 电脑使用的界面文案跟界面语言走（缺省 zh 只在「没接线」时成立，真实运行不落那条）
  setComputerUseUiLanguage(effectiveLanguage(initialSettings.language));

  // agent 跑在独立 utility 进程；主进程只转发事件，不加工（guideline §二）——
  // 唯一的例外是**落盘**，那本来就是主进程的职责，挂在同一条转发路径上是最短的一跳。
  // 通道账本（子会话 2026-09-23）先于 SessionStore 建：SessionStore 的级联删要用它
  const channels = new ChannelStore(join(configDir, "channels"));
  // 状态卡摘要（2026-11-27）：每条会话一份 sessions/<id>.status.json，record 落盘的同一处推进；
  // 先于 SessionStore 建——它的钩子（onRecordAppended 等）在构造时就接上
  const statusDigests = new StatusDigestStore(join(configDir, "sessions"));
  const sessions = new SessionStore(join(configDir, "sessions"), join(configDir, "workbenches"), channels, {
    onRecordAppended: (id) => statusDigests.touch(id),
    onLogReplaced: (id) => statusDigests.invalidate(id),
    onLogSeeded: (id, records, logBytes) => statusDigests.seed(id, records, logBytes),
    onRemoved: (id) => void statusDigests.remove(id),
  });
  /**
   * 电脑使用的会话授权（2026-11-27）：提问表 + 栅门。位置在 sessions 之后、窗口接线之前——
   * 栅门读写会话 meta，而主窗口全关时要先把挂起的提问按拒绝结掉（onLastClosed，下面）。
   * 提问走 `agent:event` 的同一条广播通道（与 intentAsk / 急停一致），回答走
   * `computer-use:consent-answer`（registerComputerUseIpc 注册）。
   */
  /**
   * 每条会话**当前这一轮**是谁发起的（2026-11-27 验收后）。值只由开轮处写（registerAgentIpc 的
   * submitTurn / interrupt），闸门只读——发起者是主进程本来就知道的事实，不需要另开一条 IPC。
   * 缺席按 `user` 算：用户手点的轮是默认路径，自动化会在开轮时显式写 `automation`。
   */
  const computerUseTurnOrigins = new Map<string, ComputerUseTurnOrigin>();
  const computerUseConsentWaiter = new ComputerUseConsentWaiter({
    send: (event) => broadcastAgentEvent(event),
    // 本轮结束 / 会话删除：把确认行从界面上撤下（不是拒绝，没有写 meta）
    notifyCancelled: (event) => broadcastAgentEvent(event),
  });
  const computerUseConsentGate = createComputerUseConsentGate({
    // 一次读盘拿齐「授权值 + 用户能不能看到并回答」：后者由 shared 的唯一判据
    // computerUseBlockedReason(会话身份, 这一轮的发起者) 算。发起者由开轮处记在
    // computerUseTurnOrigins（见 registerAgentIpc 的 setTurnOrigin）。
    read: async (sessionId) => {
      const meta = await sessions.readMeta(sessionId);
      if (meta === null) return null;
      return {
        consent: parseComputerUseConsent(meta.computerUseConsent),
        source: parseComputerUseConsentSource(meta.computerUseConsentSource),
        blocked: computerUseBlockedReason(meta, computerUseTurnOrigins.get(sessionId) ?? "user"),
      };
    },
    // write 回「真的落下了没」：`update` 对已删会话静默 no-op，不能把它当成功
    write: (sessionId, consent, source) => sessions.setComputerUseConsent(sessionId, consent, source),
    ask: (sessionId, action) => computerUseConsentWaiter.ask(sessionId, action),
    // 没人能回答就不问：窗口全关 / 只剩无界面的自动化时提问只会等到 120s 超时，
    // 不如当场按拒绝落库（fail closed 的结果一样，代价更小）。
    canAsk: () => mainWindows.list().length > 0,
    notify: (event) => broadcastAgentEvent(event),
    // 拒绝 / 停止 / 主会话专用那几句跟界面语言走（模型回执与界面「已告知模型」同一句）
    texts: async () => computerUseConsentTexts(effectiveLanguage((await settings.read()).language)),
  });
  // 语音：听写 + 通话的合成与录音（录音写进会话工作台，所以排在 SessionStore 之后）
  registerVoiceIpc(
    new VoiceStore(configDir, secrets),
    new DictationSessions({ openSocket: openUndiciSocket, diagnose: diagnoseOverHttps }),
    { workbenchPath: (sessionId) => sessions.workbenchPath(sessionId) },
  );
  // 任务账本（侧栏用量格 usage:week / usage:event 与价格 · 能力图共用）：assistant 记录落盘的同一条
  // 路径上按「会话 × 型号 × 档的连续一段」增量记账，意图召回另记按天的一份；升级后第一次启动回填
  // 一次，注册即异步装载 + 回填，不阻塞启动。取代原来的日账本 usage-daily.json（不再读写，留在盘上无害）
  const taskLedger = new TaskLedger(join(configDir, "usage-tasks.json"));
  const record = createSessionRecorder(sessions, taskLedger);
  startTaskLedger(taskLedger, {
    list: () => sessions.list(),
    readUsageLog: (id) => sessions.readUsageLog(id),
    readPiTimeline: (path) => readPiThinkingTimeline(path),
  });
  // 摘抄（excerpt:*）：聊天里划选存下的收藏清单，与 agent 循环无关、不进模型；
  // 存 userData 根下的一份 JSONL，list 时按 sessionId 回读会话标题补出处。
  // 同一个实例也喂给专注小结（摘抄是素材之一）
  const excerpts = new ExcerptStore(join(configDir, "excerpts.jsonl"));
  registerExcerptIpc(excerpts, sessions);
  // 面板打开次数（panel-usage:*）：只在本机、不上传，
  // 设置 › 实验功能里给一行只读统计
  registerPanelUsageIpc(new PanelUsageStore(join(configDir, "panel-usage.json")));
  // 右栏按会话记忆（right-panel-memory:*）：每条会话离开时右栏开着哪个面板、停在面板的哪一层，
  // 只存路径数据；跨重启保留。独立小文件而不挤进 settings：整份几百条、改得勤，不该走设置的广播
  registerRightPanelMemoryIpc(new RightPanelMemoryStore(join(configDir, "right-panel-memory.json")));
  const mcp = new McpStore(configDir);
  // 一份工作区存储给两处用：下面的 workspace IPC，与 read_task 的目录模式（要工作区名）
  // 工作区根：正式版沿用默认的 ~/Orbita，开发版挪到 ~/Orbita-dev（同 userData 的理由）
  const workspaces = new WorkspaceStore(configDir, devDirs?.orbitaRoot);
  const customRoots = new CustomRootsStore(configDir);
  // read_task 的外部只读来源。每次现找目录：Migration 里添加 / 移除自定义 Kimi Code
  // 数据根后下一次调用就生效；Kimi Work 复用同一 wire 解析器，但不共享它的数据根。
  const externalSessions = createKimiExternalSessionReader({
    defaultCwd: workspaces.defaultPath(),
    sources: async () => {
      const context = { platform: process.platform, home: homedir(), env: process.env };
      const spec = DATA_ROOT_SPECS["kimi-code"];
      const kimiCodeRoots = await mergeCustomRoots(
        await findDataRoots(spec, context),
        dirsOf(await customRoots.read(), "kimi-code"),
        spec,
      );
      const workRoot = kimiWorkDataRoot(baseDir("appData", context));
      return [
        { source: "kimi-code" as const, roots: kimiCodeRoots },
        { source: "kimi-work" as const, roots: (await hasDirectory(join(workRoot, "sessions"))) ? [workRoot] : [] },
      ];
    },
  });
  /*
   * 受管浏览器（沙盒窗口懒创建，见 browser/sandbox.ts）。关窗 = 隐藏；应用退出前先
   * prepareQuit，退出时的关窗才不会被改写成隐藏；最后一个主窗口关闭就一并销毁——
   * 否则 Windows / Linux 上隐藏的沙盒窗口让应用关不掉（window/main-windows.ts）。
   */
  const browserSandbox = new BrowserSandbox({
    toolbarWindowOptions: async () => {
      const current = await settings.read();
      return { title: app.getName(), webPreferences: rendererPreferences(current.theme, current.language) };
    },
    loadToolbar: (window) => loadRendererPage(window, "browser-toolbar.html"),
    pageBackground: async () => pageBackgroundColor((await settings.read()).theme, nativeTheme.shouldUseDarkColors),
    sessionTitle: async (sessionId) => (await sessions.readMeta(sessionId))?.title ?? "",
    workbenchPath: (sessionId) => sessions.workbenchPath(sessionId),
    userDownloadDir: () => browserDownloadDir(settings),
    // 与每轮告诉 agent 的目录清单同一个来源（resolveTurnDirectories）：工作台、附加目录，外加 cwd 与浏览器下载
    sessionRoots: async (sessionId) => {
      const meta = await sessions.readMeta(sessionId);
      const directories = await resolveTurnDirectories(workspaces, sessions, channels, {
        sessionId,
        workspaceId: meta?.workspaceId ?? null,
      });
      return [
        directories.workbench,
        ...(meta?.cwd !== undefined ? [meta.cwd] : []),
        ...directories.attached,
        await browserDownloadDir(settings),
      ];
    },
    appName: app.getName(),
    appVersion: app.getVersion(),
  });
  registerBrowserIpc(browserSandbox, settings, configDir);
  mainWindows.onLastClosed(() => {
    // 窗口全关 = 没有人能回答授权提问：按**拒绝**结掉（与「本轮结束」不同，这条路上
    // 「没人能答」本身就是拒绝）。紧接着应用会退出，这次写可能是 best-effort——
    // 退不掉也是 fail closed（下次启动仍是 unset，会重新问一次）。
    computerUseConsentWaiter.abandonAll();
    browserSandbox.dispose();
  });

  /*
   * computer use v1（PR1 主进程部分）：Windows 沙箱生命周期 + 手动「看一眼」截图。
   * guest 桥目录：开发 = 仓库 guest-bridge/bin（bun run build:bridge 出 exe），
   * 打包 = resources/guest-bridge（electron-builder extraResources，见 package.json）。
   * spawnSandbox 只在这里真接——测试全走假进程，沙箱窗口是用户可见面。
   */
  const sandboxExePath = windowsSandboxExePath();
  /**
   * 按 PID 杀整棵沙箱进程树（`taskkill /T /F`，与 spawnSandbox 里那套同一份火力）。
   * 抽成独立函数是因为 stop() 的收尾链在「第一次 kill 没确认退出」时还要再打一次；
   * 那时手上只有 pid，没有 child 对象。
   * onFailure 只在第一次 kill 用（那里还拿得到 child，可以退回单进程杀）；升级那次不传，
   * 失败交给收尾链的下一个窗口留痕迹。
   */
  const killTreeByPid = (pid: number, onFailure?: () => void): void => {
    try {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.on("error", () => onFailure?.());
      taskkill.on("exit", (code) => {
        if (code !== 0) onFailure?.();
      });
    } catch {
      onFailure?.();
    }
  };

  /**
   * 现在宿主上有哪些沙箱侧进程（**只观测，不杀**）。
   *
   * 三类镜像名来自 2026-10-23 真机实测：新沙箱架构下 WindowsSandbox.exe 只是启动器，
   * 沙箱本体活在 WindowsSandboxServer / WindowsSandboxRemoteSession / vmwp 里。
   * 控制器拿「启动前基线」做差集，才知道哪些是我们这只（而不是同机上别人的沙箱）；
   * 带镜像名是为了挑出 RemoteSession 去**优雅关窗**（只认 PID 的话发不了 WM_CLOSE）。
   * 只读 tasklist；杀仍走 killTreeByPid（taskkill /T /F）——不按镜像名杀（仓规）。
   */
  const listSandboxProcesses = (): SandboxProcessInfo[] => {
    if (process.platform !== "win32") return [];
    try {
      const listed = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
      return parseSandboxProcesses(listed.stdout);
    } catch {
      // 观测失败当成「看不见」：宁可走旧路径，也不让启动 / 关闭被观测拖坐
      return [];
    }
  };

  /**
   * 关掉沙箱窗口（等价用户点 X 并按下确认框的 Ok）。**不能改成 taskkill。**
   *
   * 2026-10-23 真机验收：直接 taskkill 能杀掉 Server / RemoteSession，但 VM 不退——
   * vmwp.exe + vmmemWindowsSandbox（各 ~3.5GB）继续占着内存，vmwp 自己 taskkill 是拒绝访问，
   * 不带 /F 打 RemoteSession 则完全无效（它不是控制台进程）；泄漏攒多了会报
   * 「与该服务器建立的会话太多」，新沙箱都起不来。
   * 而走「关窗 → 替用户按 Ok」的路子，9~12 秒内整条链自行退出、VM 内存释放。
   *
   * 2026-11-13 起它只是**第二级兜底**（首选是让 guest 自己关机）：真机诊断显示这个脚本
   * 33 秒里 18.7 秒花在 `Add-Type System.Windows.Forms`、PowerShell 启动另要 5–29 秒，
   * 45 秒预算在忙机器上必然穿。本条只在「桥没起来 / 老桥不认 shutdown」时跑。
   *
   * **异步 spawn 而不是 spawnSync**：脚本最长跑 45 秒，同步调用会把主进程（窗口、IPC）
   * 一起冻住 45 秒。日志留痕照旧：退出码区分「守规矩没发键」与「确认框没按到」。
   * 失败不抛：控制器看到异常会退回强杀链。
   */
  const closeSandboxWindow = (pid: number): Promise<void> =>
    new Promise((resolve) => {
      if (process.platform !== "win32") {
        resolve();
        return;
      }
      const startedAt = Date.now();
      let settled = false;
      const settle = (status: number | null, error: Error | undefined, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (status === 0) {
          resolve();
          return;
        }
        const reason =
          status === 2
            ? "前台不是这只沙箱，守规矩没发键"
            : status === 3
              ? "确认框没按到 Ok"
              : error !== undefined
                ? `脚本没跑起来（${error.message}）`
                : `脚本异常退出（signal ${String(signal)}）`;
        console.warn(
          `[computer-use] 关窗脚本退出码 ${String(status)}（${reason}，${Date.now() - startedAt}ms），交由强杀兜底（pid ${pid}）`,
        );
        resolve();
      };
      const child = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildCloseSandboxWindowScript(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      // 45 秒硬上限（同以前的 spawnSync timeout）：超时就杀掉它，文件已经落了就不管了
      const timer = setTimeout(() => settle(3, undefined, null), 45_000);
      child.on("error", (cause) => settle(null, cause, null));
      child.on("exit", (code, signal) => settle(code, undefined, signal));
    });

  /**
   * 让 guest 自己关机（关沙箱的首选路径，2026-11-13 真机验收）：
   *   ① 原子写 `out/shutdown.request`——「刚起就关」时命令通道还没通，桥登入后第一件事
   *      就是读这个文件并关机（guest-bridge 0.13.0 的 ConsumeShutdownRequest）；
   *   ② 再发一条 `shutdown` 命令：桥已经在跑时走这条路（真机回执 29ms）。
   * 第 2 步超时 5 秒是有意的：VM 一关，回执可能永远不来，不能在这里等 30 秒。
   * 失败只记日志——调用方还会等进程消失，等不到才退到关窗 / 强杀。
   */
  const requestGuestShutdown = async (outDir: string): Promise<void> => {
    if (process.platform !== "win32") return;
    try {
      await writeTextAtomic(join(outDir, COMPUTER_USE_SHUTDOWN_REQUEST_FILE), new Date().toISOString());
    } catch (cause: unknown) {
      console.warn(`[computer-use] 写关机请求失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    // 桥还没通告（刚起就关）时不用发命令：文件已经在了，桥登入第一件事就是读它；
    // 发也只会白等一轮 5 秒超时（文件通道 + TCP 探活）。bridge.json 在 = 桥真的活着，才值得发。
    if (!existsSync(join(outDir, BRIDGE_INFO_FILE))) return;
    try {
      await sendGuestCommand(outDir, computerUseGuestCommands.shutdown, {}, 5_000);
    } catch (cause: unknown) {
      // 桥还没登入 / 已经开机关机了：都正常，主路径靠那个文件
      console.warn(`[computer-use] shutdown 命令没送到 guest：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };


  const wsbComputerUse = new SandboxController({
    computerUseDir: join(configDir, "computer-use"),
    bridgeDir: app.isPackaged
      ? join(process.resourcesPath, "guest-bridge")
      : join(app.getAppPath(), "guest-bridge", "bin"),
    sandboxExePath,
    /**
     * 沙箱进程适配。**关闭必须杀整棵树**：spawn 出来的 WindowsSandbox.exe 是 launcher，
     * 看得见的沙箱窗口是它的子进程 WindowsSandboxClient.exe——只杀 launcher 会留下
     * 孤儿窗口，VM 一拆它就弹「与沙盒的连接已丢失 0x80072746」（2026-10-12 实测）。
     * taskkill /T 是异步火力覆盖（同 terminal/runtime.ts 的杀树纪律）；它起不来 /
     * 失败时退回单进程杀——宁可退化回孤儿窗口，也不能让「关闭」本身失效。
     */
    spawnSandbox: (wsbPath) => {
      const child = spawn(sandboxExePath, [wsbPath], { stdio: "ignore" });
      const killChild = child.kill.bind(child);
      const killTree = (): boolean => {
        const pid = child.pid;
        if (pid === undefined) return killChild();
        killTreeByPid(pid, () => {
          try {
            killChild();
          } catch {
            // 进程已退出
          }
        });
        return true;
      };
      return Object.assign(child, { kill: killTree });
    },
    /**
     * 沙箱出网（设置 › 实验功能 › 电脑使用）。**每次启动读一次**：.wsb 只在 start() 里渲染，
     * 运行中的 VM 改不了网络，所以这里不做推送、不自动重启（重启会砸掉正在跑的网页自动化）。
     * 读的是同一个 SettingsStore（有缓存），不新开一套读写。
     */
    allowNetwork: async () => effectiveAllowNetwork(await settings.read()),
    /**
     * 应用级准入白名单（intra-guest 判定用）：内置 msedge.exe ∪ 设置里的 allowedApps。
     * **每条做准入判定的命令现读一次**（不写 .wsb、不用重启沙箱）：改设置下一条点击就生效。
     * SettingsStore 有缓存，命中时只是一次对象读取。
     */
    allowedApps: async () => effectiveGuestAllowExe(await settings.read()),
    // 升级杀：第一次 kill 在兜底窗口内没换来退出时，按 PID 再打一次进程树
    killTreeByPid,
    /**
     * 观测沙箱侧进程（只读，不杀）。
     *
     * 2026-10-23（Windows 更新后的新沙箱架构）实测：`WindowsSandbox.exe` 只是启动器——
     * spawn 后 **0 秒就以 code 0 退出**，把 VM 交给 `WindowsSandboxServer`；真正占着 ~2.5GB
     * 的是 `WindowsSandboxServer.exe` / `WindowsSandboxRemoteSession.exe` / `vmwp.exe`。
     * 于是 stop 时 child 早就为 null、没有 PID 可杀（第二天主会话得手动 taskkill /T /F 清）。
     * 这里只提供「现在有哪些沙箱侧进程」的观测，由控制器拿**启动前基线**做差集认出我们
     * 自己那只；杀掉仍然走上面的 killTreeByPid（taskkill /T /F）——**不按镜像名杀**（仓规）。
     */
    listSandboxProcesses,
    // 优雅关窗：强杀窗口会把 VM 留给宿主（真机实测 3.4GB 不释放），见 closeSandboxWindow 的注释
    closeSandboxWindow,
    // 首选：让 guest 自己关机（VM 停了窗口自然消失，不碰确认框）
    requestGuestShutdown,
    onStatus: (status) => {
      /*
       * 沙箱没了（用户停 / 启动失败 / 运行中崩了），手上那把「桌面归谁」的租约一并作废：
       * 持有者与排队者都是等着用同一个已经不存在的东西，留着只会让排队的会话排满
       * 30 秒后收到一句「被某个会话占着」——那是一个不成立的原因。
       * 这一顿用 ComputerUseLease（定义在 computer-use/lease.ts）。浏览器键也一起作废——
       * 浏览器在沙箱里，沙箱没了它们就不存在了。
       */
      if (status.state === "off" || status.state === "error") {
        computerUseLease.revoke(
          status.state === "off" ? cuTexts().leaseReasonSandboxStopped : cuTexts().leaseReasonSandboxError,
        );
      }
      broadcastComputerUseStatus(status);
    },
  });
  /**
   * 沙箱里的资源归谁：一块桌面归一个会话（理由与状态机见 computer-use/lease.ts），
   * 每个会话自己的浏览器归它自己（不占桌面）。
   * 放在 SandboxController 之前声明——控制器的 onStatus 要引用它（TDZ：onStatus 只会在
   * 后面的迁移中执行，但读到变量本身仍需要先声明）。
   */
  const computerUseLease = createComputerUseLease({
    clock: { now: () => Date.now(), setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    } },
    onEvent: (event) => {
      if (event.type === "acquired") {
        console.log(
          `[computer-use] ${event.key} 交给「${event.title || event.sessionId}」（等了 ${String(event.waitedMs)}ms，后面排 ${String(event.queueDepth)} 个）`,
        );
        return;
      }
      if (event.type === "released") {
        console.log(
          `[computer-use] ${event.key} 收回（「${event.title || event.sessionId}」，原因 ${event.reason}，持有了 ${String(event.heldMs)}ms）`,
        );
        // 硬上限强制收回：持有者下一条命令不该因为「锁空着」就静默拿到——
        // 它已经在一个被裁定为「占得太久」的轮次里了，要让它把这句话转告用户。
        // 只有桌面键有硬上限，浏览器键永远不会走到这个分支。
        if (event.reason === "holdExpired") computerUseDispatch.noteHoldExpired(event.sessionId);
        return;
      }
      if (event.type === "revoked") {
        console.log(
          `[computer-use] 租约全部作废：${event.reason}（${String(event.keys)} 个资源键，清掉 ${String(event.droppedWaiters)} 个等待者）`,
        );
        return;
      }
      if (event.type === "rejected") {
        console.warn(`[computer-use] 没拿到 ${event.key}：${event.sessionId}（${event.cause}）`);
      }
    },
  });
  /**
   * 运行时门面：两个隔离后端（L2 Windows 沙箱 / L2b 多会话隔离）选一个。
   *
   * L2b 的依赖（MXC 的 IsolationSession）是**可选**的：它的 SDK 会加载一个原生 DLL，
   * 所以只在真正探测/启动时碰它（createMxcSdk 内部就是那个边界）；没装 / Node 不够 / 非
   * Windows 时它只回一句带原因的话，不影响 L2 与 L1。
   *
   * `backend` 每次 start 现读设置：改档位不改正在跑的那一只（与出网开关同一条纪律——
   * 运行中的隔离环境改不了形态，只能下次启动生效）。
   */
  const computerUseIsolation = new IsolationSessionController({
    bridgeDir: app.isPackaged
      ? join(process.resourcesPath, "guest-bridge")
      : join(app.getAppPath(), "guest-bridge", "bin"),
    sdk: createMxcSdk(),
    // 清理验证要判「agent 账号真的没了」：工作区之外，profile 目录也必须消失
    usersRoot: join(process.env.SystemDrive ?? "C:", "Users"),
    allowedApps: async () => effectiveGuestAllowExe(await settings.read()),
    onStatus: (status) => {
      // 与 L2 同一条纪律：隔离环境没了，桌面租约一并作废（排队者等的是一个不存在的东西）
      if (status.state === "off" || status.state === "error") {
        computerUseLease.revoke(
          status.state === "off" ? cuTexts().leaseReasonIsolationStopped : cuTexts().leaseReasonIsolationError,
        );
      }
      broadcastComputerUseStatus(status);
    },
  });
  /**
   * 开发者后端（qemu）的开关：默认关，只有以 ORBITA_CU_DEV_BACKENDS=1 启动应用才开。
   * 启动时读一次：它在本次运行里不会变（环境变量不热更新）。两处消费同一个值——
   * 运行时门面的 start 闸门与设置页拿到的可选列表，不能一处开一处关。
   */
  const computerUseDevBackends = devBackendsEnabled(process.env);
  const computerUse = createComputerUseRuntime({
    wsb: wsbComputerUse,
    isolation: computerUseIsolation,
    backend: async () => effectiveComputerUseBackend(await settings.read()),
    devBackends: () => computerUseDevBackends,
    /**
     * L3（QEMU）的断网：同一份设置、同一个读取点（WSB 的那份在控制器自身）。
     * L2b 读不读它都一样——它断不了网（shared/computer-use.ts 的 backendNetworkControl），
     * 提示词也因此不会对它说「你没网」。
     */
    allowNetwork: async () => effectiveAllowNetwork(await settings.read()),
    probeIsolation: () => computerUseIsolation.probe(),
  });
  /**
   * CDP 浏览器通道（PR3）：沙箱里有几个浏览器实例的会话级状态。
   *
   * v1.5-1 起**一个 agent 会话一个浏览器**（不再是全员共用一份）：宿主这一侧按会话记「起没起」
   * 的缓存，每条 `cdp-*` 都带 session 字段；WebSocket、标签页、选择器表全在 guest 桥里。
   * outDir 与 SandboxController 的映射输出目录是同一个：`<userData>/computer-use/out` ↔
   * guest 的 `C:\orbita-out`。
   * 用闭包转一道而不是直接传 controller：CdpGuest 只需要两个方法，测试注入假桥足够。
   *
   * 第三个参数是沙箱浏览器的选择（设置 › 电脑使用 › 沙箱浏览器）：与 allowedApps 同一条路——
   * 每条 cdp-start 现读一次设置（SettingsStore 有缓存），改了下一次拉起就生效。
   * 不写 .wsb、不用重启沙箱：浏览器是在 guest 里被拉起来的，不属于 VM 的网络/配置。
   */
  const cdp = new CdpSession(
    {
      guestCommandReply: (command, fields) => computerUse.guestCommandReply(command, fields),
      guestShot: (command, fields) => computerUse.guestShot(command, fields),
    },
    join(configDir, "computer-use", "out"),
    async () => effectiveGuestBrowser(await settings.read()),
    // 遮罩标签跟界面语言走（overlay 画在用户网页里：英文界面不许露中文）
    async () => effectiveLanguage((await settings.read()).language),
  );

  /**
   * computer_* / sandbox_* 下发前的唯一入口：按动作选资源键（桌面独占 / 每会话浏览器），
   * 要不到就回一句人话，要到了才下发。键的选择与硬上限的收尾都在 dispatch.ts 里——
   * 这样「sandbox_* 在别人持桌面时照常下发」这条回归才有地方可测（它不碰 electron）。
   * 按窗口截图（computer_screenshot + window）与 UIA 车道（uia-list / uia-act）**不取任何键**：
   * 前者读窗口自己的 surface，被遮挡也能拍、不抢焦点；后者直接调控件的 UIA 模式，AutoSetFocus
   * 关掉之后不移动前台焦点（focus 动作已被删——它动的是桌面级焦点）。两条都不依赖
   * 「屏幕上现在是什么」，所以不占桌面独占（理由见 dispatch.ts 与 shared/computer-use.ts）。
   *
   * 标题只是文案素材：拿不到锁时的错误要说出**占用者是谁**，不然模型无法转告用户
   * （「被占据了」而不说是谁，用户也没法处置）。读不出 meta（会话刚建、已删）就退成空串，
   * 租约那边不会塞一对空引号。
   */
  const computerUseDispatch = createComputerUseDispatcher({
    lease: computerUseLease,
    titleOf: async (sessionId) => {
      const meta = await sessions.readMeta(sessionId).catch(() => null);
      return meta?.title ?? "";
    },
    /**
     * 第四个参数是**当前在跑那个后端**的能力声明：agent-requests 按它的 evidence 门控交付档位
     * （没有读回的后端——L3 的 Linux 桌面——永不出 confirmed / suspected_noop）。没在跑时
     * capabilities() 为 null，闸门不拦也不猜（与改之前一致）。
     */
    runPixels: (sessionId, request) =>
      applyComputerUseRequest(computerUse, sessionId, request, computerUse.capabilities()),
    /**
     * 浏览器通道。**L2b 里上传/下载目前不支持**：桥把映射目录写死在 `C:\orbita-out`，而
     * 独立会话里没有那个目录（它的映射目录是自己的工作区）。让它发下去会「成功」——
     * 文件落在会话内部、宿主永远拿不到——所以在这里就拒，并告诉模型换路。
     */
    runBrowser: (sessionId, request) => {
      // 按后端声明判断，不按 id 猜：`sandboxFiles: false` 的后端（L2b）guest 里没有宿主那份
      // 映射目录，发下去会「成功」而文件落在 guest 内部、宿主永远拿不到。没在跑时 capabilities
      // 为 null，闸门不拦（与改动前一致：那时 cdp 自己会回「沙箱没在跑」）。
      if (
        computerUse.capabilities()?.sandboxFiles === false &&
        (request.action === "sandbox-upload" || request.action === "sandbox-download")
      ) {
        return Promise.resolve({
          ok: false,
          error:
            "这个隔离档位（多会话隔离）暂不支持文件上传/下载：会话里的映射目录与宿主不同路径。" +
            "导航、点击、输入、截图与读页面都可用；要传文件请改用内置浏览器，或切回 Windows 沙箱档。",
        });
      }
      return applySandboxBrowserRequest(cdp, sessionId, request);
    },
    // 桌面租约的粒度跟着后端：L2 一块共享屏幕（全局），L2b 每会话一个桌面（见 runtime.ts）
    desktopKey: (sessionId) => computerUse.desktopKey(sessionId),
  });
  /**
   * 急停热键（computer use PR4）：`Control+Alt+Shift+Escape`。沙箱窗口在前台时用户够不到
   * Orbita 的停止按钮，这个热键必须真的能注册上——注册失败（被别的应用占用）时
   * 设置页会如实显示「不可用」，不假装保护存在。
   *
   * 按下后三件事（顺序即语义）：
   *   1. 正在跑的会话逐个中止（给 agent 发 abort，与「停止」同一条链）；
   *   2. **撕掉电脑使用授权**：所有非 unset 的会话 `computerUseConsent` 复位成 unset；
   *      挂起中的授权提问按 **cancelled** 结掉（不写盘——用户没有表态，不是拒绝）。
   *      （不是 PermissionMode，只是本会话的桌面许可）
   *   3. 广播给 renderer 显示「已急停」。
   * **不关沙箱**：现场留给用户看，关沙箱是设置页里另一个动作。
   *
   * `phases` / `agentHost` 在本行下面才声明——onTrigger 只在按键时执行，那时已初始化
   * （与 mcpIpc / delegate 的 TDZ 说明同一条约定）。
   */
  /**
   * 热键注册早于 `phases` / `agentHost` 的创建（它们在下面）。启动那几毫秒里按下热键
   * 不能去碰还没初始化的 const（TDZ 会抛 ReferenceError）：置位前按键直接忽略——
   * 那时也没有轮可停。
   */
  let emergencyStopReady = false;
  const emergencyStop = createEmergencyStop({
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    onTrigger: () => {
      if (!emergencyStopReady) return;
      const at = Date.now();
      const runningSessions = [...phases.entries()]
        .filter(([, phase]) => phase !== "idle")
        .map(([id]) => id);
      for (const sessionId of runningSessions) agentHost.abortIfRunning(sessionId);
      /*
       * 急停要**彻底撕掉电脑使用授权**（2026-11-27；验收后修正）：
       *   1. 挂起的提问先按 **cancelled** 结掉（不写 meta）——把 cancel 放在 reset 之后写、
       *      或者让 cancel 写 denied，会让最终值变成 denied（"以后不再问"），与急停相反；
       *   2. **所有**非 unset 的会话复位成 unset：急停是全局按钮，它的语义是「我不想再让
       *      这台桌面被动」——只复位在跑的会话会留下一个刚点过允许、正空闲的会话，下一轮
       *      直接用、不再问（E 段验收指出的差距）。
       * 两道写都在各自的 meta 写链上，但 canceled 的那支**不写**，所以最终值只可能是
       * reset 写的 unset。
       */
      computerUseConsentWaiter.cancelAll();
      void (async () => {
        const all = await sessions.list().catch(() => []);
        for (const meta of all) {
          if (parseComputerUseConsent(meta.computerUseConsent) === "unset") continue;
          await computerUseConsentGate.reset(meta.id, "emergency-stop");
        }
      })();
      broadcastAgentEvent({ type: "computerUseEmergencyStop", at, sessionIds: runningSessions });
    },
  });
  // 与急停控制器一起注册（IPC 只能注册一次）：hooks 是 PR3 的停沙箱收尾——用户停沙箱时先把
  // 里面的浏览器逐个会话停掉（best effort、不等待：不能用一串浏览器命令拖住停沙箱按钮；
  // 桥已经死了就算了，VM 销毁会带走整个进程树）。
  // 租约也交给它：设置页「沙箱归属」一行读的是 dispatch 拿锁用的同一份桌面租约。
  registerComputerUseIpc(
    computerUse,
    {
      beforeStop: () => {
        void cdp.stopAll();
      },
      backends: () => computerUseBackendChoices(computerUseDevBackends),
    },
    emergencyStop,
    computerUseLease,
    // 确认行 / 状态行的回答：只有 allowed / denied 两种，由 IPC 入口洗过再进来
    { answer: (requestId, decision) => computerUseConsentWaiter.answer(requestId, decision === "allowed") },
  );

  // 子会话：主进程按 phase 事件维护的活会话状态——channel/requests.ts 靠它判断
  // 投递目标此刻是不是空闲（空闲退化 submit，在跑才 steer）
  const phases = new Map<string, SessionPhase>();
  const channelReconciler = new ChannelReconciler({ sessions, channels, phases, broadcast: broadcastChannelEvent });
  const channelIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelChannelIdleClose = (sessionId: string): void => {
    clearTimeout(channelIdleTimers.get(sessionId));
    channelIdleTimers.delete(sessionId);
  };
  const scheduleChannelIdleClose = (sessionId: string): void => {
    cancelChannelIdleClose(sessionId);
    // item_finished 的 record() 是异步落盘。等一个很短轮尾再读，且落账前还会复查 phase / 账本；
    // 用户立刻重试或终止时这一轮清扫会作废，不会关掉新轮。
    const timer = setTimeout(() => {
      channelIdleTimers.delete(sessionId);
      void channelReconciler
        .reconcileSession(sessionId, { interruptedCause: "incomplete" })
        .catch((cause: unknown) => console.error("[channel] 子会话轮尾收尾失败", sessionId, cause));
    }, 80);
    channelIdleTimers.set(sessionId, timer);
  };
  const closeChannelsForLostProcess = (): void => {
    const lost = [...phases].filter(([, phase]) => phase !== "idle").map(([sessionId]) => sessionId);
    phases.clear();
    for (const sessionId of lost) {
      cancelChannelIdleClose(sessionId);
      void channelReconciler
        .reconcileSession(sessionId, { interruptedCause: "process-exit", force: true })
        .catch((cause: unknown) => console.error("[channel] agent 进程退出后的子会话收尾失败", sessionId, cause));
    }
  };
  /*
   * 额度缓存只建一份：provider 的额度查询（registerProviderIpc）与 failed 事件的
   * 额度补丁读同一份 `<userData>/quota-cache.json`。
   */
  const quotaCache = new QuotaCache(configDir);
  /**
   * 给这条会话的失败找一个「额度窗口用尽」的提示。
   *
   * 判据只有缓存快照（`quotaHintOf`），**不按厂商文案匹配**——各家措辞不同，
   * 匹配表一定会漏，还会把「钥匙错」误判成「额度用尽」。缓存过期 / 从没查过 /
   * 窗口没满都返回 null：宁可不解释，也不编。
   *
   * **它不能拿来判定失败原因**：缓存只说明「这个窗口满了」这个事实，不说明本次
   * 失败是它造成的——「钥匙过期 + 恰好有个窗口满了」时主因是 401。要判定原因就
   * 得按厂商文案做匹配，那是我们明确拒绝的做法。所以渲染层把它放在厂商原文
   * 之后的副行，写成「账户额度：…」而不是「失败原因：…」。
   *
   * **全程不抛**：读盘出错只是少一句提示，不该把这条失败事件本身弄丢——
   * 用户至少还看得到厂商原文。
   */
  const quotaHintFor = async (sessionId: string): Promise<QuotaExhaustedHint | null> => {
    try {
      const meta = await sessions.readMeta(sessionId);
      if (meta === null) return null;
      const snapshot = (await quotaCache.read())[meta.providerId] ?? null;
      return quotaHintOf(snapshot, Date.now());
    } catch (cause) {
      console.error("[quota] 失败事件补额度提示时读缓存出错", sessionId, cause);
      return null;
    }
  };
  // 「生成形象」的任务表：在 agentIpc 之后才建（要它的 submitTurn），agent 事件先到的话这里是 null、不旁听
  let avatarJobs: AvatarJobs | null = null;
  // 随包的 rg / fd 挂到 agent 进程 PATH 最前面：pi 的 grep / find 不再去 GitHub 下载（search-bins.ts）。
  // 目录不在（开发版没跑过 fetch 脚本）就原样给环境，pi 照旧自己找
  const searchBins = bundledBinDir({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
  });
  // pi 打进 bundle 后会把 Orbita 的 package.json 当成自己的，版本号错了 pi.dev 的目录就是 404（pi-package.ts）
  const piPackage = piPackageDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  const agentProcessEnv = {
    ...(existsSync(searchBins) ? agentEnv(process.env, searchBins, process.platform) : process.env),
    // pi.dev 目录覆盖层的缓存落我们自己的数据目录（model-catalog.ts），不写 pi CLI 的 ~/.pi/agent
    [CATALOG_CACHE_ENV]: join(configDir, "model-catalog-cache.json"),
    ...(existsSync(join(piPackage, "package.json")) ? { [PI_PACKAGE_DIR_ENV]: piPackage } : {}),
  };
  const agentHost = new AgentHost(resolveRuntimePath(__dirname), agentProcessEnv, (event) => {
    // MCP 的连接状态由 agent 进程报上来（连接是它建的），主进程缓存最后一次快照给管理面看
    if (event.type === "mcp") mcpIpc.onAgentSnapshot(event.servers);
    // 4-3：agent 工具的写盘请求——主进程落盘、回执、广播刷新。
    if (event.type === "skillWriteRequest") {
      void applySkillWrite(skills, sessions, event).then((result) => {
        agentHost.answerSkillWrite(event.requestId, result);
        if (result.ok) broadcastAgentEvent({ type: "skillsChanged" });
      });
      return;
    }
    if (event.type === "mcpWriteRequest") {
      void applyMcpWrite(mcp, () => agentHost.mcpReload(), (name) => mcpIpc.statusOf(name), event).then(
        (result) => {
          agentHost.answerMcpWrite(event.requestId, result);
        },
      );
      return;
    }
    // 插件：agent 的 install_plugin / preview_plugin / list_plugins，都立即回执（不等用户）。
    // 任何路径都回执，否则 agent 进程里那次工具调用挂到超时
    if (event.type === "pluginInstallRequest") {
      void pluginAgent
        .install(event)
        .catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }))
        .then((outcome) => agentHost.answerPluginInstall(event.requestId, outcome));
      return;
    }
    if (event.type === "pluginPreviewRequest") {
      void pluginAgent
        .previewDraft(event)
        .catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }))
        .then((outcome) => agentHost.answerPluginPreview(event.requestId, outcome));
      return;
    }
    if (event.type === "pluginBoardRequest") {
      void pluginBoards
        .snapshot(event)
        .catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }))
        .then((outcome) => agentHost.answerPluginBoard(event.requestId, outcome));
      return;
    }
    if (event.type === "pluginListRequest") {
      void pluginAgent
        .list(event)
        .catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }))
        .then((outcome) => agentHost.answerPluginList(event.requestId, outcome));
      return;
    }
    // 子会话：delegate 工具 / 通道发信请求——照 readTaskRequest 的形态，任何路径
    // 都必须回执，否则 agent 进程里的工具调用永远挂着。deps 声明在本文件靠后的
    // 位置（拿 registerAgentIpc 返回的 submitTurn），这里引用它安全：onEvent 只在
    // 事件到达时执行，那时已定义（同 mcpIpc 的 TDZ 说明）。不 record、不 broadcast
    // 这两种请求事件本身——它们不是要落盘或转发给 renderer 的对话事件。
    if (event.type === "delegateRequest") {
      void applyDelegate(deps, event)
        .then((outcome) => agentHost.answerDelegate(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerDelegate(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 派发参考：agent 的 model_costs——数据（任务账本、服务商声明）在主进程。同样任何路径都回执
    if (event.type === "modelCostsRequest") {
      void applyModelCosts(() => priceChart())
        .then((outcome) => agentHost.answerModelCosts(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerModelCosts(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 自动化：agent 的 automation_create / list / cancel——存盘在主进程，任何路径都回执
    if (event.type === "automationRequest") {
      void applyAutomationRequest(automationDeps, event)
        .then((outcome) => agentHost.answerAutomation(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerAutomation(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 子智能体：agent 的 create_sub_agent / update_sub_agent / revise_sub_agent_avatar / list_sub_agents——写工作区 planet/ 在主进程，任何路径都回执
    if (event.type === "subAgentRequest") {
      void applySubAgentRequest(
        {
          sessions,
          workspaces,
          settings,
          store: subAgentStore,
          broadcast: (change) => broadcastAgentEvent({ type: "subAgentsChanged", ...change }),
          // 聊天里建的子智能体没带地表图：走面板同一套出图（候选进同一个挑选面板）
          startAvatar: async (workspaceId, bodyId, instruction) =>
            avatarJobs === null ? { ok: false, error: "出图还没就绪" } : avatarJobs.generate({ workspaceId, bodyId, ...(instruction === undefined ? {} : { instruction, useCurrentSurface: true }) }),
        },
        event,
      )
        .then((outcome) => agentHost.answerSubAgent(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerSubAgent(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    if (event.type === "channelSendRequest") {
      void applyChannelSend(deps, event)
        .then((outcome) => agentHost.answerChannelSend(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerChannelSend(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 子会话：主进程按 phase 事件维护活会话状态；runtime 整个退出时全部会话的
    // 活跑状态都不可信了，清空。**都不 return**——事件照常往下 record + broadcast
    // （failed(null) 本来就要转发给 renderer，告诉它进程挂了）。
    if (event.type === "phase") {
      phases.set(event.sessionId, event.phase);
      if (event.phase === "idle") scheduleChannelIdleClose(event.sessionId);
      else cancelChannelIdleClose(event.sessionId);
    }
    // 「生成形象」的幕后会话停了：收尾这一组候选（只旁听，不 return）
    avatarJobs?.onAgentEvent(event);
    // 自动化的运行收尾 / this_session 的等待送达都靠这些事件（phase idle、最终回答、stats、failed）。
    // 只旁听，不 return：事件照常往下 record + broadcast
    automationScheduler.onAgentEvent(event);
    // 这一轮停了（完成、被用户停掉、出错）：还挂着的交接按取消结掉——等它的那次工具调用已经不在了
    if (event.type === "phase" && event.phase === "idle") {
      browserSandbox.cancelSessionHandoff(event.sessionId);
      /*
       * 电脑使用授权挂起的提问一并作废（2026-11-27 验收 P1）：这一轮已经结束，
       * 那个提问不可能再被回答。**按 cancelled 结，不按 denied**——用户没有表态；
       * 按 denied 结会让停轮之后迟迟点在确认行上的「允许」真的执行一个已不存在的
       * 动作，并会在 120s 后把从没拒绝过的会话永久写成 denied。
       */
      computerUseConsentWaiter.cancel(event.sessionId);
      /*
       * 沙箱资源也一并让出来：轮次结束 = 这一轮不再需要它们了。abort 与急停走的都是这里
       * （abortCycle 的收尾最终发 idle，非 preempt 的预抢跑才不发），所以不需要在三条
       * 路径上各接一次。桌面键与这个会话的浏览器键一起放：不主动放的话，下一个会话要白白
       * 等到 idle 线 60s 或硬上限 15min。浏览器键下一次 sandbox_* 再 acquire 是立刻成功的。
       */
      computerUseLease.releaseSession(event.sessionId);
    }
    if (event.type === "failed" && event.sessionId === null) {
      // agent 进程整个没了：所有租约持有者与等待者都不存在了（工具调用已随进程消失），
      // 留着只会让下一个会话排满 30 秒再报一句「被某个会话占着」
      computerUseLease.revoke(cuTexts().leaseReasonAgentExited);
      // 挂起的授权提问也没人再回答了：按 cancelled 结掉（不写 meta），renderer 收行
      computerUseConsentWaiter.cancelAll();
      closeChannelsForLostProcess();
    }
    // B-1：agent 的 read_task——读盘在主进程（SessionStore），回执带简报全文与任务卡。
    // 通道账本一并传进去：子会话每一轮的开头是通道消息，正文在那里。
    // 任何路径都必须回执（同 delegateRequest）：读盘抛错没有 catch 的话，agent 进程里的
    // read_task 调用永远挂着
    // 受管浏览器：agent 的浏览器工具——浏览器在主进程（browser/sandbox.ts）。同样任何路径都回执
    if (event.type === "browserRequest") {
      void applyBrowserRequest(browserSandbox, event.sessionId, event.request)
        .then((outcome) => agentHost.answerBrowser(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerBrowser(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 演示文稿导出：PDF / PNG 要隐藏窗口，只能在主进程。同样任何路径都回执
    if (event.type === "slidesRequest") {
      void resolveFileRoots(workspaces, sessions, { sessionId: event.sessionId, workspaceId: event.workspaceId })
        .then((roots) => applySlidesRequest({ roots, exportDeck }, event.request))
        .then((outcome) => agentHost.answerSlides(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerSlides(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 文档导出：docx / pdf / md 的生成在主进程（PDF 要隐藏窗口），UI 的导出菜单与 agent 共用同一套函数。同样任何路径都回执
    if (event.type === "docRequest") {
      void resolveFileRoots(workspaces, sessions, { sessionId: event.sessionId, workspaceId: event.workspaceId })
        .then((roots) => applyDocRequest({ roots, printPdf: printDocPdf }, event.request))
        .then((outcome) => agentHost.answerDoc(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerDoc(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 终端：agent 的终端工具——PTY 在主进程的 TerminalService（浏览器同一条边界）。
    // 同样任何路径都回执：挂着不回，agent 进程里那次工具调用永远等下去
    if (event.type === "terminalRequest") {
      void applyTerminalRequest(terminals, sessions, workspaces, event)
        .then((outcome) => agentHost.answerTerminal(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerTerminal(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // computer use：agent 的沙箱工具。
    //   computer_*（PR2）→ 像素注入，走 SandboxController；
    //   sandbox_*（PR3）→ 沙箱内 Edge 的 CDP 语义命令，走 CdpSession。
    // 两条通道都**只有 agent 进程看得见**（renderer 面只有 PR1 那四个入口）。
    // **先要租约再下发**：沙箱是一份、会话可以多个，不锁就是两条动作序列交错而两边
    // 都收到「成功」（三种可复现的错法写在 lease.ts 头部）。拿不到就不下发，直接回一句
    // 人话给模型——它看不见 UI，不会自己想到「另一个会话占着」。
    // 同样任何路径都回执：挂着不回，agent 进程里那次工具调用永远等下去。
    if (event.type === "computerUseRequest") {
      // 授权栅门（2026-11-27）：**所有**电脑工具（computer_* 像素/UIA + sandbox_* 浏览器）
      // 下发前先过会话授权——包括只读截图（它把用户沙箱桌面上的画面交给模型）。
      // unset → 问一次并挂起；denied → 当场回那句固定文本，不执行；没人能回答按 denied 落库。
      // 栅门只做裁决，拒绝文案在 shared 的 computerUseConsentTexts（按界面语言取，唯一来源）。
      void computerUseConsentGate
        .ensure(event.sessionId, event.request.action)
        .then((verdict) =>
          verdict.ok
            ? computerUseDispatch.dispatch(event.sessionId, event.request)
            : ({ ok: false, error: verdict.error } as const),
        )
        .then((outcome) => agentHost.answerComputerUse(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerComputerUse(event.requestId, {
            ok: false,
            // 出口的语言闸：dispatch 之外抛上来的（租约之外的那几层）也过一遍同样的映射
            error: guestErrorText(cause instanceof Error ? cause.message : String(cause), cuLanguage()),
          }),
        );
      return;
    }
    if (event.type === "readTaskRequest") {
      void applyReadTask(sessions, event, workspaces, channels, externalSessions)
        .then((result) => agentHost.answerReadTask(event.requestId, result))
        .catch((cause: unknown) =>
          agentHost.answerReadTask(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 记忆系统：agent 的轮前召回问答——转发给记忆服务
    // 进程（主进程按 scope 解析作用域），任何路径都回执（readTaskRequest 同款
    // 纪律：不回的话 agent 进程里那次调用挂到超时）。服务不在先试拉一把（开关
    // 刚开的第一轮 / 崩溃后的一次自愈）；拉不起 / 超时都回空命中，不拦开轮
    if (event.type === "memoryRecallRequest") {
      void forwardMemoryRecall(memoryHost, event, ensureMemoryService)
        .then((outcome) => agentHost.answerMemoryRecall(event.requestId, outcome))
        .catch((cause: unknown) =>
          agentHost.answerMemoryRecall(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 记忆工具（memory_search / memory_revise / memory_retire）：同样任何路径都回执；
    // 子会话的写在 forwardMemoryTool 里按 meta 拒（「子会话读不写」不只靠不注册）
    if (event.type === "memoryToolRequest") {
      void forwardMemoryTool(
        {
          readMeta: (id) => sessions.readMeta(id),
          ensureStarted: ensureMemoryService,
          isRunning: () => memoryHost.isRunning(),
          agentTool: (input) => memoryHost.agentTool(input),
        },
        event,
      ).then((outcome) => agentHost.answerMemoryTool(event.requestId, outcome));
      return;
    }
    // 续轮开机的 created 没有等待者（submit 带 resume 时不等）：在这里把 pi 本子
    // 真值校准回 meta——open 失败退回新建时 pi 会换文件，按轮自愈。
    // 首轮的 created 由 submit handler 等待并建 meta，不经过这里。
    if (event.type === "created" && event.piSessionFile !== null) {
      void sessions.setPiSessionFile(event.sessionId, event.piSessionFile).catch(() => undefined);
      return;
    }
    // 轮尾文件账：落盘（recorder 写 blob + FileTurnRecord）之外，给 renderer 广播
    // 的是**剥掉正文的视图**（fileTurnView）——轮尾卡片不吃快照正文，1MB 的文件
    // 内容没有理由过 renderer 的 IPC。这是「主进程只转发不加工」的第二个例外
    // （第一个是落盘本身），理由同：正文进 renderer 是纯浪费。
    if (event.type === "fileTurn") {
      // 等**落盘完**再广播，并带上落盘记录的真 id——renderer 的轮尾卡拿它当 key
      // 与撤销的 turnId（单轮撤销按它回查账本），自造 id 会对不上盘
      void sessions
        .recordFileTurn(event.sessionId, event.changes, event.webArtifacts ?? [], event.webArtifactsBatch, event.mediaArtifacts ?? [])
        .then((record) => {
          if (record === null) return;
          broadcastAgentEvent({
            type: "fileTurnView",
            sessionId: event.sessionId,
            turnId: record.id,
            changes: record.changes.map((change) => ({
              path: change.path,
              added: change.added,
              removed: change.removed,
            })),
            // 旁路网页产物随视图过一道：卡片收起态就靠它出网页行；批量折叠的计数同路
            ...(record.webArtifacts !== undefined ? { webArtifacts: record.webArtifacts } : {}),
            ...(record.webArtifactsBatch !== undefined ? { webArtifactsBatch: record.webArtifactsBatch } : {}),
            ...(record.mediaArtifacts !== undefined ? { mediaArtifacts: record.mediaArtifacts } : {}),
          });
        })
        .catch((cause: unknown) =>
          console.error("[session] 轮尾文件账落盘失败", event.sessionId, cause),
        );
      return;
    }
    // 回合级失败补一句额度提示：额度快照只在主进程的缓存文件里，agent 进程与
    // renderer 都看不见——补数据只能在这一跳做。判据是快照本身（某个窗口已满且
    // 重置时刻在未来），不是厂商文案；补不上就原样广播。
    // 读 meta / 缓存是异步的，这条失败可能比紧随的 phase(idle) 晚到 renderer：
    // 不影响正确性——turnError 槽在 idle 上不清理（见 session-states.ts）。
    // **已知风险**：用户若在这几毫秒里开始了新一轮，这条晚到的失败会挂到新一轮上
    // （非 idle 的 phase 会清标注，但清除发生在这条之前）。读盘只有毫秒级，目前接受；
    // 以后若这里变成网络请求，必须加序号 / phase 守卫再广播。
    if (event.type === "failed" && event.turn === true && event.sessionId !== null) {
      const turnFailed = event;
      const sessionId = event.sessionId;
      // 子会话的模型错误就是确定终局：不等 phase idle，也不靠工具尾帧猜。根会话由 readMeta 检查跳过。
      void channelReconciler
        .reconcileSession(sessionId, { interruptedCause: "incomplete", failureText: event.message, force: true })
        .catch((cause: unknown) => console.error("[channel] 子会话模型失败收尾失败", sessionId, cause));
      void quotaHintFor(sessionId).then((quota) => {
        const out = quota === null ? turnFailed : { ...turnFailed, quota };
        intentIngest.onEvent(out);
        record(out);
        broadcastAgentEvent(out);
      });
      return;
    }
    // 内建目录（启动时一次，pi.dev 刷新后再一次）：不属于任何会话，不落账、不进意图存档，只转给窗口
    if (event.type === "builtins") {
      broadcastAgentEvent(event);
      return;
    }
    // 意图存档（实验功能）：盯回显 / 回答完成 / 轮落定，落定时发 /ingest。
    // 在 record 之前喂：与 recorder 各自独立，互不阻塞
    intentIngest.onEvent(event);
    // 记忆构建同一处喂：盯轮落定，正常结束的一轮
    // 交给记忆服务（跟踪器在下面定义，TDZ 说明同 intentIngest）
    memoryTurns.onEvent(event);
    record(event);
    broadcastAgentEvent(event);
    // 目录联网刷新只刷用户已添加的服务商用到的目录（审核 F-1）：每次拉起 agent 进程时现读一次
  }, async () => catalogIdsOfProviders(await providers.load()));
  // 急停热键此时可以真正干活了（phases / agentHost 都已就绪）
  emergencyStopReady = true;
  // MCP 的 IPC 面（1-1 起含热重载）。reload 回调闭包引用 agentHost——
  // 事件回调只在事件到达时执行，那时两边都已定义，不存在 TDZ 问题
  const mcpIpc = registerMcpIpc(mcp, workspaces, () => agentHost.mcpReload());
  // 删除会话时把 runtime 里那条 pi 会话也放掉——不然每开一条任务就多一份驻留，
  // 活到退出应用（刀 0-4 债务 A）。会话分支（session:branch）也要走 agent 进程裁 pi 本子
  /*
   * 意图系统（实验功能 intent-system）的主进程三件套：
   * 1. 存档跟踪器（/ingest）：submit 判定要存档时 begin，事件泵喂 onEvent；
   * 2. 回退作废钩子（/invalidate）：会话回退成功后把被退轮次的 turnId 送 intent-lab，
   *    服务端重生的上下文文件覆盖写回会话工作台；
   * 3. token 记账：intentRecallRecord 的 usage 进日账本（记录本身落会话 JSONL，
   *    账本可从那回填重建）。三者都只在实验开关开着时生效。
   */
  const intentIngest = new IntentIngestTracker({
    http: { post: (url, body) => postIntentIngest(url, body) },
    load: async (id) => {
      const detail = await sessions.load(id);
      return detail === null ? null : { title: detail.meta.title, transcript: detail.transcript };
    },
    readIntent: async () => {
      const current = await settings.read();
      if (current.experimentalFeatures?.["intent-system"] !== true) return null;
      return { baseUrl: effectiveIntentSettings(current.intent).baseUrl };
    },
  });
  const intentOnReverted = async (sessionId: string, turnIds: readonly string[]): Promise<void> => {
    try {
      const current = await settings.read();
      if (current.experimentalFeatures?.["intent-system"] !== true) return;
      const baseUrl = effectiveIntentSettings(current.intent).baseUrl;
      const outcome = await postIntentInvalidate(baseUrl, sessionId, turnIds);
      if (!outcome.ok) {
        console.error("[intent] 回退后的作废没送成（不影响回退；下一次召回会覆盖写上下文）", outcome.error);
      }
    } catch (cause) {
      console.error("[intent] 回退后的作废抛错（不影响回退）", cause);
    }
  };
  /*
   * 记忆系统的主进程两件套：
   * 1. 记忆服务进程的管家（开关开着时拉起，与 agent 进程同级的 utility 进程，
   *    env 沿 agent 那份——模型目录缓存的 env 变量在里面）；
   * 2. 轮次跟踪器：submit 时 begin（ipc.ts 已判根会话 + 用户原话），事件泵喂
   *    onEvent，轮落定时把这一轮交给服务。子会话不 begin（读记忆但不写）。
   * 实验开关关着时：submit 不 begin、服务不拉起，整条链路不碰。
   */
  const llamaCandidates = () =>
    llamaServerCandidates({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      platform: process.platform,
      arch: process.arch,
      env: process.env.ORBITA_LLAMA_SERVER,
    });
  const availableLlama = () => llamaCandidates().find((candidate) => existsSync(candidate.path)) ?? null;
  // 最近一次模型下载进度：status 拉取时与文件存在性合并；done 后清掉，让 ready 以文件为准
  let memoryDownloadState: MemoryModelFileState | null = null;
  const memoryHost = new MemoryServiceHost({
    runtimePath: resolveMemoryRuntimePath(__dirname),
    dir: join(configDir, "memory"),
    env: agentProcessEnv,
    // 服务侧任何写盘（提取落条目 / 事件段收尾 / 记忆库写操作）→ 广播给窗口刷新
    onChanged: () => broadcastAgentEvent({ type: "memoryChanged" }),
    onDownloadProgress: (progress) => {
      if (progress.phase === "downloading") {
        memoryDownloadState = {
          state: "downloading",
          received: progress.received,
          total: progress.total,
          source: progress.source,
        };
      } else if (progress.phase === "verifying") {
        memoryDownloadState = { state: "verifying" };
      } else if (progress.phase === "failed") {
        memoryDownloadState = { state: "failed", error: progress.error ?? "模型下载失败" };
      } else if (progress.phase === "cancelled") {
        // 用户取消：回到「没下载」，界面收起进度（不当失败报）
        memoryDownloadState = null;
      } else {
        memoryDownloadState = null;
        // rename 已完成：立即把 local 配置送进服务，触发补算，无需等下一次设置改动
        void syncVectorConfig().catch((cause: unknown) => console.error("[memory] 下载完成后的向量配置同步失败", cause));
      }
      broadcastAgentEvent({ type: "vectorDownload", progress });
    },
    onBackfillProgress: (progress) => broadcastAgentEvent({ type: "vectorBackfill", progress }),
  });

  /** 把主进程才知道的文件 / 二进制 / 设置事实发给服务；服务不在时消息丢弃，下次拉起会重发。 */
  async function syncVectorConfig(): Promise<void> {
    const current = await settings.read();
    const vectorSettings = effectiveVectorSettings(current.vector);
    const model = MEMORY_VECTOR_MODELS.find((candidate) => candidate.id === vectorSettings.model);
    if (model === undefined) {
      memoryHost.setVectorConfig(null);
      return;
    }
    const ggufPath = modelFilePath(model, configDir);
    memoryHost.setVectorConfig(
      vectorServiceConfig({
        settings: vectorSettings,
        ggufPath: existsSync(ggufPath) ? ggufPath : null,
        binaryPath: availableLlama()?.path ?? null,
      }),
    );
  }

  /** 所有拉起路径共用：ready/init 之后立即同步向量与电源，崩溃自愈也不会丢配置。 */
  const ensureMemoryService = async (): Promise<boolean> => {
    // init 要带上家务活模型：启动清扫会续提上次没提完的段（退出前没收尾的、
    // 提取调用失败留账的），init 里没有模型就只能干等用户下一句话。setChore
    // 以前没有任何调用点，init 永远不带模型（2026-10-29 实例 memui 实测：重启后
    // 「有待提取的事件段，但没有家务活模型」，三个段挂着不提）
    if (!memoryHost.isRunning()) memoryHost.setChore(await choreModelPayload(settings, providers));
    const started = await memoryHost.ensureStarted();
    if (!started) return false;
    await syncVectorConfig();
    memoryHost.setPower(powerMonitor.isOnBatteryPower());
    return true;
  };
  powerMonitor.on("on-battery", () => memoryHost.setPower(true));
  powerMonitor.on("on-ac", () => memoryHost.setPower(false));

  const memoryTurns = new MemoryTurnTracker({
    load: async (id) => {
      const detail = await sessions.load(id);
      return detail === null ? null : { transcript: detail.transcript };
    },
    readMeta: (id) => sessions.readMeta(id),
    readChore: () => choreModelPayload(settings, providers),
    settle: async (payload) => {
      // 轮后兑现时确保服务在跑（崩溃后自愈；已拉起时这里是空操作）。
      // 没拉起来照样交给 host：它在「服务不在」时记一行带会话 / 轮号的丢弃诊断。
      // 抛错由跟踪器的 deliver 接住记日志（settle 的 Promise 在那里被 await）
      await ensureMemoryService();
      memoryHost.turnSettled(payload);
    },
  });
  /**
   * 会话回退后的记忆钩子：第 fromTurn 轮起被撤回 → 服务截段（重说的轮照常收）+ 停用来源轮
   * 全被撤回的条目。只给根会话发（子会话不写记忆，发了也是一次白扫全库）。
   * 失败只记日志，回退本身已经完成
   */
  const memoryOnReverted = async (sessionId: string, fromTurn: number): Promise<void> => {
    try {
      const meta = await sessions.readMeta(sessionId);
      if (meta === null || meta.parentId !== undefined) return;
      await ensureMemoryService();
      memoryHost.sessionReverted(sessionId, fromTurn);
    } catch (cause) {
      console.error("[memory] 回退后的记忆停用 / 截段没送成（不影响回退）", cause);
    }
  };
  // 启动即拉起服务——启动清扫要处理上次退出留下的旧段（闲置追认 /
  // 半路提取续跑），不等第一轮对话才动。失败只记日志（下次轮后再试拉起）
  void ensureMemoryService().catch((cause: unknown) => console.error("[memory] 启动 / 同步服务失败", cause));
  /*
   * 从历史生成：记忆系统上线前的聊天记录按历史时间正序逐轮喂给
   * 记忆服务。「处理过没有」只问段文件（主进程只读），任务快照落在 memory/ 外面——
   * memory/ 只有服务一个写者
   */
  const memoryHistoryFile = join(configDir, "memory-history.json");
  const memoryHistory = new MemoryHistoryJob({
    listSessions: () => sessions.list(),
    workspaces: () => workspaces.list(),
    load: (id) => sessions.load(id),
    processedTurns: () => new EpisodeStore(join(configDir, "memory")).processedTurns(),
    chore: async () => {
      const choice = (await settings.read()).choreModel;
      return choice === undefined ? null : { providerId: choice.providerId, modelId: choice.modelId };
    },
    prepare: async () => {
      const chore = await choreModelPayload(settings, providers);
      if (chore === undefined) return "没配家务活模型（设置 › 模型服务 › 家务活模型）";
      memoryHost.setChore(chore);
      return (await ensureMemoryService()) ? null : "记忆服务没能拉起";
    },
    step: (input) => memoryHost.historyStep(input),
    readState: async () => {
      try {
        return parseHistoryStatus(JSON.parse(await readFile(memoryHistoryFile, "utf8")));
      } catch (cause) {
        if (isNotFound(cause)) return null;
        throw cause;
      }
    },
    writeState: (status) => writeJsonAtomic(memoryHistoryFile, status),
    emit: (status) => broadcastAgentEvent({ type: "memoryHistory", status }),
    gapMs: EPISODE_IDLE_CLOSE_MS,
  });
  // 记忆库的读写面：读在主进程直读 JSONL，写转发给
  // 记忆服务（唯一写者）；会话标题 / 工作区名这些连接属性在这里注入
  registerMemoryIpc({
    history: memoryHistory,
    dir: join(configDir, "memory"),
    deps: {
      sessionTitleOf: async (id) => (await sessions.readMeta(id).catch(() => null))?.title ?? null,
      workspaces: async () => workspaces.list(),
      readMeta: (id) => sessions.readMeta(id),
      sessions: () => sessions.list(),
    },
    mutate: async (mutation) => {
      // 服务不在先拉（开关刚开的第一轮 / 崩溃后自愈）；拉不起 mutate 会回 ok:false
      if (!memoryHost.isRunning()) await ensureMemoryService();
      return memoryHost.mutate(mutation);
    },
    vector: {
      readVectorSettings: async () => (await settings.read()).vector,
      writeVectorSettings: async (patch) => {
        const before = effectiveVectorSettings((await settings.read()).vector);
        const next = await settings.write({ vector: patch });
        // 关了向量 / 换了模型：在途下载不要了（只有这里取消下载，配置同步不取消）
        if (vectorChangeCancelsDownload(before, effectiveVectorSettings(next.vector))) {
          memoryHost.cancelModelDownload();
        }
        await ensureMemoryService();
      },
      userDataDir: configDir,
      device: () => ({
        chip: cpus()[0]?.model ?? process.arch,
        memoryGb: Math.round(totalmem() / 1024 ** 3),
        onBattery: powerMonitor.isOnBatteryPower(),
        platform: process.platform,
        arch: process.arch,
      }),
      llamaCandidates,
      vectorState: () => memoryHost.vectorState(),
      downloadState: () => memoryDownloadState,
      startDownload: async (model) => {
        if (!(await ensureMemoryService())) {
          return { ok: false, error: "记忆服务没能拉起，模型下载未开始" };
        }
        const sources = modelDownloadSources(model);
        memoryDownloadState = {
          state: "downloading",
          received: 0,
          total: model.sizeBytes,
          source: sources[0]!,
        };
        memoryHost.startModelDownload({
          sources,
          targetPath: modelFilePath(model, configDir),
          sha256: model.sha256,
          sizeBytes: model.sizeBytes,
        });
        return { ok: true };
      },
    },
  });
  // 发件箱：点了发送的话先落盘再开跑，下次启动核对没落账的（session/outbox.ts）
  registerOutboxIpc(new OutboxStore(configDir));
  // 星系设计稿：工作区 planet/ 里的插件稿与伴随文件（planet/store.ts）
  registerPlanetIpc(workspaces, subAgentStore, (change) => broadcastAgentEvent({ type: "subAgentsChanged", ...change }));
  registerSessionIpc(
    sessions,
    (id) => {
      agentHost.disposeSession(id);
      // 会话删了，它在受管浏览器里的 agent tab 也一并关掉；意图存档与记忆的尾账也丢
      browserSandbox.closeSessionTab(id);
      // 正在等授权的提问也跟着作废（按 cancelled 结，不写 meta——会话都没了）
      computerUseConsentWaiter.cancel(id);
      computerUseTurnOrigins.delete(id);
      // 沙箱资源：它是持有者就让出来，还在排队就把位置撤掉（否则队列名额白白被占了）；
      // 桌面键与这个会话的浏览器键一起放。硬上限标记也一并忘掉。
      computerUseLease.releaseSession(id);
      computerUseDispatch.forget(id);
      intentIngest.forget(id);
      memoryTurns.forget(id);
    },
    agentHost,
    providers,
    (sessionId, path) => browserSandbox.openSessionArtifact(sessionId, path),
    (ids, workspaceId) =>
      moveSessions(
        {
          sessions,
          workspaces,
          host: agentHost,
          isRunning: (id) => {
            const phase = phases.get(id);
            return phase !== undefined && phase !== "idle";
          },
        },
        ids,
        workspaceId,
      ),
    statusDigests,
    async (sessionId, reverted) => {
      await Promise.all([
        intentOnReverted(sessionId, reverted.turnIds),
        memoryOnReverted(sessionId, reverted.fromTurn),
      ]);
    },
  );
  // pi 的本子和我们的记录分开放，一眼看得出哪份归谁（guideline §四）
  /*
   * 中心存储与 global 集合先建出来：**空目录就是说明书**——用户打开 userData 看到
   * `skills/` 与 `skill-links/global/` 并排，「放进去、链上就生效」不需要再解释。
   * 建不出来不拦启动：没有目录是合法状态（一个都没装）。但要留日志——
   * 不打印的话，一个权限坏掉的目录会表现成「skill 放了但没生效」，那是最难查的一类。
   */
  const skills = new SkillStore(configDir);
  void skills.ensureDirs().catch((error: unknown) => {
    console.error("[main] 建不了 skills 目录，skills 可能不生效", error);
  });
  registerSkillIpc(skills, workspaces);
  /*
   * 插件：记录 / 副本 / 数据 / 归档都在 userData 下，不写进上面这个 skills
   * 目录也不写 mcp.json。冲突检测与开轮装配要避开用户自己的技能，所以把它们的身份读法注入进去
   * （missing 的断链不算：它没有真实文件）。敏感配置值共用 provider 那把密钥存储。
   */
  const plugins = new PluginStore({
    configDir,
    secrets,
    builtinRoot: builtinPluginsDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    userSkills: async () => (await skills.list()).filter((meta) => !meta.missing).map(({ slug, name }) => ({ slug, name })),
  });
  void plugins.init().catch((error: unknown) => {
    console.error("[main] 清不了插件暂存目录（不影响使用，下次启动再试）", error);
  });
  // agent 的 install_plugin / preview_plugin / list_plugins 在主进程的落地（草稿与刷新事件经 broadcastAgentEvent 到 renderer；
  // 对话里那一行的「安装」走 plugin ipc 的 pluginInstallFromRow）
  const draftSessions = new DraftSessionBook(join(configDir, "plugin-draft-sessions.json"));
  const pluginAgent = new PluginAgentRequests({
    plugins,
    session: async (sessionId) => {
      const meta = await sessions.readMeta(sessionId);
      return meta === null ? null : { cwd: meta.cwd, workspaceId: meta.workspaceId };
    },
    workspace: async (id) => {
      const found = (await workspaces.list()).find((workspace) => workspace.id === id);
      return found === undefined ? null : { name: found.name, path: found.path };
    },
    draft: (event) => broadcastAgentEvent(event),
    rememberDraft: (path, sessionId) => draftSessions.remember(path, sessionId),
    installed: (info) => {
      broadcastAgentEvent({ type: "pluginsChanged", installed: info });
      broadcastAgentEvent({ type: "skillsChanged" });
    },
  });
  // 面板文档仓库：模板由主进程按一次性 token 从内存给 iframe，CSP 走响应头（plugin/panel-frame.ts）
  const panelFrames = new PanelFrames();
  installPanelProtocol(panelFrames, (url) => isOwnRendererPage(url, ownRendererOrigin()));
  const panels = new PluginPanels({
    plugins,
    frames: panelFrames,
    workspaceRoot: async (id) => (id === null ? null : ((await workspaces.list()).find((each) => each.id === id)?.path ?? null)),
  });
  registerPluginIpc({
    plugins,
    panels,
    skills,
    mcp,
    workspaces,
    reloadMcp: () => agentHost.mcpReload(),
    agentRequests: pluginAgent,
    listDrafts: () =>
      scanDrafts({
        workspaces: () => workspaces.list(),
        records: () => plugins.records(),
        // 会话删了（meta 读不到）就当没记过：「回到对话」不出现
        sessionOf: async (path) => {
          const sessionId = await draftSessions.sessionOf(path);
          if (sessionId === null) return null;
          const meta = await sessions.readMeta(sessionId);
          return meta === null ? null : { sessionId, title: meta.title };
        },
      }),
  });
  // 看板结果（agent 的 show_plugin_board）：模板按内容哈希存进 <userData>/board-templates/，数据快照进工具结果
  const boardTemplates = new BoardTemplateStore(join(configDir, BOARD_TEMPLATES_DIR));
  const pluginBoards = new PluginBoards({
    plugins,
    templates: boardTemplates,
    session: async (sessionId) => {
      const meta = await sessions.readMeta(sessionId);
      return meta === null ? null : { cwd: meta.cwd, workspaceId: meta.workspaceId };
    },
    workspaceRoot: async (id) => (await workspaces.list()).find((workspace) => workspace.id === id)?.path ?? null,
  });
  // 迁移（设置 › Migration）：扫描/执行都在主进程，agent 进程不参与；skills 落进上面这个中心存储
  registerImportIpc(
    sessions,
    workspaces,
    providers,
    settings,
    join(configDir, "pi-sessions"),
    join(configDir, "imports.jsonl"),
    customRoots,
    skills,
    mcp,
    async () => agentHost.mcpReload(),
    async (model, messages) =>
      agentHost.classifyGreetings(await resolveProviderSecrets(providers, model.providerId), model.modelId, messages),
  );
  // Home（工作区缺席时 agent 的落脚点）先建出来，同 skills.ensureDirs 的处理：
  // 建不出来不拦启动，但要留日志——不然一个权限坏掉的 ~/Orbita 会表现成
  // 「Home 任务的文件写不进去」，那是最难查的一类
  void workspaces.ensureHome().catch((error: unknown) => {
    console.error("[main] 建不了 Home 目录，Home 任务的文件可能落不了盘", error);
  });
  // 工作区移除时连带删它的 skill 集合目录（只是链接，不伤中心存储）
  registerWorkspaceIpc(workspaces, async (id) => {
    await skills.removeWorkspace(id);
    // 插件的「只在这些工作区」名单里摘掉它（摘空转停用）
    await plugins.removeWorkspace(id);
  });
  // 文件面板（fs:roots / fs:list / fs:reveal）：根每次现算，不缓存
  const mediaTokens = new MediaTokens();
  installMediaProtocol(mediaTokens, (url) => isOwnRendererPage(url, ownRendererOrigin()));
  registerFilesIpc(workspaces, sessions, (path) => browserSandbox.openLocalFile(path), mediaTokens);
  // 文档 / 演示文稿面板（doc:*）：白名单同文件面板，写入比较后交换 + 原子写
  registerDocIpc(workspaces, sessions);
  registerSlidesIpc(workspaces, sessions);
  // 审查面板（review:list / review:diff）：task 来源读会话快照账，git 来源只读
  registerReviewIpc(sessions);
  // 专注模式（focus:changes / focus:notify-done / focus:summarize）：U/M 只读跑 git，
  // 时间到发系统通知，收工小结把素材交给 agent 进程的家务活模型（摘抄也是素材）
  registerFocusIpc(workspaces, sessions, providers, settings, agentHost, excerpts);
  // 电源状态（power:state / power:changed）：离电时 renderer 进省电档（星系停转、碎石带隐藏、眼睛不跟）
  registerPowerIpc();
  // 提示音记账（notify:chime-log）：每真响一声记一行，事后对证「那一声是谁」
  registerNotifyIpc(new ChimeLog(join(configDir, "chime-log.jsonl")));
  // provider 域的 handler 要带 agentHost：OAuth 令牌的 Test 探测改走 agent 进程（真会话同源客户端）。
  // 第三个参数是额度缓存实例（<userData>/quota-cache.json）：额度查询与 failed 事件的
  // 额度补丁读同一份；缓存模块自己不在顶层读 app。
  // 放在 agentHost 建好之后注册；同为 ipcMain.handle，注册顺序不影响谁先谁后可用。
  registerProviderIpc(providers, agentHost, quotaCache);
  // 侧栏用量格与价格 · 能力图：同一本任务账本，型号显示名 / 单价要服务商声明与 pi 目录
  registerUsageIpc({ ledger: taskLedger, providers: () => providers.load(), catalog: () => agentHost.listBuiltins() });
  // 设置页的图与 agent 的 model_costs 工具读同一份（同一个 memo）：priceChart 在上面
  // agentHost 的 onEvent 里被引用，那里只在事件到达时执行，此时已定义
  const priceChart = priceChartSourceOf({
    ledger: taskLedger,
    providers: () => providers.load(),
    catalog: () => agentHost.listBuiltins(),
    sessions: () => sessions.list(),
  });
  registerPriceChartIpc(priceChart);

  // 终端面板：PTY 全部住在独立的 terminal utility 进程，主进程只存现状与快照缓冲
  const terminals = new TerminalService();
  registerTerminalIpc(terminals);
  const agentIpc = registerAgentIpc(
    agentHost,
    providers,
    sessions,
    workspaces,
    channels,
    join(configDir, "pi-sessions"),
    // 图片字节预算的占位要拼附图原图的绝对路径（agent 进程不做路径策略）
    (sessionId) => sessions.attachmentDirOf(sessionId),
    // 会话文件不可变（2026-09-18）：两个账本目录对工具面全档只读，含 Skip
    [join(configDir, "sessions"), join(configDir, "pi-sessions")],
    (workspaceId) => skills.linkDirs(workspaceId),
    skills,
    plugins,
    mcp,
    settings,
    intentIngest,
    memoryTurns,
    // 中途起来的窗口（重开 / 刷新）问「谁在跑」：phases 表是 phase 事件记的真值，进程退出时整表清空
    () => {
      const live: Record<string, Exclude<SessionPhase, "idle">> = {};
      for (const [sessionId, phase] of phases) if (phase !== "idle") live[sessionId] = phase;
      return live;
    },
    // 出网那对值要看**正在跑的那只**（后端与开关都是下次启动才生效）：设置里选 wsb、
    // 实际跑着 L2b 时，按设置算会告诉模型「你没有出网」——而它就在本机的网络上。
    () => computerUse.runningFacts(),
    /**
     * 上一轮被放弃时（停止 / interrupt 抢跑 / 新 submit 抢跑）的通知。
     * **抢跑不发 idle**（runtime 的 preempt 语义），所以只等 phase idle 会漏掉 interrupt
     * 这条路——挂起的授权提问会活到新一轮里，用户点“允许”就能让一个已经不存在的动作
     * 真的下发（2026-11-27 验收 P1）。这里与会话删除同一条语义：按 cancelled 结掉。
     */
    (sessionId) => computerUseConsentWaiter.cancel(sessionId),
    // 这一轮是谁发起的（闸门据此判「用户此刻能不能回答」）：自动化开轮时写 automation，
    // 其余（renderer 手点 submit / interrupt / compact）写 user。
    (sessionId, origin) => computerUseTurnOrigins.set(sessionId, origin),
  );
  // 子会话：派出 / 发信 / 代父发言 / 终止的依赖注入（channel/requests.ts 的纯核 + 这里的胶水）。
  // submitTurn 拿 agentIpc 刚返回的那个函数——子首轮与父→子空闲投递不重新拼一遍
  // turnFields/readDirectories 那一整套装配；steer 走 agentHost（AgentHostCore 的方法）；
  // abort 同源（agent:abort）；cancelBrowserHandoff 是 BrowserSandbox 的幂等取消。
  // 「生成形象」：幕后会话跑插件「行星造物」的 planet-render 技能出候选，主进程读插件账本推进度（planet/avatar.ts）
  avatarJobs = new AvatarJobs({
    workspaces,
    pluginRoot: async () => {
      const record = (await plugins.records()).find((each) => each.name === AVATAR_PLUGIN);
      if (record === undefined) return null;
      const root = plugins.rootOf(record);
      return existsSync(join(root, AVATAR_SKILL)) ? root : null;
    },
    sessions,
    // 模型：面板随请求带来的型号最优先（它在胶囊上显示的就是这一对），没带才按设置里的取法解析——
    // 没选过 = 会话栏的模型（主进程读得到的只有 lastUsed），选了「子会话模型」才走子会话默认那条链路。
    // 不用杂务模型——画 SVG、按退出码重画是正经的多步活
    resolveModel: async (request) => {
      const current = await settings.read();
      return resolveAvatarModel({
        requested: request.model,
        session: lastUsedPair(current),
        settings: { avatarModel: current.avatarModel, subSessionModel: current.subSessionModel, subSessionThinking: current.subSessionThinking },
        providers: await providers.list(),
      });
    },
    // 幕后 / 编排投递的轮次：会话身份（backstage / parentId）已经把它们挡在闸门外，
    // 这里仍标 channel——发起者是机器，不写成 user（免得以后判据变严时漏挡）
    submitTurn: (input) => agentIpc.submitTurn(input, "channel"),
    abort: (sessionId) => agentHost.abort(sessionId),
    runScript: execPluginScript,
    loadImage: loadSurface,
    emit: broadcastAvatarJob,
    now: Date.now,
    newId: randomUUID,
  });
  registerAvatarIpc(avatarJobs);
  const deps: ChannelDeps = {
    sessions,
    channels,
    providers,
    settings,
    // 幕后 / 编排投递的轮次：会话身份（backstage / parentId）已经把它们挡在闸门外，
    // 这里仍标 channel——发起者是机器，不写成 user（免得以后判据变严时漏挡）
    submitTurn: (input) => agentIpc.submitTurn(input, "channel"),
    steer: (sessionId, text, delivery) => agentHost.steer(sessionId, text, delivery),
    abort: (sessionId) => agentHost.abort(sessionId),
    cancelBrowserHandoff: (sessionId) => browserSandbox.cancelSessionHandoff(sessionId),
    phases,
    broadcast: broadcastChannelEvent,
    subAgents: {
      profile: async (workspaceId, id) => {
        const workspace = (await workspaces.list()).find((each) => each.id === workspaceId);
        return workspace === undefined ? null : subAgentStore.profile(workspace.path, id);
      },
    },
  };
  // 启动收尾（上次退出时还在跑的子会话补一条终局）不挡首屏：先注册 IPC，建完主窗口再后台跑
  // （startup-closures.ts 的理由与 Windows 实测）
  const startupClosures = new StartupClosureQueue((notices) => broadcastClosureNotices(deps, notices));
  registerChannelIpc(deps, startupClosures);

  /*
   * GitHub 出口只有一个：检查更新（provider）与「所有版本」列表共用同一个客户端——
   * 同一套网络 / 代理（electron-updater 的 session，下载器也在上面）、同一份缓存、
   * 同一本限流账（见 main/updater/github-client.ts）。
   * 代理在启动时就按 HTTPS_PROXY / HTTP_PROXY 设上，不等更新器接线：dev（未打包）里
   * 历史版本列表同样要能用（以前只有打包后的 Windows 实例才会设）。失败只警告，不拖启动。
   */
  const github = new GitHubClient({ transport: electronGitHubTransport() });
  await applyEnvProxy();

  /*
   * 自动化：定时任务的存盘、调度与「阻止睡眠」。开关关着时调度器每次 tick 直接
   * 返回、工具不注册、list 回空。两种去处都走 agentIpc.submitTurn——与用户发消息、delegate 同一套开轮装配。
   * 睡眠唤醒（powerMonitor resume）立刻 tick 一次：Mac 睡眠时定时器不走。
   */
  const automationStore = new AutomationStore(configDir);
  const keepAwake = new KeepAwake(
    powerSaveBlocker,
    async () => (await settings.read()).automationKeepAwake === true,
    (holding) => console.info(`[automation] 阻止系统睡眠：${holding ? "已拦住（有运行在执行）" : "已放开"}`),
  );
  const launchDeps: LaunchDeps = {
    sessions,
    providers,
    settings,
    workspaces,
    // 自动化发起的轮次（含 this_session 投回用户会话）：电脑使用闸门据此不弹看不见的授权
    submitTurn: (input) => agentIpc.submitTurn(input, "automation"),
  };
  const automationScheduler = new AutomationScheduler({
    store: automationStore,
    now: Date.now,
    launch: (input) => launchAutomationRun(launchDeps, input),
    deliver: (input) => deliverAutomationRun(launchDeps, input),
    sessionExists: async (sessionId) => (await sessions.readMeta(sessionId)) !== null,
    isSessionBusy: (sessionId) => (phases.get(sessionId) ?? "idle") !== "idle",
    abort: (sessionId) => agentHost.abort(sessionId),
    notify: broadcastAutomationEvent,
    onActiveChange: (count) => void keepAwake.sync(count).catch((cause: unknown) => console.error("[automation] 阻止睡眠同步失败", cause)),
  });
  const automationDeps: AutomationRequestDeps = {
    store: automationStore,
    scheduler: automationScheduler,
    sessions,
    providers,
    workspaces,
    // 选插件：这个工作区此刻装着、启用着、且带看板的插件（没有看板的插件，自动化到点没有东西可显示）
    plugins: { enabledIn: (workspaceId) => boardPluginsIn(plugins, workspaceId) },
    now: Date.now,
    newId: randomUUID,
    notify: broadcastAutomationEvent,
  };
  registerAutomationIpc(automationDeps);
  // 全局周看板：自动化的运行记录 + 会话里 show_plugin_board 的快照
  registerBoardIpc({
    week: {
      automations: () => automationStore.list(),
      recordPath: (sessionId) => sessions.recordPath(sessionId),
      now: Date.now,
    },
    templates: boardTemplates,
    frames: panelFrames,
  });
  // 回答里的 ```html-embed 内嵌交互图：与看板卡共用一次性文档仓库（同一套 CSP 响应头）
  registerChatEmbedIpc(panelFrames);
  automationScheduler.start();
  setTimeout(() => void automationScheduler.tick().catch(() => undefined), 5_000);
  powerMonitor.on("resume", () => void automationScheduler.tick().catch(() => undefined));

  /*
   * 自动更新（Windows NSIS + GitHub Releases，见 main/updater/）：只有打包好的 Windows 应用才接线
   * （macOS 包未签名公证、装不上，界面说「暂不支持」），
   * 启动 10s 后首查 + 每 4h 一次 + 设置页的手动检查；autoDownload=false，下载与安装都由
   * 用户那一下触发。beforeInstall 注入 agentHost.dispose——安装程序要替换应用文件，
   * agent utility 进程是同一个 electron.exe，压着文件会让 NSIS 静默安装失败；
   * 下面的 before-quit 里还有同一条 dispose，重入幂等。
   */
  const updater = new Updater({
    packaged: app.isPackaged,
    platform: process.platform,
    version: app.getVersion(),
    beforeInstall: () => agentHost.dispose(),
    github,
  });
  // 「所有版本」展开体的最近版本列表：走同一个客户端（原文缓存由它管）+ 本层组装缓存，
  // 与更新器接不接线无关——dev 下也照常能用（见 main/updater/recent-releases.ts）
  registerUpdaterIpc(updater, createRecentReleases({ client: github }));
  updater.start().catch((error: unknown) => {
    // start 只会在 Electron session 初始化时失败；更新是可选功能，不能拖住主窗口启动
    console.warn("[更新] 初始化失败：", error instanceof Error ? error.message : String(error));
  });

  app.on("before-quit", () => {
    for (const sessionId of channelIdleTimers.keys()) cancelChannelIdleClose(sessionId);
    automationScheduler.stop();
    keepAwake.release();
    // 状态卡摘要：脏的尽力落盘（不等——落不下也没关系，重启后按 logOffset 增量补扫自愈）
    void statusDigests.flush().catch(() => undefined);
    appTray?.beginQuit();
    appTray?.destroy();
    appTray = null;
    browserSandbox.prepareQuit();
    agentHost.dispose();
    // 记忆服务直接停（退出路上不跑提取模型）：开段已落盘，下次启动的清扫追认
    memoryHost.stop();
    // 关窗口全杀：runtime 逐个 taskkill 进程树（dev server 的孙进程不留占端口）
    terminals.dispose();
    // 隔离环境是我们起的（VM 或 OS 会话）：应用退出时一并带走，别给用户留一个孤儿会话 /
    // 一个还活着的 agent 账号。L2b 的收尾链是异步的（stop + deprovision + 验证），
    // 不 await：退出路径不能被 OS 回收时间拖住，但会话自己会被注销。
    void computerUse.dispose();
    // 租约只在内存里（见 lease.ts 头部：落盘会留下没人能放掉的死锁）；退出前把定时器收掉，
    // 不给进程留一个拽着退出 30s 的句柄
    computerUseLease.revoke(cuTexts().leaseReasonAppExiting);
    /*
     * 审计：一行账把「桌面到底挤不挤」留在日志里（v1.5-2 要用真实数据决定后续路线）。
     * 只在真有人用过沙箱时才打——没人用过就没数字可报。
     */
    const leaseStats = computerUseLease.stats();
    if (leaseStats.length > 0) {
      console.log(
        "[computer-use] 租约统计（应用退出）：" +
          leaseStats
            .map(
              (row) =>
                `${row.key} 拿到 ${String(row.acquired)} 次 / 等 ${String(Math.round(row.averageWaitMs))}ms / 持有 ${String(Math.round(row.averageHeldMs))}ms / 拒 ${String(row.rejected)} 次`,
            )
            .join("；"),
      );
    }
    // 全局热键显式注销（Electron 退出时也会清，但释放时机不该靠它）
    emergencyStop.dispose();
  });

  /**
   * 界面里点到的外链（聊天里的链接、设置页的文档链接……）：网页默认进内置浏览器「你的」tab
   * （2026-09-29 裁决「全都默认用内置，想用系统默认有个 button 足矣」——那个按钮在沙盒工具条上，
   * browser:open-external）。mailto 这类别的协议内置浏览器接不了，照旧交给系统；**其余非网页
   * 协议一律不交**——`shell.openExternal` 对未知协议各平台行为不一，是拖链接 / 钓鱼链接的
   * 落地点，交接白名单见 isSystemHandoffLink。
   */
  const openLink = (url: string): void => {
    if (isWebLink(url)) {
      void browserSandbox.open(url).catch((cause: unknown) => console.error("[browser] 链接打开失败", url, cause));
    } else if (isSystemHandoffLink(url)) {
      void shell.openExternal(url);
    } else {
      console.warn(`[links] 未放行的协议，不交给系统：${url}`);
    }
  };

  /** 托盘菜单文案要跟界面语言走；读一次最新设置即可（没有第二处消费者，不另开推送通道） */
  const readLanguage = async (): Promise<Language> => {
    const current = await settings.read();
    return effectiveLanguage(current.language);
  };

  createMainWindow(initialSettings.theme, initialSettings.language, openLink, readLanguage);
  void channelReconciler
    .reconcileAll()
    .catch((cause: unknown) => {
      console.error("[channel] 启动子会话收尾失败", cause);
      return [];
    })
    .then((notices) => startupClosures.resolve(notices));

  // macOS：点 dock 图标且无窗口时重开——同样先读一次设置再建窗口（SettingsStore
  // 有缓存，命中时同步可得），用的是这一刻的最新值，不是冷启动时的旧 initialSettings
  app.on("activate", () => {
    // 只问主窗口：隐藏着的沙盒浏览器窗口也算一个窗口，按 getAllWindows 判就回不来了
    if (mainWindows.list().length === 0) {
      void settings
        .read()
        .then((current) => createMainWindow(current.theme, current.language, openLink, readLanguage));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
