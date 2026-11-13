import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "./useTheme";
import { LocaleContext, messagesOf } from "./locale.ts";
import { ExperimentalFeaturesContext } from "./experimental.ts";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, effectiveLanguage, type AppSettings, type DocPaper, type ModelPair, type SettingsPatch } from "@shared/settings";
import { childSessions, rootSessions, type Carryover } from "@shared/session";
import type { ChimeReason } from "@shared/notify";
import { useChatSession, useSessionView } from "./features/chat/useChatSession";
import { effectiveIntentSettings } from "@shared/settings";
import { IntentPanel } from "./features/intent/IntentPanel.tsx";
import { ContextPanel, type TaskPanelTab } from "./features/context/ContextPanel.tsx";
import { EMPTY_ENTRY } from "./features/chat/session-states.ts";
import { ChatView } from "./features/chat/ChatView";
import { useChannelSummaries } from "./features/chat/useChannelSummaries";
import { subSessionStatusOf } from "./features/chat/sub-sessions-rows";
import { SubSessionsPanel } from "./features/chat/SubSessionsPanel";
import {
  SUB_SESSIONS_LIST,
  escapeFrom,
  openSubSession,
  panelAfterSubSessionsGone,
  syncToMainSession,
  type SubSessionsView,
} from "./features/chat/sub-sessions-state";
import { SettingsView } from "./features/settings/SettingsView";
import { BoardWeekView } from "./features/board/BoardWeekView";
import type { SettingsTab } from "./features/settings/settings-tabs.ts";
import { OnboardingView } from "./features/onboarding/OnboardingView";
import { shouldAutoOpenOnboarding } from "./features/onboarding/onboarding-nav.ts";
import { Sidebar, type Overlay } from "./shell/Sidebar";
import { COLLAPSE_BREAKPOINT } from "./shell/window-tools.ts";
import { Toolbar, ToolbarPanelSlotContext } from "./shell/Toolbar";
import { SessionCapsule } from "./shell/SessionCapsule";
import { useFocusShell } from "./features/focus/use-focus-shell.tsx";
import { docPanelLayout } from "./features/doc-panel/doc-panel-width.ts";
import { docScope, getLast } from "./features/doc-panel/view-memory.ts";
import { DocPaperContext, effectivePaper } from "./features/doc-panel/doc-paper.ts";
import { RightRail, type RailEntry, type RightPanelKind } from "./shell/RightRail";
import {
  CLOSED_ENTRY,
  composeEntry,
  forgetMissing,
  hasEntry,
  hasSubLayer,
  mergeLoaded,
  panelFromHome,
  parseMemoryFile,
  parsePath,
  recallEntry,
  rememberEntry,
  resolveSubSessionsSub,
  taskTabOf,
  toMemoryFile,
  type PanelEntry,
  type PanelMemory,
  type PanelPath,
} from "./shell/right-panel-memory.ts";
import { dropDraft, putDraft, shouldOpenDraft, draftOf, type PluginDraftTarget, type PluginDrafts } from "./features/plugins/plugin-draft.ts";
import type { PluginOpenRequest } from "./features/plugins/PluginsView.tsx";
import { RightPanelSlot } from "./shell/RightPanel";
import { railSubviewLit, toggleRailSubview, type RailSubviewState } from "./shell/rail-subview.ts";
import { FEATURE_ICON } from "./shell/feature-icons.ts";
import { type TokenPickerControl, type TokenPickResult } from "./shell/panel-token.ts";
import { PastedTextCollapseContext } from "./shell/attachment-chips";
import { ProcessViewContext } from "./features/chat/process-view-context";
import { isDrawerToggleShortcut } from "./shell/drawer-shortcut.ts";
import { isUnclaimedEscape } from "./shell/escape-key.ts";
import { AutomationPanel } from "./features/automation/AutomationPanel";
import {
  AutomationContext,
  AutomationRunSessionsContext,
  type AutomationUi,
} from "./features/automation/automation-context.ts";
import { runningCount } from "./features/automation/automation-view.ts";
import { useAutomations } from "./features/automation/useAutomations.ts";
import type { CiteFocusRequest } from "./features/files/cite-focus.ts";
import { CitationOpenContext } from "./features/chat/citation-context.ts";
import type { PdfCitation } from "@shared/pdf-quote";
import { FilesPanel } from "./features/files/FilesPanel";
import {
  autoSplitPanelWidth,
  effectivePaperLayout,
  nextPaperLayout,
  PAPER_CHAT_WIDTH,
  PAPER_LAYOUT_DEFAULT,
  recallPaperLayout,
  rememberPaperLayout,
  shouldSplitPaper,
  type PaperLayout,
} from "./features/files/paper-layout.ts";
import { TerminalPanel } from "./features/terminal/TerminalPanel";
import { ReviewPanel } from "./features/review/ReviewPanel";
import { DocsPanel } from "./features/doc-panel/DocsPanel";
import { useAutoOpenPanel } from "./features/chat/auto-open-panel.ts";
import { onOpenPanelRequest, requestOpenPanel } from "./shell/open-panel.ts";
import type { ExcerptJump } from "./features/review/ExcerptsTab";
import type { ExcerptJumpRequest } from "./features/chat/ChatView";
import { BOARD_DAYS_DEFAULT, RIGHT_PANEL_WIDTH_DEFAULT, SIDEBAR_WIDTH_DEFAULT } from "@shared/settings";
import { Drawer, type DockedTab } from "./shell/Drawer";
import { NEW_TASK_TAB, dockTab } from "./shell/drawer-state";
import { isWindowInactive } from "./shell/window-activity.ts";
import {
  noticeTierOf,
  orderNoticeEntries,
  planNotice,
  runStateOf,
  sessionRunState,
  settledSessions,
  treeNotices,
  type NoticeTier,
} from "./features/notify/completion-notice.ts";
import { playCompletionChime } from "./features/notify/chime.ts";
import { MemoryLibraryView } from "./features/memory/MemoryLibraryView";
import { PluginsView } from "./features/plugins/PluginsView.tsx";
import type { MemoryEntryView } from "@shared/memory";
import type { PanelUsageKey } from "@shared/panel-usage";

/**
 * App shell —— 设计系统的构图，不只是它的 token。
 *
 * **三层，不是四层**：用户自己的桌面 → **边界卡**（`.layer`，layer 1，就是窗口本身，
 * 侧栏也在里面）→ **内容面**（`.pane`，layer 2，四边等距浮在边界卡里，
 * 它的左边缘决定侧栏宽度）→ **输入卡**（layer 3）。
 * 两层玻璃画同一个 `--glass-bg`，深度是合成出来的；两层都 `border: 0`
 * （暗档例外：地面实色分层——外壳浅、会话井深，见 styles.css 的覆写与
 * colors.css 头注释；玻璃只留给浮层）。
 *
 * 侧栏 288px 没有自己的面，直接坐在边界卡上（设计系统 *Layout*：both sidebars are
 * unbounded）。右抽屉（right-drawer-X）**是 pane 的子元素**——与会话列同一张卡，
 * 中间只有一根竖线（2026-09-12 裁决：不要间隔，一条竖线）。转帧式窗口的窗口键
 * 在自绘标题栏（Titlebar）上；抽屉开关住在右图标条顶部，底部是应用入口
 * （Archived / Carryovers / Settings，wafo 2026-09-22 裁决，覆盖同日之前的
 * 「底部只放会话动作」——复制按钮已并入会话行的「导出」）。
 */
/** 右栏「文档」入口发出的打开请求的 token 起点（与 focus.fileOpen 的自增 token 分开，避免撞号被当成已消费） */
const DOC_OPEN_TOKEN_BASE = 1_000_000;

