/**
 * 主进程入口。职责边界（AGENTS.md「架构边界」）：只负责窗口、IPC 与持久化。
 * agent runtime 将跑在独立 utility 进程，不在这里 —— 见 docs/single-agent-guideline.md §二。
 */
import { preferIPv4 } from "../shared/dial-v4.ts";
import { CATALOG_CACHE_ENV } from "../shared/agent-ipc.ts";
import { catalogIdsOfProviders } from "../shared/known-providers.ts";
import { app, BrowserWindow, nativeTheme, powerMonitor, shell, type WebPreferences } from "electron";
import { cpus, homedir, totalmem } from "node:os";
import { join } from "node:path";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import { effectiveLanguage, type Language, type ThemePreference } from "../shared/settings.ts";
import { AgentHost, resolveRuntimePath } from "./agent/host.ts";
import { agentEnv, bundledBinDir } from "./agent/search-bins.ts";
import { PI_PACKAGE_DIR_ENV, piPackageDir } from "./agent/pi-package.ts";
import { existsSync } from "node:fs";
import { applyMcpWrite, applySkillWrite } from "./agent/write-requests.ts";
import { applyReadTask } from "./session/read-task.ts";
import { registerImportIpc } from "./session/import-ipc.ts";
import { CustomRootsStore } from "./session/import-custom-roots.ts";
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
import { broadcastChannelEvent, registerChannelIpc } from "./channel/ipc.ts";
import { applyChannelSend, applyDelegate, type ChannelDeps } from "./channel/requests.ts";
import { ChannelStore } from "./channel/store.ts";
import { registerProviderIpc } from "./provider/ipc.ts";
import { registerSessionIpc } from "./session/ipc.ts";
import { registerWrapupIpc } from "./session/wrapup-ipc.ts";
import { registerMcpIpc } from "./mcp/ipc.ts";
import { McpStore } from "./mcp/store.ts";
import { registerSkillIpc } from "./skill/ipc.ts";
import { SkillStore } from "./skill/store.ts";
import { createSessionRecorder } from "./session/recorder.ts";
import { SessionStore } from "./session/store.ts";
import { ExcerptStore } from "./excerpt/store.ts";
import { CarryoverStore } from "./session/carryover-store.ts";
import { registerPriceChartIpc, registerUsageIpc, startTaskLedger } from "./usage/ipc.ts";
import { readPiThinkingTimeline, TaskLedger } from "./usage/task-ledger.ts";
import { Updater } from "./updater/service.ts";
import { registerUpdaterIpc } from "./updater/ipc.ts";
import { createRecentReleases } from "./updater/recent-releases.ts";
import { applyNativeTheme, registerSettingsIpc } from "./settings/ipc.ts";
import { SettingsStore } from "./settings/store.ts";
import { registerWindowIpc } from "./window/ipc.ts";
import { installCloseToTray, loadTrayIcon, type AppTray } from "./window/tray.ts";
import { registerWorkspaceIpc } from "./workspace/ipc.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { registerFilesIpc } from "./files/ipc.ts";
import { TerminalService } from "./terminal/service.ts";
import { registerTerminalIpc } from "./terminal/ipc.ts";
import { registerReviewIpc } from "./review/ipc.ts";
import { registerFocusIpc } from "./focus/ipc.ts";
import { registerBrowserIpc } from "./browser/ipc.ts";
import { registerExcerptIpc } from "./excerpt/ipc.ts";
import { isSystemHandoffLink, isWebLink } from "./browser/address.ts";
import { BrowserSandbox } from "./browser/sandbox.ts";
import { pageBackgroundColor } from "./browser/page-background.ts";
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
        { frame: false, backgroundColor: "#f3f4f1" }),
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
        language: effectiveLanguage(theme, language),
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
  registerVoiceIpc(
    new VoiceStore(configDir, secrets),
    new DictationSessions({ openSocket: openUndiciSocket, diagnose: diagnoseOverHttps }),
  );
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
  // 记忆服务（实验功能 memory-system）的开关观察：开了就拉起、关了就停
  // （memoryHost 在后面定义；设置写入只发生在窗口起来之后，那时已就绪）。
  // 其余设置的写入也会过这道：开关没变时拉起 / 停都是空操作，无副作用
  registerSettingsIpc(settings, (next) => {
    if (next.experimentalFeatures?.["memory-system"] === true) {
      void ensureMemoryService().catch((cause: unknown) => console.error("[memory] 启动 / 同步服务失败", cause));
    } else {
      memoryHost?.stop();
    }
  });
  registerWindowIpc();
  const initialSettings = await settings.read();
  applyNativeTheme(initialSettings);

  // agent 跑在独立 utility 进程；主进程只转发事件，不加工（guideline §二）——
  // 唯一的例外是**落盘**，那本来就是主进程的职责，挂在同一条转发路径上是最短的一跳。
  // 通道账本（子会话 2026-09-23）先于 SessionStore 建：SessionStore 的级联删要用它
  const channels = new ChannelStore(join(configDir, "channels"));
  const sessions = new SessionStore(join(configDir, "sessions"), join(configDir, "workbenches"), channels);
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
  const mcp = new McpStore(configDir);
  // 一份工作区存储给两处用：下面的 workspace IPC，与 read_task 的目录模式（要工作区名）
  // 工作区根：正式版沿用默认的 ~/Orbita，开发版挪到 ~/Orbita-dev（同 userData 的理由）
  const workspaces = new WorkspaceStore(configDir, devDirs?.orbitaRoot);
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
  mainWindows.onLastClosed(() => browserSandbox.dispose());

  // 子会话：主进程按 phase 事件维护的活会话状态——channel/requests.ts 靠它判断
  // 投递目标此刻是不是空闲（空闲退化 submit，在跑才 steer）
  const phases = new Map<string, SessionPhase>();
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
    if (event.type === "phase") phases.set(event.sessionId, event.phase);
    // 这一轮停了（完成、被用户停掉、出错）：还挂着的交接按取消结掉——等它的那次工具调用已经不在了
    if (event.type === "phase" && event.phase === "idle") browserSandbox.cancelSessionHandoff(event.sessionId);
    if (event.type === "failed" && event.sessionId === null) phases.clear();
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
    if (event.type === "readTaskRequest") {
      void applyReadTask(sessions, event, workspaces, channels)
        .then((result) => agentHost.answerReadTask(event.requestId, result))
        .catch((cause: unknown) =>
          agentHost.answerReadTask(event.requestId, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      return;
    }
    // 记忆系统（实验功能 memory-system）：agent 的轮前召回问答——转发给记忆服务
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
        .recordFileTurn(event.sessionId, event.changes, event.webArtifacts ?? [], event.webArtifactsBatch)
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
          });
        })
        .catch((cause: unknown) =>
          console.error("[session] 轮尾文件账落盘失败", event.sessionId, cause),
        );
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
    // 记忆构建（实验功能 memory-system）同一处喂：盯轮落定，正常结束的一轮
    // 交给记忆服务（跟踪器在下面定义，TDZ 说明同 intentIngest）
    memoryTurns.onEvent(event);
    record(event);
    broadcastAgentEvent(event);
    // 目录联网刷新只刷用户已添加的服务商用到的目录（审核 F-1）：每次拉起 agent 进程时现读一次
  }, async () => catalogIdsOfProviders(await providers.load()));
  // MCP 的 IPC 面（1-1 起含热重载）。reload 回调闭包引用 agentHost——
  // 事件回调只在事件到达时执行，那时两边都已定义，不存在 TDZ 问题
  const mcpIpc = registerMcpIpc(mcp, workspaces, () => agentHost.mcpReload());
  // 删除会话时把 runtime 里那条 pi 会话也放掉——不然每开一条任务就多一份驻留，
  // 活到退出应用（刀 0-4 债务 A）。会话分支（session:branch）也要走 agent 进程裁 pi 本子
  // 遗留事项（收尾仪式）全局一份；与 sessions/ 目录平级，一眼看得出哪份归谁
  const carryovers = new CarryoverStore(join(configDir, "carryovers.jsonl"));
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
   * 记忆系统（实验功能 memory-system）的主进程两件套：
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
    isMemoryOn: async () =>
      (await settings.read()).experimentalFeatures?.["memory-system"] === true,
    readChore: () => choreModelPayload(settings, providers),
    settle: async (payload) => {
      // 轮后兑现时确保服务在跑（开关中途打开也接得上；已拉起时这里是空操作）。
      // 没拉起来照样交给 host：它在「服务不在」时记一行带会话 / 轮号的丢弃诊断。
      // 抛错由跟踪器的 deliver 接住记日志（settle 的 Promise 在那里被 await）
      await ensureMemoryService();
      memoryHost.turnSettled(payload);
    },
  });
  /**
   * 会话回退后的记忆钩子：第 fromTurn 轮起被撤回 → 服务截段（重说的轮照常收）+ 停用来源轮
   * 全被撤回的条目。只给根会话发（子会话不写记忆，发了也是一次白扫全库）；开关关着不发、
   * 不为它拉起服务。失败只记日志，回退本身已经完成
   */
  const memoryOnReverted = async (sessionId: string, fromTurn: number): Promise<void> => {
    try {
      if ((await settings.read()).experimentalFeatures?.["memory-system"] !== true) return;
      const meta = await sessions.readMeta(sessionId);
      if (meta === null || meta.parentId !== undefined) return;
      await ensureMemoryService();
      memoryHost.sessionReverted(sessionId, fromTurn);
    } catch (cause) {
      console.error("[memory] 回退后的记忆停用 / 截段没送成（不影响回退）", cause);
    }
  };
  // 启动时开关已开：先拉起服务——启动清扫要处理上次退出留下的旧段（闲置追认 /
  // 半路提取续跑），不等第一轮对话才动。失败只记日志（下次轮后再试拉起）
  if (initialSettings.experimentalFeatures?.["memory-system"] === true) {
    void ensureMemoryService().catch((cause: unknown) => console.error("[memory] 启动 / 同步服务失败", cause));
  }
  // 记忆库的读写面（实验功能 memory-system）：读在主进程直读 JSONL，写转发给
  // 记忆服务（唯一写者）；会话标题 / 工作区名这些连接属性在这里注入
  registerMemoryIpc({
    dir: join(configDir, "memory"),
    deps: {
      sessionTitleOf: async (id) => (await sessions.readMeta(id).catch(() => null))?.title ?? null,
      workspaces: async () => workspaces.list(),
      readMeta: (id) => sessions.readMeta(id),
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
        if (next.experimentalFeatures?.["memory-system"] === true) {
          await ensureMemoryService();
        } else {
          await syncVectorConfig();
        }
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
  registerSessionIpc(
    sessions,
    (id) => {
      agentHost.disposeSession(id);
      // 会话删了，它在受管浏览器里的 agent tab 也一并关掉；意图存档与记忆的尾账也丢
      browserSandbox.closeSessionTab(id);
      intentIngest.forget(id);
      memoryTurns.forget(id);
    },
    agentHost,
    carryovers,
    providers,
    (path) => browserSandbox.openLocalFile(path),
    async (sessionId, reverted) => {
      await Promise.all([
        intentOnReverted(sessionId, reverted.turnIds),
        memoryOnReverted(sessionId, reverted.fromTurn),
      ]);
    },
  );
  // 收尾（session:wrapup-*）：扫描计划、按反馈改清单、确认落账
  registerWrapupIpc({
    sessions,
    carryovers,
    providers,
    settings,
    host: agentHost,
    catalog: () => agentHost.listBuiltins(),
    // 确认的做完的事记进任务账本（价格图的主会话任务）
    onConfirmed: (sessionId, wrapup) => {
      void taskLedger.recordWrapup(sessionId, wrapup).catch((error: unknown) => {
        console.error("[task-ledger] 收尾记账失败（下次升级回填会从 meta 补上）", error);
      });
    },
  });
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
  registerSkillIpc(skills);
  // 迁移（设置 › Migration）：扫描/执行都在主进程，agent 进程不参与；skills 落进上面这个中心存储
  registerImportIpc(
    sessions,
    workspaces,
    providers,
    settings,
    join(configDir, "pi-sessions"),
    join(configDir, "imports.jsonl"),
    new CustomRootsStore(configDir),
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
  registerWorkspaceIpc(workspaces, (id) => skills.removeWorkspace(id));
  // 文件面板（fs:roots / fs:list / fs:reveal）：根每次现算，不缓存
  registerFilesIpc(workspaces, sessions, (path) => browserSandbox.openLocalFile(path));
  // 审查面板（review:list / review:diff）：task 来源读会话快照账，git 来源只读
  registerReviewIpc(sessions);
  // 专注模式（focus:changes / focus:notify-done / focus:summarize）：U/M 只读跑 git，
  // 时间到发系统通知，收工小结把素材交给 agent 进程的家务活模型（摘抄也是素材）
  registerFocusIpc(workspaces, sessions, providers, settings, agentHost, excerpts);
  // provider 域的 handler 要带 agentHost：OAuth 令牌的 Test 探测改走 agent 进程（真会话同源客户端）。
  // 放在 agentHost 建好之后注册；同为 ipcMain.handle，注册顺序不影响谁先谁后可用。
  registerProviderIpc(providers, agentHost);
  // 侧栏用量格与价格 · 能力图：同一本任务账本，型号显示名 / 单价要服务商声明与 pi 目录
  registerUsageIpc({ ledger: taskLedger, providers: () => providers.load(), catalog: () => agentHost.listBuiltins() });
  registerPriceChartIpc({
    ledger: taskLedger,
    providers: () => providers.load(),
    catalog: () => agentHost.listBuiltins(),
    sessions: () => sessions.list(),
  });

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
    mcp,
    settings,
    intentIngest,
    memoryTurns,
  );
  // 子会话：派出 / 发信 / 代父发言 / 终止的依赖注入（channel/requests.ts 的纯核 + 这里的胶水）。
  // submitTurn 拿 agentIpc 刚返回的那个函数——子首轮与父→子空闲投递不重新拼一遍
  // turnFields/readDirectories 那一整套装配；steer 走 agentHost（AgentHostCore 的方法）；
  // abort 同源（agent:abort）；cancelBrowserHandoff 是 BrowserSandbox 的幂等取消。
  const deps: ChannelDeps = {
    sessions,
    channels,
    providers,
    settings,
    submitTurn: (input) => agentIpc.submitTurn(input),
    steer: (sessionId, text, delivery) => agentHost.steer(sessionId, text, delivery),
    abort: (sessionId) => agentHost.abort(sessionId),
    cancelBrowserHandoff: (sessionId) => browserSandbox.cancelSessionHandoff(sessionId),
    phases,
    broadcast: broadcastChannelEvent,
  };
  registerChannelIpc(deps);

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
  });
  // 「所有版本」展开体的最近版本列表：纯网络请求 + 内存缓存（10 分钟），
  // 与更新器接不接线无关——dev 下也照常能用（见 main/updater/recent-releases.ts）
  registerUpdaterIpc(updater, createRecentReleases());
  updater.start();

  app.on("before-quit", () => {
    appTray?.beginQuit();
    appTray?.destroy();
    appTray = null;
    browserSandbox.prepareQuit();
    agentHost.dispose();
    // 记忆服务直接停（退出路上不跑提取模型）：开段已落盘，下次启动的清扫追认
    memoryHost.stop();
    // 关窗口全杀：runtime 逐个 taskkill 进程树（dev server 的孙进程不留占端口）
    terminals.dispose();
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
    return effectiveLanguage(current.theme, current.language);
  };

  createMainWindow(initialSettings.theme, initialSettings.language, openLink, readLanguage);

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