export function App() {
  usePlatform();
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  /** provider 列表加载失败的原因；null = 正常。**失败要亮在聊天面上**，
   * 不然一次 IPC 失败会显示成「还没有 provider」，用户被引去白配一遍。 */
  const [providersError, setProvidersError] = useState<string | null>(null);
  /** 中卡盖着哪个面（聊天 / 设置）——与右侧面板是**两个独立状态**，不是一个枚举 */
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** 右侧分屏面板开哪个；两个面板互斥，同一时刻至多一个 */
  const [rightPanel, setRightPanel] = useState<RightPanelKind | null>(null);
  /**
   * Archived / Carryovers 两个子视图的开关（入口在右栏底部，2026-09-22 裁决）。
   * 状态跟着入口住在 App，Sidebar 受控渲染子视图本体。两者互斥：点一个退另一个。
   */
  const [showArchived, setShowArchived] = useState(false);
  const [showCarryovers, setShowCarryovers] = useState(false);
  /** 窄窗（<960px）：并排分屏守不住 chat ≥480px 的底线，面板转右侧锚定覆盖层 */
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 959px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 959px)");
    const sync = () => setNarrow(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  // 初始 state 的主题跟 main.tsx 首帧写的 data-theme 对齐（api.initialTheme），
  // 否则这里先落 DEFAULT_SETTINGS 的 "system"，useTheme 首次 apply 会把主题切到
  // 系统色，api.settings.get() 读回真设置后再切回来——当着用户的面闪两次。
  const [settings, setSettings] = useState<AppSettings>({
    ...DEFAULT_SETTINGS,
    theme: api.initialTheme ?? DEFAULT_SETTINGS.theme,
    // 语言同理（main.tsx 首帧的 <html lang> 也是按它写的）：不对齐的话选了中文的人先看一帧英文
    ...(api.initialLanguage === null ? {} : { language: api.initialLanguage }),
  });
  // 界面语言：单语主题说了算，双语主题听语言设置（shared 的 effectiveLanguage）
  const resolvedTheme = useTheme(settings.theme, settings.language);
  const locale = effectiveLanguage(resolvedTheme, settings.language);
  const t = messagesOf(locale);
  const refresh = useCallback(async () => {
    try {
      setProviders(await api.provider.list());
      setProvidersError(null);
    } catch (cause) {
      setProviders([]);
      setProvidersError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** 设置真的从主进程读回来了没有（读回之前手里是默认值，「看没看过引导」不能按它判） */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    void refresh();
    // 读不到设置就用默认——主题是可以随时再选的，不值得为此让外壳起不来
    void api.settings
      .get()
      .then((loaded) => {
        setSettings(loaded);
        setSettingsLoaded(true);
      })
      .catch(() => setSettings(DEFAULT_SETTINGS));
  }, [refresh]);

  /** 先落盘再回填：写失败时 UI 不该显示一个其实没存下来的选择 */
  const changeSettings = useCallback((patch: SettingsPatch) => {
    void api.settings.set(patch).then(setSettings);
  }, []);

  /** 文档面板的纸面：设置里的值按当前主题折算（纸面主题下回落 quiet 并锁住切换） */
  const docPaper = useMemo(() => {
    const { paper, locked } = effectivePaper(settings.docPaper, resolvedTheme);
    return { paper, locked, setPaper: (next: DocPaper) => changeSettings({ docPaper: next }) };
  }, [settings.docPaper, resolvedTheme, changeSettings]);

  /**
   * 星标是个**开关**：在库里就取消、不在就加到最后（新星的排在末尾，
   * 因为左栏的星标视图按加入顺序列）。
   *
   * 读的是 ref 而不是 `settings.starredModels`：连点两下时两下都发生在回包之前，
   * 用闭包里那份旧列表的话，两下都按「加」算——星标就永远点不灭。
   */
  const starredRef = useRef<ModelPair[]>([]);
  useEffect(() => {
    starredRef.current = settings.starredModels ?? [];
  }, [settings.starredModels]);
  const toggleStarModel = useCallback(
    (pair: ModelPair) => {
      const key = `${pair.providerId}:${pair.modelId}`;
      const list = starredRef.current;
      const next = list.some((p) => `${p.providerId}:${p.modelId}` === key)
        ? list.filter((p) => `${p.providerId}:${p.modelId}` !== key)
        : [...list, pair];
      starredRef.current = next;
      changeSettings({ starredModels: next });
    },
    [changeSettings],
  );

  /** 模型卡片底部「配置模型」的去处：设置面的服务商页（不是通用页） */
  const openProvidersTab = useCallback(() => {
    setSettingsTab("providers");
    setOverlay("settings");
  }, []);

  /** 右侧面板宽度（4-0 拖宽）：拖动中只改本地，松手才落 settings */
  const [panelWidth, setPanelWidth] = useState(RIGHT_PANEL_WIDTH_DEFAULT);
  /** 右栏实际渲染宽（RightPanelSlot 夹过 1/3–2/3 后报上来）：工具栏右栏胶囊只认它 */
  const [panelRenderedWidth, setPanelRenderedWidth] = useState(RIGHT_PANEL_WIDTH_DEFAULT);
  /** 右栏此刻是不是覆盖层（窄窗，或文档面板按聊天列底线判定放不下）：工具栏的右栏胶囊跟它 */
  const [panelOverlay, setPanelOverlay] = useState(false);
  /** 文档面板并排但被挤得比下限还窄 */
  const [panelTight, setPanelTight] = useState(false);
  useEffect(() => {
    if (settings.rightPanelWidth !== undefined) setPanelWidth(settings.rightPanelWidth);
  }, [settings.rightPanelWidth]);
  /** 文档 / 演示文稿面板的宽度：单独记（null = 没拖过，RightPanelSlot 按比例给默认） */
  const [docPanelWidth, setDocPanelWidth] = useState<number | null>(null);
  useEffect(() => {
    setDocPanelWidth(settings.docPanelWidth ?? null);
  }, [settings.docPanelWidth]);

  /** 左侧栏宽度：同一套口径——拖动中只改本地，松手才落 settings（避免写风暴） */
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH_DEFAULT);
  useEffect(() => {
    if (settings.sidebarWidth !== undefined) setSidebarWidth(settings.sidebarWidth);
  }, [settings.sidebarWidth]);

  /**
   * 侧栏折叠态（2026-10-18 起由 App 持有）：收起后没有左侧图标条，「窗口工具」组
   * （侧栏开关 · 新任务）嵌在对话卡页头里（ChatView / SettingsView），与 Sidebar
   * 共用同一份状态。断点自动收起（960 以下）也在这里；手动开合不持久化——窗口
   * 宽度本身不持久化，持久化一个和宽度绑定的状态会打架。
   */
  const [sidebarCollapsed, setSidebarCollapsedRaw] = useState(false);
  /**
   * 文档 / 演示文稿面板放不下并排时先自动收起左侧栏（docSidebar）：
   * none = 这次打开面板还没动过；auto = 是我们收的（关面板时恢复）；user = 用户在此期间手动开合过（不再替他收、也不替他恢复）
   */
  const docSidebar = useRef<"none" | "auto" | "user">("none");
  const setSidebarCollapsed = useCallback((next: boolean | ((current: boolean) => boolean)): void => {
    if (docSidebar.current === "auto") docSidebar.current = "user";
    setSidebarCollapsedRaw(next);
  }, []);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COLLAPSE_BREAKPOINT - 1}px)`);
    const sync = () => setSidebarCollapsedRaw(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  /** 文件面板此刻显示的是一份文档（md / txt）：与「演示文稿」面板同一套宽面板规则（写东西的面板 320 太局促） */
  const [filesShowsDoc, setFilesShowsDoc] = useState(false);
  const docPanelOpen = rightPanel === "docs" || rightPanel === "slides" || (rightPanel === "files" && filesShowsDoc);
  useEffect(() => {
    if (!docPanelOpen) {
      // 关面板：是我们收的就还原；用户动过就不碰
      if (docSidebar.current === "auto") setSidebarCollapsedRaw(false);
      docSidebar.current = "none";
      return;
    }
    // 打开着、放不下并排（覆盖层态）、侧栏还展开着、这次还没动过：先收侧栏腾地方
    // （或者能并排但被挤得比下限还窄：收了侧栏面板就能宽松些）
    if ((panelOverlay || panelTight) && !sidebarCollapsed && docSidebar.current === "none") {
      docSidebar.current = "auto";
      setSidebarCollapsedRaw(true);
    }
  }, [docPanelOpen, panelOverlay, panelTight, sidebarCollapsed]);

  const { session, engine } = useChatSession(providers, t);

  // ── 专注模式（原型：focus-proto）──────────────────────────────
  // 计时、左栏文件视图、星云的气泡 / 卡片与四个出口全在 useFocusShell 里；这里只
  // 递给它 App 才有的事实（设置页 / 子视图的退场、侧栏开合、右栏面板位、提示音）。
  const leaveFocusSurfaces = useCallback((): void => {
    setOverlay(null);
    setShowArchived(false);
    setShowCarryovers(false);
  }, []);
  /**
   * 响了一声就记一笔（`<userData>/chime-log.jsonl`，理由见 shared/notify.ts）：标题取此刻
   * 列表里的真值。记账失败只落 console——提示音的账不能让任何流程失败。
   */
  const logChime = (reason: ChimeReason, ids: readonly string[]): void => {
    const subjects = ids.map((id) => ({
      id,
      title: session.sessions.find((meta) => meta.id === id)?.title ?? "",
    }));
    void api.notify.logChime({ reason, subjects }).catch((cause: unknown) => {
      console.warn("[chime] 记账失败", cause);
    });
  };
  const expandSidebar = useCallback((): void => setSidebarCollapsed(false), []);
  const openFilesPanel = useCallback((): void => setRightPanel("files"), []);
  // 记忆里恢复出来的旧「文档」面板（合并之前存的）：并入文件面板
  useEffect(() => {
    if (rightPanel === "docs") setRightPanel("files");
  }, [rightPanel]);
  const focus = useFocusShell({
    t,
    workspaces: session.workspaces,
    defaultWorkspaceId: session.workspaceId,
    sessions: session.sessions,
    completionSound: settings.completionSound ?? true,
    leaveSurfaces: leaveFocusSurfaces,
    expandSidebar,
    openFilesPanel,
    // 专注到点那一声也记账（useFocusShell 只在开着提示音时调它）
    playChime: () => {
      playCompletionChime();
      logChime("focus-done", []);
    },
  });
  /** `<FilesPanel>` 那两行的别名：保持 B1 之前的原文，#281 要在它旁边插 `focusDone` */
  const focusFilesView = focus.filesView;
  /**
   * 文件面板的「打开这个文件」请求：两个来源——左栏专注视图的双击（focus.fileOpen，token 自增）和右栏「文档」入口
   * （railDocOpen，token 从 DOC_OPEN_TOKEN_BASE 起，两边不撞号）。谁最后来用谁
   */
  const [railDocOpen, setRailDocOpen] = useState<{ path: string; token: number } | null>(null);
  const fileOpenRequest = railDocOpen ?? focus.fileOpen;
  // 左栏专注视图又发了新的打开请求：它比右栏入口那条新，让位
  useEffect(() => {
    if (focus.fileOpen !== null) setRailDocOpen(null);
  }, [focus.fileOpen]);

  // ── 内置命令让右栏打开某个文件（聊天里的完成卡点击 / agent 新建·打开时自动开）──
  // 请求总线见 shell/open-panel.ts；slides 面板收到路径直接打开，文档走文件面板
  const [docOpenRequest, setDocOpenRequest] = useState<{ path: string; nonce: number } | null>(null);
  const openFileInFocus = focus.openFile;
  useEffect(
    () =>
      onOpenPanelRequest((hint) => {
        if (hint.kind === "slides") {
          setRightPanel("slides");
          setDocOpenRequest({ path: hint.path, nonce: Date.now() });
        } else {
          openFileInFocus(hint.path);
        }
      }),
    [openFileInFocus],
  );
  // 面板关了就忘掉请求：下回从右栏图标打开，走「上次打开的那份」而不是重放旧请求
  useEffect(() => {
    if (rightPanel !== "slides" && rightPanel !== null) setDocOpenRequest(null);
  }, [rightPanel]);
  useAutoOpenPanel(session.sessionId ?? session.opened?.id ?? null, session.transcript, session.phase !== "idle");

  /**
   * 收起态页头的「新任务」：退出设置页、回到展开侧栏（新任务要落在看得见的列表里），
   * 再发 nonce 信号让 Sidebar 把 TASKS 组展开（新会话不落进收着的组里）——与侧栏里
   * 大按钮的 startNewTask 同一条纪律，状态在两棵子树里，只能靠信号带过去。
   */
  const newTaskNonceRef = useRef(0);
  const [newTaskSignal, setNewTaskSignal] = useState(0);
  const startNewTaskFromTools = (): void => {
    setOverlay(null);
    setSidebarCollapsed(false);
    newTaskNonceRef.current += 1;
    setNewTaskSignal(newTaskNonceRef.current);
    session.newTask();
  };
  /**
   * 遗留事项带上下文开工（转成任务）：侧栏遗留面板的「带上下文继续」与右栏「这条任务 ›
   * 留到以后」的「转成任务」共用这一条路（2026-10-30 之前它是侧栏里的一段内联回调）。
   * 开工即回对话：退出遗留面板与整页盖层、展开侧栏；新会话落在来源会话的组里（cwd / 归属
   * 跟随它，见 useChatSession.startCarryoverTask），那一组得展开——工作区组在新会话打开时由
   * Sidebar 自己展开（「打开的会话落在收着的组里就展开」那条 effect），TASKS 组靠新任务信号。
   */
  const startCarryoverTask = (item: Carryover): void => {
    setShowCarryovers(false);
    setOverlay(null);
    setSidebarCollapsed(false);
    const source = session.sessions.find((meta) => meta.id === item.sourceSessionId);
    if (source?.workspaceId == null) {
      newTaskNonceRef.current += 1;
      setNewTaskSignal(newTaskNonceRef.current);
    }
    session.startCarryoverTask(item);
  };
  /**
   * 带着会话目标开新会话（右栏进度「目标」上的动作）：与转成任务同一条路——开工即回对话、侧栏展开、
   * 新会话落在来源会话的组里。
   */
  const startGoalTask = (sourceSessionId: string, makeSeed: (sourceTitle: string | null) => string | null): void => {
    setShowCarryovers(false);
    setOverlay(null);
    setSidebarCollapsed(false);
    const source = session.sessions.find((meta) => meta.id === sourceSessionId);
    if (source?.workspaceId == null) {
      newTaskNonceRef.current += 1;
      setNewTaskSignal(newTaskNonceRef.current);
    }
    session.startGoalTask(sourceSessionId, makeSeed);
  };
  /** 窗口宽（胶囊几何要用：会话胶囊居中于对话列、右栏胶囊钉分隔线） */
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const sync = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // ── 论文工作台的两种布局（features/files/paper-layout.ts）──────────────
  /**
   * 布局偏好（每个会话各自记着，**只存内存**——与右栏宽度同一条纪律，本 PR 不新增
   * 落盘协议）。真正生效的档位由窗口宽与「文件面板是否打开」裁决：窄窗 / 工作台没开
   * 时退回对话为主，但不清掉偏好——窗口宽回来、工作台重新打开时 B 自己回来。
   */
  const [paperLayout, setPaperLayout] = useState<PaperLayout>(PAPER_LAYOUT_DEFAULT);
  const paperMemoryRef = useRef<Map<string, PaperLayout>>(new Map());
  const paperSessionKeyRef = useRef<string | null>(null);

  const workbenchOpen = rightPanel === "files";
  const paperColumn = effectivePaperLayout({ wanted: paperLayout, windowWidth, workbenchOpen });
  const paperMode = paperColumn === "paper";
  /**
   * 文件面板里真有带 PDF 的 LaTeX 项目（由 FilesPanel 上报）。布局 A 的自动并排与
   * 「并排前把右栏拉宽」都要先知道这一点，而项目事实住在面板里。
   */
  const [paperReady, setPaperReady] = useState(false);
  useEffect(() => {
    if (rightPanel !== "files") setPaperReady(false);
  }, [rightPanel]);
  /** 布局 A 的大屏自动并排：窗口 ≥1800 且项目有 PDF（窗口窄回去就自动回到单栏） */
  const autoSplit =
    paperColumn === "chat" &&
    shouldSplitPaper({ layout: "chat", windowWidth, hasPdf: paperReady, workbenchOpen });
  const autoSplitWidth = autoSplitPanelWidth({
    layout: paperColumn,
    windowWidth,
    hasPdf: paperReady,
    workbenchOpen,
  });
  /** 自动加宽之前的宽度（effect 里读的那一拍值，不把 panelWidth 加进依赖） */
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  /**
   * 自动并排那一刻把右栏拉宽一次：默认 320 里并排两块，每块 160——那就是原型里被
   * 否掉的形态。只在**进入**并排时纠正一次（用户之后把面板拖窄照常生效——持续夹取会
   * 让「拖窄」这个动作失效）；离开并排（窗口缩回 1800 以下）时把它收回去。
   *
   * 为什么要收回：这个宽度是本地 state，不收回就会带进后续所有的「窄窗口」形态；
   * 窗口再缩到 1000 时面板宽远大于 pane，而右栏的夹取又是按「自己 + 对话区」量出来的
   * （对话区被挤成 0 之后就自洽地停在原宽），结果对话区被整块盖掉。收回让这一刀不制造
   * 那个形态；**用户自己拖动**造成的同样局面是另一回事（既有的夹取自洽问题，不在这里改）。
   */
  const panelBeforeAutoSplitRef = useRef<{ before: number; widened: number } | null>(null);
  useEffect(() => {
    if (autoSplitWidth > 0) {
      if (panelBeforeAutoSplitRef.current === null) {
        const before = panelWidthRef.current;
        panelBeforeAutoSplitRef.current = { before, widened: Math.max(before, autoSplitWidth) };
        setPanelWidth(panelBeforeAutoSplitRef.current.widened);
      }
      return;
    }
    const pending = panelBeforeAutoSplitRef.current;
    if (pending === null) return;
    panelBeforeAutoSplitRef.current = null;
    // 用户在并排期间自己拖过就保留他的；没动过才回到进并排前的宽度
    setPanelWidth((width) => (width === pending.widened ? pending.before : width));
    // 只跟「并排开关」走：panelWidth 在闭包里只用于「进并排前是多少」这一个快照
  }, [autoSplitWidth]);

  /**
   * 布局 B 自动收起左侧栏，退出时恢复**进 B 之前**的折叠态（不恢复宽度：宽度本来
   * 就没被改过，B 只改折叠）。窄于 960 时退出不展开——那是既有的自动收起断点。
   */
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;
  const sidebarBeforePaperRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (paperMode) {
      if (sidebarBeforePaperRef.current === null) {
        sidebarBeforePaperRef.current = sidebarCollapsedRef.current;
      }
      setSidebarCollapsed(true);
      return;
    }
    const before = sidebarBeforePaperRef.current;
    if (before === null) return;
    sidebarBeforePaperRef.current = null;
    setSidebarCollapsed(before || window.innerWidth < COLLAPSE_BREAKPOINT);
  }, [paperMode]);

  /**
   * 切换布局（页头最右那颗键与 Ctrl+\\ 同一个入口）。工作台没开时切换无处落脚：
   * 布局 B 的主位就是稿件工作台，所以只有文件面板开着（或已经在 B 里）才动作。
   */
  const togglePaperLayout = useCallback((): void => {
    if (!paperMode && rightPanel !== "files") return;
    setPaperLayout((current) => nextPaperLayout(current));
  }, [paperMode, rightPanel]);

  // Ctrl+\\ / ⌘+\\：两种布局的快捷键（原型）。终端与输入框里放过——那里有自己的
  // 语义；源码编辑器里接（CodeMirror 没有 Ctrl+\\ 的默认绑定）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key !== "\\") return;
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm") !== null) return;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (target.isContentEditable && target.closest(".tex-editor") === null) return;
      }
      event.preventDefault();
      togglePaperLayout();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePaperLayout]);
  /** 右栏胶囊的宿主（Toolbar 挂好回填；各面板的页头内容 portal 进来） */
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null);
  /** 抽屉槽：与主槽共用引擎的第二个「正在看」。辅助对话就是普通 task（Q2 裁决）。 */
  const drawerView = useSessionView(engine, "drawer");

  /**
   * 通道/子会话数据只在主槽正看着一条**根会话**（meta 没有 parentId）且
   * 没盖着设置页时才有意义——同 ChatView.tsx 里 `ownSide` 的推导口径（meta 查不到
   * 时缺省当根会话），两处必须一致，否则入口出现但点开是空的，或入口消失了
   * 通道数据还在算。
   */
  const mainOpenId = session.sessionId ?? session.opened?.id ?? "";
  const mainOpenMeta = session.sessions.find((m) => m.id === mainOpenId) ?? session.opened;

  // 切会话那一拍：把离开会话此刻的布局记下，再恢复目标会话的（没记过 = 对话为主）。
  // paperLayout 进依赖是为了让「离开时」读到当前值；同会话内布局变化时下面早退
  useEffect(() => {
    const key = mainOpenId === "" ? null : mainOpenId;
    const previous = paperSessionKeyRef.current;
    paperSessionKeyRef.current = key;
    if (previous === key) return;
    if (previous !== null) {
      paperMemoryRef.current = rememberPaperLayout(paperMemoryRef.current, previous, paperLayout);
    }
    setPaperLayout(
      key === null ? PAPER_LAYOUT_DEFAULT : recallPaperLayout(paperMemoryRef.current, key),
    );
  }, [mainOpenId, paperLayout]);
  const channelParentId =
    overlay !== null || mainOpenId === "" || mainOpenMeta?.parentId !== undefined ? null : mainOpenId;
  const channelParentTitle = mainOpenMeta?.title ?? "";

  // 通道清单：右栏入口的「在等你」角标（waiting + approval）从这里算。父子会话面板
  // 已删（2026-10-12 用户裁决）：它总是自己弹出，且把两边对话抽到第三个又长又啰嗦
  // 的地方——沟通回到两边对话流，Sub-sessions 面板变收件箱，不再有任何自动弹出。
  const channelSummaries = useChannelSummaries(channelParentId);

  /**
   * 工具栏会话胶囊的数据（2026-10-19 方案 B v2：对话卡不再有页头，标题 / id /
   * 收工 / 子会话芯片 / 父会话面包屑全住这颗胶囊，见 SessionCapsule）。
   * 标题口径同旧页头：落盘的 meta 标题，没落盘就是「新任务」。
   */
  const capsuleTitle = mainOpenMeta?.title ?? t.common.newTask;
  const capsuleShortId = mainOpenId === "" ? null : mainOpenId.slice(0, 6);
  const capsuleParentId = mainOpenMeta?.parentId;

  /** 主槽里的弹出宿主（完成提醒卡 / 铃铛清单 portal 进去）；state 而非 ref：挂上后要触发一次渲染 */
  const [popHost, setPopHost] = useState<HTMLDivElement | null>(null);


  /**
   * Sub-sessions 面板（子会话 PR4c）：入口只在主槽正看着一条有子会话的根会话时出现，
   * 复用上面 `channelParentId` 的「根会话 / 非设置页」口径——两处必须一致，否则
   * 入口出现但点开是空的，或入口消失了通道数据还在算。
   */
  const subSessionChildren = channelParentId === null ? [] : childSessions(session.sessions, channelParentId);
  const hasSubSessions = subSessionChildren.length > 0;
  /** 「在等你」的子会话数（question + 待审批）：右栏入口的角标，为 0 不显示 */
  const waitingOnYou = subSessionChildren.filter((meta) => {
    const status = subSessionStatusOf(meta.id, channelSummaries.get(meta.id)?.status, engine);
    return status === "waiting" || status === "approval";
  }).length;

  /**
   * 面板两层状态机（`sub-sessions-state.ts`，原样搬自旧 wip）：App 持有，
   * `SubSessionsPanel` 受控渲染——派出卡点击（主槽的 `ChatView`）与面板本体分处
   * 两棵子树，accent 描边要在主槽里知道「面板会话层现在开着哪条」，状态放子组件里够不到。
   */
  const [subSessionsNav, setSubSessionsNav] = useState<SubSessionsView>(SUB_SESSIONS_LIST);
  /** 会话层的查看槽：与主槽/抽屉槽同一份引擎，互不串（同 drawerView 的先例） */
  const subSessionsView = useSessionView(engine, "subsessions");

  // 主槽换会话 → 面板回列表层（“面板里开着的那条挂错了母亲”，2.1 裁决）；
  // 只在 mainOpenId 真的变化时才重置——见 syncToMainSession 本身的纯逻辑
  const subSessionsMainIdRef = useRef<string | null>(null);
  /** 文件面板的「Esc 先退一层」：预览开着时由它关预览（FilesPanel 填，Esc 监听里先问它） */
  const filesEscapeRef = useRef<(() => boolean) | null>(null);
  /**
   * 审查面板的一次性定位请求（轮尾卡 / 界碑卡点「在面板里看」）：token 单调递增，
   * 同一路径连点两次也能触发展开。ChatView 经 props 回调上报，面板消费后自会展开。
   */
  const [reviewFocus, setReviewFocus] = useState<{ path: string; token: number } | null>(null);
  const reviewFocusTokenRef = useRef(0);
  const openReviewAt = useCallback((path: string) => {
    reviewFocusTokenRef.current += 1;
    setReviewFocus({ path, token: reviewFocusTokenRef.current });
    setRightPanel("review");
  }, []);
  /**
   * 摘抄（审查面板 › 摘抄页签）点一条「回到原文」：目标不是当前会话时先切过去，
   * 跳转请求由主槽 ChatView 在转录加载到那一轮后消费（滚到 + 闪一下）。token 同
   * reviewFocus 的机制——同一条连点两次也会重新定位。
   */
  const [excerptJump, setExcerptJump] = useState<ExcerptJumpRequest | null>(null);
  const excerptJumpTokenRef = useRef(0);
  const openExcerpt = useCallback(
    (jump: ExcerptJump) => {
      excerptJumpTokenRef.current += 1;
      setExcerptJump({ ...jump, token: excerptJumpTokenRef.current });
      if (jump.sessionId !== mainOpenId) void session.openSession(jump.sessionId);
    },
    [mainOpenId, session],
  );
  /** 摘抄列表的版本：主槽每摘一条 +1，审查面板的摘抄页签据此重拉 */
  const [excerptRevision, setExcerptRevision] = useState(0);
  const bumpExcerpts = useCallback(() => setExcerptRevision((value) => value + 1), []);
  /**
   * 记忆条目的「回到原文」：退出记忆库，打开出处会话并滚到支撑它的最新一轮——
   * 走摘抄跳转同一条路（原话片段找得到就闪那段，找不到退回那一轮的用户消息）。
   */
  const jumpToMemorySource = useCallback(
    (view: MemoryEntryView) => {
      setOverlay(null);
      const turn = view.entry.turns[view.entry.turns.length - 1];
      openExcerpt({
        sessionId: view.entry.sessionId,
        role: "user",
        text: view.quote ?? "",
        ...(turn !== undefined ? { turn } : {}),
      });
    },
    [openExcerpt],
  );
  /**
   * 对话里记忆行的「在审查面板里看」：打开审查面板并切到记忆页签（token 递增的
   * 一次性请求，同 reviewFocus）。面板换走就清掉——否则下次手动打开审查面板时
   * 挂载又会被它拽到记忆页签。
   */
  const [memoryFocus, setMemoryFocus] = useState<number | null>(null);
  const memoryFocusTokenRef = useRef(0);
  const openMemoryReview = useCallback(() => {
    memoryFocusTokenRef.current += 1;
    setMemoryFocus(memoryFocusTokenRef.current);
    setRightPanel("review");
  }, []);
  useEffect(() => {
    if (rightPanel !== "review") setMemoryFocus(null);
  }, [rightPanel]);
  /**
   * PDF 引用的一次性跳转请求（实验功能「PDF 引用」：正文里的引用编号被点）：同
   * reviewFocus 的 token 机制——同一条引用连点两次也会重新定位。开文件面板，由它找
   * PDF 所在的根、打开预览、滚到原文并高亮。
   */
  const [citeFocus, setCiteFocus] = useState<CiteFocusRequest | null>(null);
  const citeFocusTokenRef = useRef(0);
  const openCitation = useCallback(
    (citation: PdfCitation) => {
      citeFocusTokenRef.current += 1;
      // 请求带上出生会话戳（主槽此刻的会话，与 FilesPanel 的 sessionId 同一 null 形
      // 口径）：文件面板只在主槽会话的根里找 PDF，换了会话后旧请求被 cite-focus.ts
      // 判作废——不会拿旧会话的路径对新会话的根报「打不开」（2026-10-18 跨会话
      // citeOutside 误报：面板重挂后 consumedCiteRef 归零，旧请求重放）
      setCiteFocus({
        citation,
        token: citeFocusTokenRef.current,
        session: mainOpenId === "" ? null : mainOpenId,
      });
      setRightPanel("files");
    },
    [mainOpenId],
  );
  // 引用跳转请求是「本次文件面板打开」的一次性请求：面板一旦不再是 files（切到
  // 别的面板 / 收起，含按会话恢复面板），请求一并作废——否则面板重挂后
  // consumedCiteRef 归零，旧请求重放会顶开 PDF 标签、重新跳转，等于变相恢复了
  // 「不随会话恢复」的标签状态。同会话里关面板再开也不再重放：点引用的效力
  // 随那次面板打开一起结束
  useEffect(() => {
    if (rightPanel !== "files") setCiteFocus(null);
  }, [rightPanel]);
  useEffect(() => {
    const nextMainId = mainOpenId === "" ? null : mainOpenId;
    // 上一拍 id 必须在派发 setState 之前读出来链进局部量：updater 可能被 React
    // 推迟到渲染期才执行（同 fiber 已有待处理更新时——子会话在跑时引擎的
    // applyStates/refreshSessions 更新不断，正是常态），那时再读 ref 拿到的已是
    // 下面那行写进去的新值，previousMainId === nextMainId 恒真、重置被静默吞掉
    // ——「切主会话右栏子会话面板不跟着切」的根因（React 19.2.8 隔离探针实测复现）
    const previousMainId = subSessionsMainIdRef.current;
    setSubSessionsNav((prev) => syncToMainSession(prev, previousMainId, nextMainId));
    subSessionsMainIdRef.current = nextMainId;
  }, [mainOpenId]);

  // 每条会话记住自己的右栏路径（right-panel-memory.ts，用户 2026-10-18：「每个 session，应该记住自己离开的
  // 时候，右侧面板是啥」；2026-11-07：「这个树节点要往下探呀」）：开着哪个面板，再往下一层
  // （进了哪个插件 / 哪条自动化 / 哪个页签……由面板经 sub + onSubChange 报上来）。
  // 面板一变就写进记忆（见下方「写穿」），切主槽会话的那一拍只管**取**：恢复目标会话
  // 记着的路径（没记过 = 关着），并换新右栏的 epoch——面板内容的 key 带着它，切会话必定重挂，
  // 面板里的状态只从记忆里来、不会从上一条会话原样带过去。
  // 文件面板的标签仍不跟着恢复（切会话清标签的既有设计），终端 / 辅助对话状态全局共用，三者不重挂、不记第二层。
  // 记忆落盘到 <userData>/right-panel-memory.json（防抖），重启后保留；右栏宽度仍全局共用。
  // 首页（mainOpenId ""）不是会话：不记；回到首页面板关着（与改前一致）。抽屉 / 辅助对话不开转例：
  // 右栏面板位属于主槽视图，一律按主槽会话记。
  // rightPanel 进依赖是为了让切换那一拍读到「离开时」的面板值；面板自身变化时
  // previous === mainOpenId 早退，自然空跑
  const panelMemoryRef = useRef<PanelMemory>(new Map());
  /** 下一次右栏变化是「按会话恢复」而不是用户打开的（面板打开次数要跳过它） */
  const panelRestoredRef = useRef(false);
  const panelMainIdRef = useRef(mainOpenId);
  /** 右栏此刻属于哪条会话（null = 首页 / 还没有会话，不写记忆）与第几次恢复；面板内容的 key 用 */
  const [railCtx, setRailCtx] = useState<{ owner: string | null; epoch: number }>(() => ({ owner: mainOpenId === "" ? null : mainOpenId, epoch: 0 }));
  /** 当前面板自己报上来的「停在哪一层」；panel 与 rightPanel 不一致的那份是过期的，下面的 effect 会清掉 */
  const [railPath, setRailPath] = useState<PanelPath>(CLOSED_ENTRY);
  /**
   * 一次性：恢复成这个面板，而不是会话自己的记忆。`sessionId` 为 null = 下一条**还没记过面板的新会话**拿到 id 时
   * （「和智能体一起做一个」用）；给了 id = 只在切到**那一条**会话时（「正在做」的「回到对话」用：它早就有自己的面板记忆）。
   * 只带这一次，之后切会话照会话记忆。
   */
  const carryPanelRef = useRef<{ panel: RightPanelKind; sessionId: string | null } | null>(null);

  // 主槽不再是「有子会话的根会话」→ 入口消失，面板若开着就关（不止是不显示入口，
  // 面板本身也不该继续挂着一条够不到数据的内容）。在按会话恢复面板之后跑：恢复出
  // 的 subsessions 若在新主槽下已不合法，由这里兜底关掉
  // 函数式更新：读的是排在前面的「按会话恢复」的结果，不是闭包里切换前的旧值（见 panelAfterSubSessionsGone）
  useEffect(() => {
    if (rightPanel === "subsessions" && !hasSubSessions) setRightPanel((prev) => panelAfterSubSessionsGone(prev, hasSubSessions));
  }, [rightPanel, hasSubSessions]);

  // 会话层换了目标 id → 查看槽跟着 openSession；openSession 内部本身有「已经是
  // 这条就不重复打开」的守卫，这里不必比对上一次的 id。subSessionsView 每次渲染
  // 都是新对象（同 drawerView 的先例），依赖里只放 subSessionsNav 本身
  useEffect(() => {
    if (subSessionsNav.kind === "session") void subSessionsView.openSession(subSessionsNav.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subSessionsNav]);

  /** 派出卡点击（主槽 ChatView）与列表行点击（面板本体）共用同一个稳定回调 */
  const openSubSessionInPanel = useCallback((childId: string) => {
    setSubSessionsNav(openSubSession(childId));
    setRightPanel("subsessions");
  }, []);
  /** 头部「N sub-sessions」芯片：强制回列表层（不是「resume 到上次的位置」） */
  const openSubSessionsList = useCallback(() => {
    setSubSessionsNav(SUB_SESSIONS_LIST);
    setRightPanel("subsessions");
  }, []);
  /** Open as main：主槽换看这条子会话（2.1 裁决「面板关闭」在按会话记忆后泛化为
   * 「恢复这条会话自己记的面板」——没记过就是关着，首轮行为与裁决原文一致；
   * 这里不再显式关面板，否则会把离开的那条会话错记成「关着」） */
  const openAsMain = useCallback(
    (childId: string) => {
      void session.openSession(childId);
    },
    [session],
  );
  // 意图面板（实验功能）：仍在转录里的 user item id 集（被回退的问不进轮次）与
  // 「打开会话」出口（与子会话的 openAsMain 同一条路）
  const intentLiveTurnIds = useMemo(
    () =>
      new Set(
        session.transcript
          .filter((record): record is Extract<typeof record, { role: "user" }> => record.role === "user")
          .map((record) => record.id),
      ),
    [session.transcript],
  );
  /** 右栏会话层正开着的那条子会话 id——只在面板真的开着时才算「点亮」，见派出卡描边 */
  const litSubSessionId =
    rightPanel === "subsessions" && subSessionsNav.kind === "session" ? subSessionsNav.sessionId : null;

  /**
   * agent 开了可见终端（terminal:agent-open）→ **不再自动弹出终端面板**（2026-10-30
   * 用户裁决，推翻 Proma 同款的自动点亮）：「我只需要知道它在 run，没必要跳出来」——
   * 在跑与输出尾巴由对话里的工具行说（过程显示的当前步 + 输出尾巴）。终端照常建在
   * 面板里，记下 id：用户自己打开终端面板时直接落在 agent 开的那个 tab 上。
   * 信号是一次性的，TerminalPanel 消费完就清。
   */
  const [pendingTerminal, setPendingTerminal] = useState<string | null>(null);
  /**
   * 文件面板「在终端安装」：把一条命令**填进可见终端**（以粘贴方式进 xterm，
   * 不回车）。缺宏包的 tlmgr 可能要 sudo / 管理员密码，回车与提权都留给用户。
   * token 单调递增：同一命令连点两次也重新粘贴一次。
   */
  const [pendingTerminalInput, setPendingTerminalInput] = useState<{ text: string; token: number } | null>(null);
  const terminalInputTokenRef = useRef(0);
  /**
   * 缺宏包「在终端安装」之后的提示（文件面板顶部一行）。住在 App 而不是文件面板：点安装
   * 会把右栏切到终端，文件面板随之卸载——提示放面板里会正好在最该出现时丢掉。
   * 下一次编译开始时清掉（装没装好，编译那一下会说明）。
   */
  const [latexInstallNotice, setLatexInstallNotice] = useState(false);
  // 换会话 / 换工作区就不再是「刚在这个项目里装了包」——提示跟着那一次编译走
  const latexNoticeScope = `${session.sessionId ?? ""}|${session.workspaceId ?? ""}`;
  useEffect(() => {
    setLatexInstallNotice(false);
  }, [latexNoticeScope]);

  const runInTerminal = useCallback((text: string): void => {
    terminalInputTokenRef.current += 1;
    setPendingTerminalInput({ text, token: terminalInputTokenRef.current });
    setRightPanel("terminal");
  }, []);
  useEffect(
    () =>
      api.terminal.onEvent((event) => {
        if (event.type !== "agent-open") return;
        setPendingTerminal(event.terminalId);
      }),
    [],
  );
  // 停靠记忆在设置里（哪些 task 开在辅助对话的标签条上）；兼容存量文件：
  // 旧版本可能把 "new" 占位写进了 docked，启动时一并洗掉。
  // 抽屉并入统一面板壳后 drawer.width 不再有消费者——宽度共用 rightPanelWidth（Q3）。
  const [docked, setDocked] = useState<DockedTab[]>(DEFAULT_SETTINGS.drawer.docked);
  useEffect(() => {
    setDocked(settings.drawer.docked.filter((tab) => tab !== NEW_TASK_TAB));
  }, [settings.drawer]);

  /** 停靠改动：只发改的键，主进程做 drawer 内部的键级合并
   *  （整块回写会拿到渲染层闭包里的旧值，先后覆盖有竞态——真机冒烟实测） */
  const changeDocked = useCallback(
    (docked: DockedTab[]) => {
      setDocked(docked);
      changeSettings({ drawer: { docked } });
    },
    [changeSettings],
  );

  /**
   * 后台会话完成提醒（用户 2026-10-10，同日二轮改需求）：长程任务在一条会话里
   * 跑着，人去了别的会话，跑完时界面上什么都不发生。现在跑完那一拍：
   * - 响一声客舱呼唤铃（设置可关）；
   * - 没在看它的话，把未读写进 meta（SessionMeta.unread，session:unread 落盘，
   *   **重启后还在**），侧栏那一行亮 3/3 状态饼，辅助对话图标旁弹卡片问怎么看：
   *   马上看（主槽换成它）/ 辅助对话里看 / 稍后（保持未读）。
   * 点进去看过（主槽或辅助对话正显示它）即清未读（同样落盘）。判定在
   * completion-notice.ts；侧栏状态饼与右下角铃铛清单都从 sessionRunState 读同一份
   * 状态。只认根会话——子会话跑完由母会话的通道回报，不单独打扰人。
   */
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [drawerFocus, setDrawerFocus] = useState<{ tab: string; token: number } | null>(null);
  const drawerFocusTokenRef = useRef(0);
  /** 此刻「在看」的会话：主槽（没被设置页盖住时）与开着的辅助对话 */
  const drawerOpenId = drawerView.sessionId ?? drawerView.opened?.id ?? null;
  const watchedIds = [
    ...(overlay !== null || mainOpenId === "" ? [] : [mainOpenId]),
    ...(rightPanel === "drawer" && drawerOpenId !== null ? [drawerOpenId] : []),
  ];
  const watchedKey = watchedIds.join("\n");
  /** 未读清单：从 meta 读（真源在盘上），不再另存一份 renderer state */
  const unreadSessions = session.sessions.filter((meta) => meta.unread != null);
  /** 把一批会话标成未读：at 此刻铸；failed 查槽的回合失败（重试耗尽），同样是快照 */
  const markUnread = useCallback(
    (ids: readonly string[]) => {
      void Promise.all(
        ids.map((id) =>
          api.session.setUnread(id, { at: Date.now(), failed: session.turnErrorOf(id) !== null }),
        ),
      ).then(() => engine.refreshSessions());
    },
    [engine, session],
  );
  /** 清未读（看过即清 / 全部标为已读）：目标 id 由调用方从真值现算，不闭包旧列表 */
  const clearUnreadOf = useCallback(
    (ids: readonly string[]) => {
      void Promise.all(ids.map((id) => api.session.setUnread(id, null))).then(() =>
        engine.refreshSessions(),
      );
    },
    [engine, session],
  );
  const prevStatesRef = useRef(engine.states);
  /** 落定时子树还在跑、提醒先压着的根会话（treeNotices）：纯判定状态，不驱动渲染 */
  const heldNoticesRef = useRef<ReadonlySet<string>>(new Set());
  /** 专注中（计时里）：完成提醒静音——记未读、不响铃、不弹卡（用户裁决：专注期间
   * 其它会话跑完只记帐，专注结束后铃铛照常可见）。done 之后恢复常觃。 */
  const focusQuiet = focus.quiet;
  useEffect(() => {
    const prev = prevStatesRef.current;
    prevStatesRef.current = engine.states;
    // 只认根会话；列表里还查不到的（刚建）当根会话。自动化新开的运行会话（没转成普通会话的）也不单独
    // 打扰人——它们收在右栏自动化面板里，跑完的结果看那一条自动化的运行记录
    const settled = settledSessions(prev, engine.states).filter((id) => {
      const meta = session.sessions.find((candidate) => candidate.id === id);
      return meta === undefined || (meta.parentId === undefined && (meta.automationId === undefined || meta.promoted === true));
    });
    if (settled.length === 0 && heldNoticesRef.current.size === 0) return;
    // 子树还在跑的先压着，整棵停下那拍再提醒（母会话每被子会话叫醒一次就响一声的根因，
    // 见 completion-notice.ts 的 treeNotices）
    const { notify, held } = treeNotices({
      settled,
      held: heldNoticesRef.current,
      states: engine.states,
      sessions: session.sessions,
      failed: (id) => session.turnErrorOf(id) !== null,
    });
    heldNoticesRef.current = held;
    if (notify.length === 0) return;
    const windowActive = !isWindowInactive({
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    });
    const ringFor: string[] = [];
    const fresh: string[] = [];
    for (const id of notify) {
      const plan = planNotice({
        watched: watchedIds.includes(id),
        windowActive,
        soundOn: focusQuiet ? false : (settings.completionSound ?? true),
      });
      if (plan.sound) ringFor.push(id);
      if (plan.unread) fresh.push(id);
    }
    // 同拍多条只响一声，记在它们所有人头上
    if (ringFor.length > 0) {
      playCompletionChime();
      logChime("session-settled", ringFor);
    }
    const latest = fresh[fresh.length - 1];
    if (latest !== undefined) {
      markUnread(fresh);
      // 专注中不弹卡（未读照记，铃铛清单里看得到）；结束后新落定的照常弹
      if (!focusQuiet) setNoticeId(latest);
    }
    // 只在槽变化时判定；在看谁、开关值读本次渲染的闭包，就是这一拍的真值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.states]);
  // 看过即清：主槽或辅助对话显示了它，未读（盘上的）与卡片一起退。
  // 列表读本渲染闭包里的真值——watchedKey 变了的那一拍，列表必然是新的
  useEffect(() => {
    const hit = watchedIds.filter((id) =>
      session.sessions.some((meta) => meta.id === id && meta.unread != null),
    );
    if (hit.length > 0) clearUnreadOf(hit);
    setNoticeId((current) => (current !== null && watchedIds.includes(current) ? null : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey]);
  /** 在辅助对话里打开一条会话（当前主槽不动）：提醒卡与铃铛清单共用 */
  const openInSideChat = (id: string): void => {
    changeDocked(dockTab(docked, id));
    drawerFocusTokenRef.current += 1;
    setDrawerFocus({ tab: id, token: drawerFocusTokenRef.current });
    setRightPanel("drawer");
  };
  /**
   * 意图条目的「打开会话」（2026-10-14 用户裁决）：在**辅助对话**（右栏 drawer）里
   * 打开那条来源会话——主槽不动，右栏从「意图」切过去。存在性在渲染时就判定
   * （本机会话 id 集传进面板）：不存在的按钮直接禁用并就地说明，不让用户点了才知道。
   */
  const intentOpenableIds = useMemo(
    () => new Set(session.sessions.map((meta) => meta.id)),
    [session.sessions],
  );

  const noticeMeta = noticeId === null ? undefined : session.sessions.find((meta) => meta.id === noticeId);
  const completionNotice =
    noticeMeta === undefined
      ? null
      : {
          title: noticeMeta.title,
          failed: session.turnErrorOf(noticeMeta.id) !== null,
          onOpenNow: () => {
            setNoticeId(null);
            setOverlay(null);
            void session.openSession(noticeMeta.id);
          },
          onSideChat: () => {
            setNoticeId(null);
            openInSideChat(noticeMeta.id);
          },
          onLater: () => setNoticeId(null),
        };

  /**
   * 右下角铃铛的清单（2026-10-10 二轮）：所有状态饼亮着的根会话——在等你、未读
   * （跑完 / 跑挂没看）、在跑——排序「等你 > 未读 > 在跑，同档新在前」。与侧栏
   * 状态饼同一份推导（sessionRunState，单一真源）；点行在主槽打开那条会话，
   * 打开即已读。角标只数未读（绿 + 红）：用户原话「数字 = 未读数」，在跑不算欠账。
   */
  const noticeRows = useMemo(() => {
    const rows: {
      id: string;
      title: string;
      workspace: string | null;
      state: "running" | "waiting" | "done" | "failed";
      tier: NoticeTier;
      at: number;
    }[] = [];
    for (const meta of rootSessions(session.sessions)) {
      const state = sessionRunState({
        slot: {
          phase: session.phaseOf(meta.id),
          approvals: session.approvalsOf(meta.id).length,
          planAwaiting: session.planAwaitingOf(meta.id),
        },
        children: childSessions(session.sessions, meta.id).map((child) => ({
          phase: session.phaseOf(child.id),
          approvals: session.approvalsOf(child.id).length,
          planAwaiting: session.planAwaitingOf(child.id),
        })),
        unread: meta.unread ?? null,
      });
      if (state === null) continue;
      const tier = noticeTierOf(state);
      if (tier === null) continue;
      rows.push({
        id: meta.id,
        title: meta.title,
        workspace: session.workspaces.find((w) => w.id === meta.workspaceId)?.name ?? null,
        state,
        tier,
        at: meta.unread?.at ?? meta.updatedAt,
      });
    }
    return orderNoticeEntries(rows);
    // phaseOf / approvalsOf 引用稳定（useCallback([])），槽变化靠 engine.states 进依赖
  }, [session.sessions, session.workspaces, session.phaseOf, session.approvalsOf, session.planAwaitingOf, engine.states]);
  /** 铃铛清单点行：主槽打开它；有未读的话顺手清（watchedKey 那一拍也会清，
   *  但它若已在主槽就没有那一拍了，这里兑底） */
  const openFromNotice = useCallback(
    (id: string) => {
      setOverlay(null);
      void session.openSession(id);
      if (session.sessions.some((meta) => meta.id === id && meta.unread != null)) clearUnreadOf([id]);
    },
    [session, clearUnreadOf],
  );

  /** 右侧三个图标共用**一个面板位**（2026-09-12 裁决）：同一时刻至多展开一个，
   *  "drawer" 即辅助对话——三个菜单在同一个壳里只是三种内容。 */
  const handlePanel = useCallback((next: RightPanelKind | null) => {
    // 「文档」入口 = 在文件面板里打开最近的文档（没有就新建一份）：文档与文件合并成一个面板，不再有第二个
    if (next === "docs") {
      setRightPanel("files");
      void openRecentDocument();
      return;
    }
    setRightPanel(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId, session.sessionId, session.opened?.id]);
  /** 右栏「文档」入口：上次在这个工作区打开的文档 → 否则最近改的 .md → 否则新建一份空文档，在文件面板里打开 */
  async function openRecentDocument(): Promise<void> {
    const sessionId = session.sessionId ?? session.opened?.id ?? null;
    const workspaceId = session.workspaceId;
    try {
      const docs = (await api.docs.list({ sessionId, workspaceId })).filter((entry) => entry.kind === "doc");
      const last = getLast(docScope(workspaceId, "doc"));
      const target =
        docs.find((entry) => entry.path === last)?.path ?? docs[0]?.path ?? (await api.docs.create({ sessionId, workspaceId, kind: "doc" })).path;
      setRailDocOpen((prev) => ({ path: target, token: Math.max(prev?.token ?? 0, DOC_OPEN_TOKEN_BASE) + 1 }));
    } catch {
      // 列 / 建都失败（工作区目录不在）：文件面板自己会显示根的状态，这里不另报错
    }
  }
  /** 召回终态卡的「在右栏看图谱」（2026-10-14 终态卡重写）：直达右栏意图面板。引用稳定（TranscriptColumn 是 memo） */
  const openIntentPanel = useCallback(() => handlePanel("intent"), [handlePanel]);
  /** 输入框旁上下文环菜单的「查看上下文」：直达右栏上下文面板 */
  // 「这条任务」面板的页签：右侧图标条开它时保持上次的页签；输入框旁的用量环开它时直接落在「上下文」
  const [taskTab, setTaskTab] = useState<TaskPanelTab>("progress");
  const openContextPanel = useCallback(() => {
    setTaskTab("context");
    handlePanel("context");
  }, [handlePanel]);

  // ── 面板打开次数（shared/panel-usage.ts，本机的统计）──────
  // 只记用户自己打开的：右栏换成别的面板（不管从哪个入口：图标条、「更多」、对话里的
  // 链接、快捷键、「/ + 空格」），「这条任务」开着时切到上下文页签，记忆库 / 遗留 / 归档
  // 打开，铃铛与内置浏览器在各自的入口记。按会话恢复的面板不记（panelRestoredRef）。
  // 只在本机、不上传；失败就算了——这是一份看个大概的统计，不值得打扰用户
  const countPanel = useCallback((key: PanelUsageKey) => {
    void api.panelUsage.bump(key).catch(() => undefined);
  }, []);
  const usageSeenRef = useRef<{ panel: RightPanelKind | null; tab: TaskPanelTab }>({ panel: null, tab: "progress" });
  useEffect(() => {
    const seen = usageSeenRef.current;
    usageSeenRef.current = { panel: rightPanel, tab: taskTab };
    if (panelRestoredRef.current) {
      panelRestoredRef.current = false;
      return;
    }
    const opened = rightPanel !== null && rightPanel !== seen.panel;
    const tabSwitched = rightPanel === "context" && seen.panel === "context" && taskTab !== seen.tab;
    if (rightPanel === null || (!opened && !tabSwitched)) return;
    countPanel(PANEL_USAGE_KEY_OF[rightPanel] ?? (taskTab === "context" ? "context" : "task"));
  }, [rightPanel, taskTab, countPanel]);

  // ── 「/ + 空格」右栏 token 选取（panel-token.ts）────────────────────
  // Composer 把行首或空白后孤立的 / 按空格时（句中同样触发，2026-10-11 用户裁定）
  // 交来插入锚点（那个 / 的位置）；面板选中后
  // 经 tokenPickResult（nonce 一次性请求，同 channelOpenRequest / reviewFocus 的
  // 先例）传回 ChatView 插入并焦点回输入框。选完即收面板：选取是输入辅助，与指令
  // 面板同一种临时性；拖拽入口不受影响（面板开着时随时能拖）。
  const [tokenPickerOn, setTokenPickerOn] = useState(false);
  const tokenPickAnchorRef = useRef<number | null>(null);
  const [tokenPickResult, setTokenPickResult] = useState<TokenPickResult | null>(null);
  const tokenPickNonceRef = useRef(0);
  /** 发起号：面板可能已开着，选取态可能已在——靠它重新聚焦/重置 */
  const [tokenPickRequest, setTokenPickRequest] = useState(0);
  // 选取态开在插件面板里（插件已转正，面板常在）
  const openTokenPicker = useCallback((position: number): boolean => {
    tokenPickAnchorRef.current = position;
    setTokenPickerOn(true);
    setTokenPickRequest((n) => n + 1);
    setRightPanel("plugins");
    return true;
  }, []);
  const finishTokenPick = useCallback(
    (token: string | null): void => {
      // 锚点丢失（面板被切走等）就落到草稿末尾——选取的意图仍是「插进来」
      const position = tokenPickAnchorRef.current ?? session.draft.length;
      tokenPickAnchorRef.current = null;
      setTokenPickerOn(false);
      setRightPanel(null);
      tokenPickNonceRef.current += 1;
      setTokenPickResult({ token, position, nonce: tokenPickNonceRef.current });
    },
    [session.draft],
  );
  // 面板被切走 / 关掉（rail 点了别的、× 、全局 Esc）：选取态跟着退，锚点一并丢
  useEffect(() => {
    if (tokenPickerOn && rightPanel !== "plugins") {
      setTokenPickerOn(false);
      tokenPickAnchorRef.current = null;
    }
  }, [rightPanel, tokenPickerOn]);
  const tokenPicker: TokenPickerControl = {
    onSelect: finishTokenPick,
    onCancel: () => finishTokenPick(null),
    request: tokenPickRequest,
  };

  // Esc 关面板（再点图标 / 面板内 × 之外的第二出口）。Sub-sessions 面板开着且在
  // 会话层时，Esc 只退一层回列表（escapeFrom），不直接关掉整个面板——与面板内部
  // 「返回」按钮同一个退出台阶（子会话 PR4c 2.1）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 菜单 / 重命名框等已经认领的这一下不再接（它们 preventDefault 但不 stopPropagation，见 escape-key.ts）
      if (!isUnclaimedEscape(event)) return;
      if (rightPanel === "subsessions") {
        const next = escapeFrom(subSessionsNav);
        if (next === null) setRightPanel(null);
        else setSubSessionsNav(next);
      } else if (rightPanel === "files" && filesEscapeRef.current?.() === true) {
        // 文件面板开着预览：这一下 Esc 只关预览（退一层），面板留着
      } else if (rightPanel !== null) {
        setRightPanel(null);
      } else if (overlay === "board") {
        // 全局周看板没有别的层要先退：Esc 直接回到对话
        setOverlay(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightPanel, subSessionsNav, overlay]);

  // Ctrl+Alt+D 开关辅助对话（与右图标条按钮同源）。判定抽在 shell/drawer-shortcut.ts：
  // macOS 上 Option 会把 event.key 变成 ∂，只看 key 在 mac 上永远匹配不到
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isDrawerToggleShortcut(event)) {
        event.preventDefault();
        setRightPanel((current) => (current === "drawer" ? null : "drawer"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * 收起动画期间仍渲染原面板：active 置空后先保持挂载（壳的 width 过渡回 0，
   * 与抽屉收起同款 0.2s ease），动画走完再真正卸载。
   */
  const [mountedPanel, setMountedPanel] = useState<RightPanelKind | null>(rightPanel);
  useEffect(() => {
    if (rightPanel !== null) {
      setMountedPanel(rightPanel);
      return;
    }
    if (mountedPanel === null) return;
    const timer = setTimeout(() => setMountedPanel(null), 220);
    return () => clearTimeout(timer);
    // mountedPanel 故意不进依赖：收起窗口里只需为这次置空排一次定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPanel]);

  /** 壳里此刻渲染的内容：active 优先，收起窗口里保持原面板直到收完 */
  const shownPanel = rightPanel ?? mountedPanel;
  const isDocPanel = shownPanel === "docs" || shownPanel === "slides" || (shownPanel === "files" && filesShowsDoc);
  /**
   * 「和智能体一起做一个」（插件页）：在当前工作区（没有则 Home）新开一条任务，输入框预填一句引导，
   * 开头的 `/skill:plugin-creator` 点名内置的做插件技能（发送时由主进程展开成指令块）。
   * 草稿写进新任务槽自己的键（startTaskWithDraft）；从设置里的全屏版触发时设置页盖在主槽上，先退场才看得到新任务；
   * 右栏版触发时右栏保持开着（按会话记忆，新任务槽自己的面板状态）。
   */
  const makePluginWithAgent = useCallback(() => {
    const workspace = session.workspaces.find((w) => w.id === session.workspaceId) ?? null;
    // 从设置页签的全屏版点：先退出设置，新任务才不会落在设置页后面
    setOverlay(null);
    // 一边聊一边看插件页（用户 2026-11-05）：这条新会话拿到 id 时，右栏恢复成插件页而不是「没记过 = 关」。
    // 只带这一次；之后切会话照会话记忆（用户定：插件页不做应用级例外）
    carryPanelRef.current = { panel: "plugins", sessionId: null };
    session.startTaskWithDraft(workspace, t.plugins.makeWithAgentDraft);
  }, [session, t]);
  /** 抽屉选择器要排除的：主槽正看着的那条（它已经在中间了） */
  const mainSessionId = session.sessionId ?? session.opened?.id ?? null;
  /** 「这条任务」头一行的在跑 / 等你：与侧栏状态饼同一个推导（runStateOf，含子会话），所以要 meta */
  const mainMeta = mainSessionId === null ? undefined : session.sessions.find((meta) => meta.id === mainSessionId);

  /**
   * 右栏底部的应用入口（wafo 2026-09-22：设置、遗留、归档全拸到右栏底部 stack，
   * 首页常驻——它们是应用入口不是会话动作）。点亮判定与互斥规则沿用侧栏
   * 底部行时代的行为：子视图互斥，设置盖着时谁也不亮。
   *
   * 遗留事项入口**常驻**，0 条也在（wafo 2026-09-25）：以前 0 条不渲染，导入的会话
   * 没走过收尾、一条遗留都没有，这个入口就整个不见了——用户不知道有这个功能，
   * 也没法确认「现在确实没有遗留」。点进去是面板自己的空态。
   *
   * 点亮判定与点击落点在 `rail-subview.ts`（纯函数，带测试）：没亮 = 打开该子视图
   * 并**退出设置**——设置页里点这两个入口以前只是在底下翻转开关，界面不动。
   */
  // 子会话不参与归档（子会话 PR4c 2.3：session.ts 的契约），角标按根会话数
  const archivedCount = rootSessions(session.sessions).filter((m) => m.archived).length;
  const openCarryoverCount = session.carryovers.filter((item) => item.status === "open").length;
  const experimentalFeatures = settings.experimentalFeatures ?? {};
  // 「正在做」的插件草稿：agent 的 preview_plugin 扫过一个还没安装的文件夹时，按会话记下它的路径；
  // 正看着该会话就同时把右栏切到插件页（右栏版见 PluginDraftView）。这份只记在 renderer 内存里、只管「agent 预览时自动切右栏」；
  // 草稿本身是磁盘上的文件夹，用户中途离开 / 重开应用后回来的入口是插件页列表最上面的「正在做」组（主进程 plugin:drafts 扫出来）
  const [pluginDrafts, setPluginDrafts] = useState<PluginDrafts>(new Map());
  // 用户在「正在做」组里点开的草稿（优先于 agent 预览的那一条）；点返回清掉
  const [openedDraft, setOpenedDraft] = useState<PluginDraftTarget | null>(null);
  const draftContext = useRef(mainSessionId);
  draftContext.current = mainSessionId;
  useEffect(
    () =>
      api.agent.onEvent((event) => {
        if (event.type !== "pluginDraft") return;
        setPluginDrafts((drafts) => putDraft(drafts, event.sessionId, event.path));
        if (shouldOpenDraft({ eventSessionId: event.sessionId, viewedSessionId: draftContext.current })) {
          setRightPanel("plugins");
        }
      }),
    [],
  );
  // 「在右栏打开这个插件」：右栏打开插件页，选中那个插件；`board` 为真直接进它的看板视图
  // （设置页全屏版详情里点「打开看板」），否则停在详情（装好之后）
  const [pluginOpenRequest, setPluginOpenRequest] = useState<PluginOpenRequest | null>(null);
  const openPlugin = useCallback(
    (name: string, board: boolean) => {
      setPluginOpenRequest((previous) => ({ name, nonce: (previous?.nonce ?? 0) + 1, board }));
      // 要看的是已装的这个插件：这条会话若正挂着草稿视图，先让位给它
      if (mainSessionId !== null) setPluginDrafts((drafts) => dropDraft(drafts, mainSessionId));
      setOpenedDraft(null);
      setRightPanel("plugins");
    },
    [mainSessionId],
  );
  const handlePluginOpenHandled = useCallback(() => setPluginOpenRequest(null), []);
  /**
   * agent 的 install_plugin 装上了插件、或用户点了对话里那一行的「安装」，而且是**正看着的这条会话**里装的：
   * 右栏打开插件页、选中它停在详情（要看看板再点「打开看板」）。别的会话里装的不抢右栏。
   */
  const openPluginRef = useRef(openPlugin);
  openPluginRef.current = openPlugin;
  const viewedForInstallRef = useRef(mainSessionId);
  viewedForInstallRef.current = mainSessionId;
  useEffect(
    () =>
      api.agent.onEvent((event) => {
        if (event.type !== "pluginsChanged" || event.installed === undefined) return;
        if (event.installed.sessionId !== viewedForInstallRef.current) return;
        openPluginRef.current(event.installed.name, false);
      }),
    [],
  );
  const leavePluginDraft = useCallback(() => {
    setOpenedDraft(null);
    if (mainSessionId !== null) setPluginDrafts((drafts) => dropDraft(drafts, mainSessionId));
  }, [mainSessionId]);
  /** 「正在做」组里点一行：右栏打开插件页，进该草稿的长页（设置里的全屏版点时先退出设置） */
  const openPluginDraft = useCallback((draft: PluginDraftTarget) => {
    setOverlay(null);
    setOpenedDraft(draft);
    setRightPanel("plugins");
  }, []);
  /**
   * 「正在做」组里的「回到对话」：退出设置、打开做这个插件的那条会话，右栏直接是这份草稿的「正在做」长页
   * （用户回去就是要接着做它）：草稿写进那条会话的 pluginDrafts，右栏一次性带上插件页（carry 只带这一次，
   * 之后切走切回照那条会话自己的面板记忆）。已经在看那条会话时没有「切到」，直接开右栏。
   */
  const openDraftSession = useCallback(
    (sessionId: string, draftPath: string) => {
      setOverlay(null);
      setOpenedDraft(null);
      setPluginDrafts((drafts) => putDraft(drafts, sessionId, draftPath));
      if (sessionId === mainSessionId) {
        setRightPanel("plugins");
        return;
      }
      carryPanelRef.current = { panel: "plugins", sessionId };
      void session.openSession(sessionId);
    },
    [session, mainSessionId],
  );
  const sessionDraft = draftOf(pluginDrafts, mainSessionId);
  const shownDraft: PluginDraftTarget | null =
    openedDraft ?? (sessionDraft === null ? null : { path: sessionDraft, workspaceId: session.workspaceId });
  const shownSettingsTab = settingsTab;
  // 记忆库住在设置的页签里：打开那个页签才算一次
  useEffect(() => {
    if (overlay === "settings" && shownSettingsTab === "memory") countPanel("memory");
  }, [overlay, shownSettingsTab, countPanel]);
  useEffect(() => {
    if (overlay === "board") countPanel("board");
    if (overlay === "settings") countPanel("settings");
  }, [overlay, countPanel]);
  useEffect(() => {
    if (showCarryovers) countPanel("carryovers");
  }, [showCarryovers, countPanel]);
  useEffect(() => {
    if (showArchived) countPanel("archived");
  }, [showArchived, countPanel]);
  // 自动化：数据钩子 App 持有一份，右栏面板与对话里的卡片共用
  const automations = useAutomations();
  const [automationFocus, setAutomationFocus] = useState<{ id: string; nonce: number } | null>(null);
  const openAutomationPanel = useCallback((automationId?: string): void => {
    setRightPanel("automation");
    if (automationId !== undefined) setAutomationFocus((current) => ({ id: automationId, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  // ── 右栏路径：恢复 / 写穿 / 落盘（right-panel-memory.ts；说明见上方 panelMemoryRef）──────────
  const sessionsRef = useRef(session.sessions);
  sessionsRef.current = session.sessions;
  /** 面板换了：上一个面板报的第二层作废（面板自己挂上后会报新的） */
  useEffect(() => {
    setRailPath((current) => (current.panel === rightPanel ? current : (parsePath({ panel: rightPanel }) ?? CLOSED_ENTRY)));
  }, [rightPanel]);
  /** 点开的草稿属于插件面板：面板换走就放下（同其余面板「换走回到根」） */
  useEffect(() => {
    if (rightPanel !== "plugins") setOpenedDraft(null);
  }, [rightPanel]);
  // 切主槽会话：恢复目标会话记着的路径（没记过 = 关着）。面板、页签、第二层、子会话面板的层、
  // 草稿在同一批里设好；epoch +1 让面板内容重挂。一次性信号（审查定位、记忆页签、「/ + 空格」选取态）
  // 都属于离开的那条会话，不带过去——否则重挂后会拿着旧会话的路径去定位
  useEffect(() => {
    const previous = panelMainIdRef.current;
    panelMainIdRef.current = mainOpenId;
    if (previous === mainOpenId) return;
    const target = mainOpenId === "" ? null : mainOpenId;
    let recalled: PanelEntry = recallEntry(panelMemoryRef.current, target);
    const carry = carryPanelRef.current;
    if (carry !== null && target !== null && (carry.sessionId === null ? !hasEntry(panelMemoryRef.current, target) : carry.sessionId === target)) {
      const bare = parsePath({ panel: carry.panel }) ?? CLOSED_ENTRY;
      recalled = recalled.taskTab === undefined ? bare : { ...bare, taskTab: recalled.taskTab };
      carryPanelRef.current = null;
    }
    // 从首页发第一句：开着的是文档 / 演示文稿面板就留着（panelFromHome）
    const keepFromHome = panelFromHome(panelMemoryRef.current, previous, target, rightPanel);
    if (keepFromHome !== null) {
      const bare = parsePath({ panel: keepFromHome }) ?? CLOSED_ENTRY;
      recalled = recalled.taskTab === undefined ? bare : { ...bare, taskTab: recalled.taskTab };
    }
    const nextTab = taskTabOf(recalled);
    // 恢复出来的面板不是用户打开的：面板打开次数不记它（见下方 countPanel 的效果）
    if (recalled.panel !== rightPanel || nextTab !== taskTab) panelRestoredRef.current = true;
    const children = new Set(target === null ? [] : childSessions(sessionsRef.current, target).map((meta) => meta.id));
    const nav = recalled.panel === "subsessions" ? resolveSubSessionsSub(recalled.sub, children) : undefined;
    setRightPanel(recalled.panel);
    setTaskTab(nextTab);
    setRailPath(parsePath(recalled) ?? CLOSED_ENTRY);
    setOpenedDraft(recalled.panel === "plugins" ? (recalled.sub?.draft ?? null) : null);
    setSubSessionsNav(nav === undefined ? SUB_SESSIONS_LIST : openSubSession(nav.sessionId));
    setReviewFocus(null);
    setMemoryFocus(null);
    setTokenPickerOn(false);
    tokenPickAnchorRef.current = null;
    setRailCtx((current) => ({ owner: target, epoch: current.epoch + 1 }));
  }, [mainOpenId, rightPanel, taskTab]);

  // 写穿：右栏路径一变就记进这条会话的记忆（不等切走那一拍——切会话时离开的会话已经是最新）
  const memoryLoadedRef = useRef(false);
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const flushMemory = useCallback((): void => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (!memoryLoadedRef.current) return; // 旧记忆还没读回来：现在写会把它覆盖掉
    void api.rightPanelMemory.save(toMemoryFile(panelMemoryRef.current)).catch(() => undefined);
  }, []);
  /** 防抖 1 秒落盘：连着点几下面板只写一次；失败就算了（便利功能，不值得打扰用户） */
  const scheduleMemorySave = useCallback((): void => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushMemory, 1000);
  }, [flushMemory]);
  const openedSubSessionId = subSessionsNav.kind === "session" ? subSessionsNav.sessionId : null;
  useEffect(() => {
    if (railCtx.owner === null) return;
    const entry = composeEntry({ rightPanel, path: railPath, openedDraft, subSessionId: openedSubSessionId, taskTab });
    const next = rememberEntry(panelMemoryRef.current, railCtx.owner, entry);
    if (next === panelMemoryRef.current) return;
    panelMemoryRef.current = next;
    scheduleMemorySave();
  }, [railCtx.owner, rightPanel, railPath, openedDraft, openedSubSessionId, taskTab, scheduleMemorySave]);
  // 启动读一次上次的记忆；读回来之前本次运行已记下的（极少）压在上面
  useEffect(() => {
    let cancelled = false;
    void api.rightPanelMemory
      .load()
      .catch(() => null)
      .then((file) => {
        if (cancelled) return;
        const hadCurrent = panelMemoryRef.current.size > 0;
        panelMemoryRef.current = mergeLoaded(parseMemoryFile(file), panelMemoryRef.current);
        memoryLoadedRef.current = true;
        setMemoryLoaded(true);
        if (hadCurrent) scheduleMemorySave();
      });
    const onUnload = (): void => flushMemory();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [flushMemory, scheduleMemorySave]);
  // 会话被删：顺手清掉它的条目。列表为空（还没读回 / 读失败）时不清——否则一次失败会抹掉全部记忆
  useEffect(() => {
    if (!memoryLoaded || !session.sessionsLoaded || session.sessions.length === 0) return;
    const alive = new Set(session.sessions.map((meta) => meta.id));
    if (mainOpenId !== "") alive.add(mainOpenId);
    const next = forgetMissing(panelMemoryRef.current, alive);
    if (next === panelMemoryRef.current) return;
    panelMemoryRef.current = next;
    scheduleMemorySave();
  }, [memoryLoaded, session.sessions, session.sessionsLoaded, mainOpenId, scheduleMemorySave]);
  /** 面板报上来的第二层：只收当前面板的（面板收起动画里的残余报告不算） */
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  const reportRailPath = useCallback((path: PanelPath): void => {
    if (path.panel !== rightPanelRef.current) return;
    setRailPath((current) => (JSON.stringify(current) === JSON.stringify(path) ? current : path));
  }, []);
  /**
   * 新手引导：全屏盖住整个窗口。只在**第一次打开**（设置读回后 onboardingSeen 不是 true）自动弹一次；
   * 看完、跳过、Esc 都写 onboardingSeen = true，之后只能从设置 › 新手引导页签打开（不改这个键）。
   */
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  /** 打开引导时从摊平后的第几页开始：自动弹出 / 「从头看」是 0，设置 › 新手引导里点某章是那章的章首页 */
  const [onboardingStart, setOnboardingStart] = useState(0);
  const onboardingAutoRef = useRef(false);
  useEffect(() => {
    if (onboardingAutoRef.current || !shouldAutoOpenOnboarding(settingsLoaded, settings)) return;
    onboardingAutoRef.current = true;
    setOnboardingOpen(true);
  }, [settingsLoaded, settings]);
  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    if (settings.onboardingSeen !== true) changeSettings({ onboardingSeen: true });
  }, [settings.onboardingSeen, changeSettings]);
  /**
   * 「试试」：关掉引导与设置页。text 不是 null 就把那句话放进当前看着的会话（首页就是新任务）的输入框；
   * open 给了（文档与演示章的动作提示页）就把右栏的演示文稿面板摆好：`slides` 回到上次那份，
   * `slides-new` 新建一份空的并打开——读者还没有演示文稿时，提示里的动作也有地方做。
   */
  const tryFromOnboarding = useCallback(
    (text: string | null, open?: "slides" | "slides-new") => {
      closeOnboarding();
      setOverlay(null);
      if (text !== null) session.setDraft(text);
      if (open === "slides") setRightPanel("slides");
      if (open === "slides-new") {
        void api.docs
          .create({ sessionId: session.sessionId ?? session.opened?.id ?? null, workspaceId: session.workspaceId, kind: "slides" })
          .then((created) => requestOpenPanel({ kind: "slides", path: created.path, force: true }))
          // 建不出来（目录不可写等）：面板照开，里面的「新建」会给出真正的原因
          .catch(() => setRightPanel("slides"));
      }
    },
    [closeOnboarding, session],
  );
  const automationUi = useMemo<AutomationUi>(
    () => ({ automations: automations.automations, loaded: automations.load.kind === "ready", openPanel: openAutomationPanel, act: automations.act }),
    [automations.automations, automations.load.kind, automations.act, openAutomationPanel],
  );
  // 运行会话 id 集：按**内容**稳定——会话列表每跑完一轮都会换新数组，集合没变就别让订阅它的每条用户消息重渲染
  const runSessionKey = session.sessions
    .filter((meta) => meta.automationId !== undefined && meta.promoted !== true)
    .map((meta) => meta.id)
    .sort()
    .join("\n");
  const runSessionIds = useMemo<ReadonlySet<string>>(
    () => new Set(runSessionKey === "" ? [] : runSessionKey.split("\n")),
    [runSessionKey],
  );
  const subviewState: RailSubviewState = { overlay, showArchived, showCarryovers };
  const applySubviewState = (next: RailSubviewState): void => {
    setOverlay(next.overlay);
    setShowArchived(next.showArchived);
    setShowCarryovers(next.showCarryovers);
  };
  /**
   * 工具栏居中那颗胶囊的内容：设置页 = 标题（只有标题）；会话页 = SessionCapsule；
   * 首页 = 不渲染。
   */
  const sessionSlot =
    overlay === "settings" || overlay === "board" ? (
      <div className="cap-sess">
        <div className="cap-sc">
          <strong className="cap-title">
            {overlay === "board" ? t.board.title : t.settings.tabs[settingsTab]}
          </strong>
        </div>
      </div>
    ) : mainOpenId === "" && session.opened === null ? null : (
      <SessionCapsule
        title={capsuleTitle}
        shortId={capsuleShortId}
        onRename={mainOpenId === "" ? undefined : (title) => session.renameSession(mainOpenId, title)}
        completion={
          mainOpenId !== ""
            ? {
                state: mainOpenMeta?.completion ?? "open",
                closing: session.closingScan,
                busy: session.phase !== "idle",
                scanless: mainOpenMeta?.piSessionFile == null,
                onMark: session.startClosingRitual,
                onSet: (next) => session.setCompletionSession(mainOpenId, next),
              }
            : null
        }
        subChip={hasSubSessions ? { count: subSessionChildren.length, waiting: waitingOnYou } : null}
        onOpenSubSessions={openSubSessionsList}
        crumb={
          capsuleParentId !== undefined
            ? {
                title: session.sessions.find((meta) => meta.id === capsuleParentId)?.title ?? "",
                onClick: () => void session.openSession(capsuleParentId),
              }
            : null
        }
      />
    );

  const railEntries: RailEntry[] = [
    // 遗留事项入口（收尾扫描的下游）
    {
      id: "carryovers",
      icon: FEATURE_ICON.carryovers,
      label: t.app.carryoversEntry(openCarryoverCount),
      lit: railSubviewLit(subviewState, "carryovers"),
      onClick: () => applySubviewState(toggleRailSubview(subviewState, "carryovers")),
    },
    {
      id: "archived",
      icon: FEATURE_ICON.archived,
      label: t.app.archivedEntry(archivedCount),
      lit: railSubviewLit(subviewState, "archived"),
      onClick: () => applySubviewState(toggleRailSubview(subviewState, "archived")),
    },
    {
      // 受管浏览器是独立的沙盒窗口（不占右栏面板位）：点了就打开或聚焦它，没有「亮」的状态。
      // 它是 agent 的工具，这个入口给用户提前登录、看一眼 agent 停在哪
      id: "browser",
      icon: FEATURE_ICON.browser,
      label: t.rail.browser,
      lit: false,
      onClick: () => {
        countPanel("browser");
        api.browser.open().catch((cause: unknown) => console.error("[browser] 打开沙盒窗口失败", cause));
      },
    },
    {
      // 全局周看板：占满主区域（同设置、记忆库），再点一下或 Esc 退出
      id: "board" as const,
      icon: FEATURE_ICON.board,
      label: t.rail.board,
      lit: overlay === "board",
      onClick: () => setOverlay(overlay === "board" ? null : "board"),
    },
    {
      id: "settings",
      icon: FEATURE_ICON.settings,
      label: t.common.settings,
      lit: overlay === "settings",
      onClick: () => setOverlay(overlay === "settings" ? null : "settings"),
    },
  ];

  return (
    <LocaleContext.Provider value={locale}>
    <DocPaperContext.Provider value={docPaper}>
    <ExperimentalFeaturesContext.Provider value={experimentalFeatures}>
    <ProcessViewContext.Provider value={settings.processView ?? "turn"}>
    <AutomationContext.Provider value={automationUi}>
    <AutomationRunSessionsContext.Provider value={runSessionIds}>
    <PastedTextCollapseContext.Provider value={settings.collapsePastedText ?? true}>
    <CitationOpenContext.Provider value={openCitation}>
    <ToolbarPanelSlotContext.Provider value={panelSlot}>
    <div className="app-shell">
      <div className="layer">
        <Toolbar
          platform={api.platform === "darwin" ? "darwin" : "other"}
          sidebarCollapsed={sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onNewTask={startNewTaskFromTools}
          windowWidth={windowWidth}
          panelOpen={rightPanel !== null}
          panelWidth={panelRenderedWidth}
          narrow={docPanelOpen ? panelOverlay : narrow || panelOverlay}
          paper={paperMode}
          sessionSlot={sessionSlot}
          onPanelSlot={setPanelSlot}
          onToggleDrawer={() => setRightPanel(rightPanel === null ? "drawer" : null)}
          focus={focus.control}
        />
        <Sidebar
          session={session}
          overlay={overlay}
          settingsTab={settingsTab}
          onSettingsTab={setSettingsTab}
          onOverlay={setOverlay}
          showArchived={showArchived}
          showCarryovers={showCarryovers}
          onShowArchived={setShowArchived}
          onShowCarryovers={setShowCarryovers}
          width={sidebarWidth}
          unread={new Set(unreadSessions.map((meta) => meta.id))}
          onWidthChange={setSidebarWidth}
          onWidthCommit={(width) => {
            setSidebarWidth(width);
            changeSettings({ sidebarWidth: width });
          }}
          ageDays={settings.sidebarAgeDays ?? null}
          onAgeDaysChange={(sidebarAgeDays) => changeSettings({ sidebarAgeDays })}
          usagePet={settings.usagePet}
          onUsagePetChange={(usagePet) => changeSettings({ usagePet })}
          usageSay={focus.say}
          usageCard={focus.card}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          newTaskSignal={newTaskSignal}
          onStartCarryoverTask={startCarryoverTask}
          filesView={focus.filesView}
          onBrowseWorkspace={focus.browseWorkspace}
          onExitBrowse={focus.exitBrowse}
          onStartFocusHere={focus.startAt}
          onOpenFile={focus.openFile}
        />

        <main
          className="pane"
          data-layout={paperMode ? "paper" : "chat"}
          // 布局 B：对话栏宽由 paper-layout.ts 的常量注入（CSS 只读变量，不再写一遍 340）
          style={
            paperMode
              ? ({ "--paper-chat-w": `${PAPER_CHAT_WIDTH}px` } as React.CSSProperties)
              : undefined
          }
        >
          <div className="pane-main">
            {/* 主槽内的弹出宿主（完成提醒卡 / 铃铛清单）：卡片属于内容面这一层，
                与主槽边框隔一条血线；右栏面板开着时停在主槽这一侧 */}
            <div className="pane-pop-host" ref={setPopHost} />
            {overlay === "board" ? (
              <BoardWeekView
                days={settings.boardDays ?? BOARD_DAYS_DEFAULT}
                onDaysChange={(boardDays) => changeSettings({ boardDays })}
                onOpenSession={(id) => {
                  setOverlay(null);
                  void session.openSession(id);
                }}
              />
            ) : overlay === "settings" ? (
              <SettingsView
                tab={settingsTab}
                settings={settings}
                providers={providers}
                starredModels={settings.starredModels ?? []}
                onToggleStarModel={toggleStarModel}
                onSettingsChange={changeSettings}
                onProvidersChange={refresh}
                onImported={() => {
                  engine.refreshSessions();
                  engine.refreshWorkspaces();
                }}
                workspaces={session.workspaces}
                plugins={{
                  currentWorkspaceId: session.workspaceId,
                  onMakeWithAgent: makePluginWithAgent,
                  // 从设置页签点「打开看板」：退出设置，回到对话，右栏开这个插件的看板视图
                  onOpenBoard: (name) => {
                    setOverlay(null);
                    openPlugin(name, true);
                  },
                  onOpenDraft: openPluginDraft,
                  onOpenSession: openDraftSession,
                }}
                onTab={setSettingsTab}
                onOpenOnboarding={(startAt) => {
                  setOnboardingStart(startAt);
                  setOnboardingOpen(true);
                }}
                onJumpToMemorySource={jumpToMemorySource}
                onCollapseRail={rightPanel === null ? null : () => setRightPanel(null)}
              />
            ) : (
              <ChatView
                session={session}
                providersError={providersError}
                bareHeader
                onOpenReviewAt={openReviewAt}
                excerptJump={excerptJump}
                onExcerptSaved={bumpExcerpts}
                onOpenSubSession={openSubSessionInPanel}
                litSubSessionId={litSubSessionId}
                theme={resolvedTheme}
                starredModels={settings.starredModels ?? []}
                onToggleStarModel={toggleStarModel}
                onOpenProviders={openProvidersTab}
                scrollToEnd
                scrollToEndHotkey
                onSlashSpace={openTokenPicker}
                tokenPickResult={tokenPickResult}
                intentNewSessionDefault={effectiveIntentSettings(settings.intent).newSessionOn}
                onOpenIntentPanel={openIntentPanel}
                onOpenMemoryReview={openMemoryReview}
                onOpenContextPanel={openContextPanel}
                onOpenSideChat={openInSideChat}
                intentOpenableIds={intentOpenableIds}
              />
            )}
          </div>
          {/* 右侧面板壳：三菜单共用的常驻分栏。展开/收起/切换只有一条动画路径 */}
          <RightPanelSlot
            open={rightPanel !== null}
            width={isDocPanel ? docPanelWidth : panelWidth}
            {...(isDocPanel ? { resolveLayout: docPanelLayout } : {})}
            narrow={narrow}
            fill={paperMode}
            onOverlay={setPanelOverlay}
            onTight={setPanelTight}
            onWidthChange={isDocPanel ? setDocPanelWidth : setPanelWidth}
            onWidthCommit={(width) =>
              changeSettings(isDocPanel ? { docPanelWidth: width } : { rightPanelWidth: width })
            }
            onRenderedWidth={setPanelRenderedWidth}
          >
            {/* 收起动画期间保持原内容；切换时 key 变化触发 120ms 内容淡入 */}
            <div
              key={shownPanel ?? "closed"}
              style={{
                height: "100%",
                animation: "right-panel-fade 120ms var(--ease-out-quint)",
              }}
            >
              {/* 带第二层的面板：key 带上「属于哪条会话 + 第几次恢复」，切会话必定重挂，状态只从记忆里来
                  （不会把上一条会话停的那一层原样带过去）；淡入动画仍只跟面板种类走。
                  文件 / 终端 / 辅助对话不重挂（它们的状态本就全局共用或另有清理） */}
              <Fragment key={hasSubLayer(shownPanel) ? `${railCtx.owner ?? ""}#${railCtx.epoch}` : "-"}>
              {shownPanel === "files" ? (
                <FilesPanel
                session={session}
                escapeRef={filesEscapeRef}
                citeFocus={citeFocus}
                focusWorkspaceId={focusFilesView?.workspaceId ?? null}
                focusDone={focus.status.kind === "done"}
                fileOpen={fileOpenRequest}
                onRunInTerminal={runInTerminal}
                onPackageInstalled={() => setLatexInstallNotice(true)}
                onCompileRun={() => setLatexInstallNotice(false)}
                installNotice={latexInstallNotice}
                paperLayout={paperMode}
                autoSplit={autoSplit}
                onTogglePaperLayout={togglePaperLayout}
                onPaperReady={setPaperReady}
                onDocShown={setFilesShowsDoc}
              />
              ) : shownPanel === "slides" ? (
                <DocsPanel
                  sessionId={session.sessionId ?? session.opened?.id ?? null}
                  workspaceId={session.workspaceId}
                  onQuote={session.addQuote}
                  openRequest={docOpenRequest}
                />
              ) : shownPanel === "review" ? (
                <ReviewPanel
                  sessionId={session.sessionId ?? session.opened?.id ?? null}
                  workspaceId={session.workspaceId}
                  focus={reviewFocus}
                  revision={`${session.fileTurns.length}:${session.reverts.length}:${session.undos.length}:${session.phase}`}
                  cwd={session.cwd}
                  excerptRevision={excerptRevision}
                  onJumpExcerpt={openExcerpt}
                  onOpenInFiles={focus.openFile}
                  memoryFocus={memoryFocus}
                  {...(railPath.panel === "review" && railPath.sub !== undefined ? { sub: railPath.sub } : {})}
                  onSubChange={(sub) => reportRailPath({ panel: "review", ...(sub === undefined ? {} : { sub }) })}
                />
              ) : shownPanel === "automation" ? (
                <AutomationPanel
                  state={automations}
                  workspaceId={session.workspaceId}
                  workspaces={session.workspaces}
                  sessionId={mainSessionId}
                  sessions={session.sessions}
                  providers={providers}
                  keepAwake={settings.automationKeepAwake === true}
                  onKeepAwakeChange={(next) => changeSettings({ automationKeepAwake: next })}
                  focus={automationFocus}
                  onFocusConsumed={() => setAutomationFocus(null)}
                  onOpenSession={(id) => {
                    setOverlay(null);
                    void session.openSession(id);
                  }}
                  onAskInChat={() => session.setDraft(t.automation.addByChatDraft)}
                  {...(railPath.panel === "automation" && railPath.sub !== undefined ? { sub: railPath.sub } : {})}
                  onSubChange={(sub) => reportRailPath({ panel: "automation", ...(sub === undefined ? {} : { sub }) })}
                />
              ) : shownPanel === "terminal" ? (
                <TerminalPanel
                  cwd={session.cwd}
                  activateId={pendingTerminal}
                  onActivated={() => setPendingTerminal(null)}
                  pendingInput={pendingTerminalInput}
                  onInputDone={() => setPendingTerminalInput(null)}
                />
              ) : shownPanel === "drawer" ? (
                <Drawer
                  engine={engine}
                  view={drawerView}
                  mainSessionId={mainSessionId}
                  providersError={providersError}
                  starredModels={settings.starredModels ?? []}
                  onToggleStarModel={toggleStarModel}
                  onOpenProviders={openProvidersTab}
                  docked={docked}
                  focus={drawerFocus}
                  onFocusConsumed={() => setDrawerFocus(null)}
                  onDockedChange={(list) =>
                    changeDocked(
                      // 没发过首条消息的新任务占位不是 task，不落盘——重启后从选择卡重新开
                      list.filter((tab) => tab !== NEW_TASK_TAB),
                    )
                  }
                />
              ) : shownPanel === "context" ? (
                <ContextPanel
                  sessionId={mainSessionId}
                  entry={(mainSessionId === null ? undefined : engine.states.get(mainSessionId)) ?? EMPTY_ENTRY}
                  cwd={session.cwd ?? ""}
                  tab={taskTab}
                  onTab={setTaskTab}
                  {...(railPath.panel === "context" && railPath.sub !== undefined ? { sub: railPath.sub } : {})}
                  onSubChange={(sub) => reportRailPath({ panel: "context", ...(sub === undefined ? {} : { sub }) })}
                  runState={mainMeta === undefined ? null : runStateOf(session, mainMeta)}
                  carryovers={session.carryovers.filter((item) => item.sourceSessionId === mainSessionId && item.status !== "done")}
                  onSetCarryoverStatus={session.setCarryoverStatus}
                  onStartCarryoverTask={startCarryoverTask}
                  onDoCarryoverNow={session.continueCarryoverInSource}
                  onStartGoalTask={startGoalTask}
                />
              ) : shownPanel === "plugins" ? (
                <PluginsView
                  workspaces={session.workspaces}
                  chrome="rail"
                  currentWorkspaceId={session.workspaceId}
                  onMakeWithAgent={makePluginWithAgent}
                  onOpenBoard={(name) => openPlugin(name, true)}
                  openRequest={pluginOpenRequest}
                  onOpenRequestHandled={handlePluginOpenHandled}
                  draft={shownDraft}
                  onLeaveDraft={leavePluginDraft}
                  onOpenDraft={openPluginDraft}
                  onOpenSession={openDraftSession}
                  picker={tokenPickerOn ? tokenPicker : undefined}
                  {...(railPath.panel === "plugins" && railPath.sub !== undefined ? { sub: railPath.sub } : {})}
                  onSubChange={(sub) => reportRailPath({ panel: "plugins", ...(sub === undefined ? {} : { sub }) })}
                />
              ) : shownPanel === "intent" ? (
                <IntentPanel
                  sessionId={session.sessionId ?? session.opened?.id ?? null}
                  turns={session.intentRecalls}
                  liveRun={session.intentRun}
                  pendingAsk={
                    session.intentAsk === null
                      ? null
                      : { requestId: session.intentAsk.requestId, ask: session.intentAsk.ask }
                  }
                  liveTurnIds={intentLiveTurnIds}
                  openableSessionIds={intentOpenableIds}
                  onOpenSession={openInSideChat}
                  {...(railPath.panel === "intent" && railPath.sub !== undefined ? { sub: railPath.sub } : {})}
                  onSubChange={(sub) => reportRailPath({ panel: "intent", ...(sub === undefined ? {} : { sub }) })}
                />
              ) : shownPanel === "subsessions" && channelParentId !== null ? (
                <SubSessionsPanel
                  parentId={channelParentId}
                  parentTitle={channelParentTitle}
                  session={session}
                  engine={engine}
                  view={subSessionsView}
                  nav={subSessionsNav}
                  onOpenChild={openSubSessionInPanel}
                  onBackToList={() => setSubSessionsNav(SUB_SESSIONS_LIST)}
                  onOpenAsMain={openAsMain}
                    providersError={providersError}
                  starredModels={settings.starredModels ?? []}
                  onToggleStarModel={toggleStarModel}
                />
              ) : null}
              </Fragment>
            </div>
          </RightPanelSlot>
        </main>

        <RightRail
          panel={rightPanel}
          onPanel={handlePanel}
          railEntries={railEntries}
          intentAvailable={settings.experimentalFeatures?.["intent-system"] === true}
          automation={{ running: runningCount(automations.automations) }}
          subSessions={
            channelParentId !== null && hasSubSessions
              ? { count: subSessionChildren.length, waiting: waitingOnYou }
              : null
          }
          completionNotice={completionNotice}
          popHost={popHost}
          bell={{
            count: unreadSessions.length,
            entries: noticeRows,
            onOpen: openFromNotice,
            onSideChat: openInSideChat,
            onMarkAllRead: () => clearUnreadOf(unreadSessions.map((meta) => meta.id)),
            onOpened: () => countPanel("bell"),
          }}
        />
      </div>
      {onboardingOpen && <OnboardingView theme={resolvedTheme} startAt={onboardingStart} onClose={closeOnboarding} onTry={tryFromOnboarding} />}
    </div>
    </ToolbarPanelSlotContext.Provider>
    </CitationOpenContext.Provider>
    </PastedTextCollapseContext.Provider>
    </AutomationRunSessionsContext.Provider>
    </AutomationContext.Provider>
    </ProcessViewContext.Provider>
    </ExperimentalFeaturesContext.Provider>
    </DocPaperContext.Provider>
    </LocaleContext.Provider>
  );
}

/** 右栏面板种类 → 面板打开次数的键。「这条任务」（context）按页签分成 task / context，不在表里 */
const PANEL_USAGE_KEY_OF: Partial<Record<RightPanelKind, PanelUsageKey>> = {
  files: "files",
  review: "review",
  terminal: "terminal",
  drawer: "sidechat",
  subsessions: "subsessions",
  intent: "intent",
  automation: "automation",
  plugins: "plugins",
};

/**
 * 平台写到 `<html data-platform>` 上。CSS 需要它：macOS 的窗口是透明的
 * （body 不许上底色），红黄绿三个键要在侧栏顶栏里留净空。
 */
function usePlatform(): void {
  useEffect(() => {
    document.documentElement.dataset["platform"] = api.platform;
  }, []);
}
