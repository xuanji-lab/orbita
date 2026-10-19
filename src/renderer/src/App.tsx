import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "./useTheme";
import { LocaleContext, messagesOf } from "./locale.ts";
import { ExperimentalFeaturesContext } from "./experimental.ts";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, effectiveLanguage, type AppSettings, type ModelPair, type SettingsPatch } from "@shared/settings";
import { childSessions, rootSessions } from "@shared/session";
import { useChatSession, useSessionView } from "./features/chat/useChatSession";
import { effectiveIntentSettings } from "@shared/settings";
import { IntentPanel } from "./features/intent/IntentPanel.tsx";
import { ChatView } from "./features/chat/ChatView";
import { useChannelSummaries } from "./features/chat/useChannelSummaries";
import { subSessionStatusOf } from "./features/chat/sub-sessions-rows";
import { SubSessionsPanel } from "./features/chat/SubSessionsPanel";
import {
  SUB_SESSIONS_LIST,
  escapeFrom,
  openSubSession,
  syncToMainSession,
  type SubSessionsView,
} from "./features/chat/sub-sessions-state";
import { SettingsView, type SettingsTab } from "./features/settings/SettingsView";
import { useSkills } from "./features/skills/useSkills";
import { Sidebar, type Overlay } from "./shell/Sidebar";
import { COLLAPSE_BREAKPOINT } from "./shell/window-tools.ts";
import { Toolbar, ToolbarPanelSlotContext } from "./shell/Toolbar";
import { SessionCapsule } from "./shell/SessionCapsule";
import { FocusControl } from "./shell/focus/FocusControl.tsx";
import { FocusSummaryCard } from "./shell/focus/FocusSummaryCard.tsx";
import { useFocus } from "./shell/focus/use-focus.ts";
import { Icon } from "./shell/Icon";
import { RightRail, type RailEntry, type RightPanelKind } from "./shell/RightRail";
import { RightPanelSlot } from "./shell/RightPanel";
import { railSubviewLit, toggleRailSubview, type RailSubviewState } from "./shell/rail-subview.ts";
import { type PanelInsertRequest, type TokenPickerControl, type TokenPickResult } from "./shell/panel-token.ts";
import { PastedTextCollapseContext } from "./shell/attachment-chips";
import { MaterialBoxContext } from "./shell/BlackholeBox.tsx";
import { materialBoxStyle } from "./shell/blackhole-layout.ts";
import { isDrawerToggleShortcut } from "./shell/drawer-shortcut.ts";
import { SkillsPanel } from "./features/skills/SkillsPanel";
import { McpPanel } from "./features/mcp/McpPanel";
import type { PdfJump } from "./features/files/PdfView";
import { CitationOpenContext } from "./features/chat/citation-context.ts";
import type { PdfCitation } from "@shared/pdf-quote";
import { FilesPanel } from "./features/files/FilesPanel";
import { TerminalPanel } from "./features/terminal/TerminalPanel";
import { ReviewPanel } from "./features/review/ReviewPanel";
import type { ExcerptJump } from "./features/review/ExcerptsTab";
import type { ExcerptJumpRequest } from "./features/chat/ChatView";
import { RIGHT_PANEL_WIDTH_DEFAULT, SIDEBAR_WIDTH_DEFAULT } from "@shared/settings";
import { Drawer, type DockedTab } from "./shell/Drawer";
import { NEW_TASK_TAB, dockTab } from "./shell/drawer-state";
import { isWindowInactive } from "./shell/window-activity.ts";
import {
  noticeTierOf,
  orderNoticeEntries,
  planNotice,
  sessionRunState,
  settledSessions,
  type NoticeTier,
} from "./features/notify/completion-notice.ts";
import { playCompletionChime } from "./features/notify/chime.ts";

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

  useEffect(() => {
    void refresh();
    // 读不到设置就用默认——主题是可以随时再选的，不值得为此让外壳起不来
    void api.settings.get().then(setSettings).catch(() => setSettings(DEFAULT_SETTINGS));
  }, [refresh]);

  /** 先落盘再回填：写失败时 UI 不该显示一个其实没存下来的选择 */
  const changeSettings = useCallback((patch: SettingsPatch) => {
    void api.settings.set(patch).then(setSettings);
  }, []);

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
  useEffect(() => {
    if (settings.rightPanelWidth !== undefined) setPanelWidth(settings.rightPanelWidth);
  }, [settings.rightPanelWidth]);

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COLLAPSE_BREAKPOINT - 1}px)`);
    const sync = () => setSidebarCollapsed(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const { session, engine } = useChatSession(providers, t);

  // ── 专注模式（原型：focus-proto）──────────────────────────────
  // 计时住在内存里（用户裁决：关掉重开 = 已结束），App 持有：工具栏左胶囊的
  // FocusControl、左栏的文件视图与星云的气泡 / 卡片共用同一份状态。
  const focus = useFocus();
  /** 浏览态（不计时看一眼工作区文件）；专注开始时退出 */
  const [wsBrowse, setWsBrowse] = useState<string | null>(null);
  /** 外部发起的开浮层请求（浏览态的「以此开始专注」/卡片的「再专注一轮」）：token 递增，同源连点也重开 */
  const focusPickerNonceRef = useRef(0);
  const [focusPickerRequest, setFocusPickerRequest] = useState<{
    workspaceId: string;
    minutes?: number;
    token: number;
  } | null>(null);
  const openFocusPickerAt = useCallback((workspaceId: string, minutes?: number): void => {
    focusPickerNonceRef.current += 1;
    setFocusPickerRequest({ workspaceId, ...(minutes === undefined ? {} : { minutes }), token: focusPickerNonceRef.current });
  }, []);
  /** 星云卡片的一次关闭（「关闭（保持专注视图）」）：只藏卡不结束专注；每轮新开时重置 */
  const [summaryCardClosed, setSummaryCardClosed] = useState(false);
  const startFocus = useCallback(
    (workspaceId: string, minutes: number): void => {
      setWsBrowse(null);
      setSummaryCardClosed(false);
      focus.start(workspaceId, minutes);
    },
    [focus],
  );
  /** 左栏此刻的文件视图：专注中 = 所选工作区；否则看浏览态；都没有 = 会话列表 */
  const focusFilesView =
    focus.status.kind === "off"
      ? wsBrowse === null
        ? null
        : { mode: "browse" as const, workspaceId: wsBrowse }
      : { mode: "focus" as const, workspaceId: focus.status.run.workspaceId };
  /** 到点那一拍要响的事：提示音（设置可关）、窗口不在前台时发系统通知、收起的
   * 侧栏展开（星云要在左下角说话——原型待定 10 的默认做法）。依赖只盯 kind：
   * done 只发生一次，延长不会重响。 */
  const focusRun = focus.status.kind === "off" ? null : focus.status.run;
  useEffect(() => {
    if (focus.status.kind !== "done" || focusRun === null) return;
    if (settings.completionSound ?? true) playCompletionChime();
    if (
      isWindowInactive({
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
      })
    ) {
      const wsName =
        session.workspaces.find((item) => item.id === focusRun.workspaceId)?.name ?? t.focus.deletedWorkspace;
      void api.focus.notifyDone({
        title: t.focus.notifyTitle,
        body: t.focus.notifyBody(Math.round(focusRun.totalMs / 60_000), wsName),
      });
    }
    setSidebarCollapsed(false);
    // settle 那拍读到的闭包值就是真值（settings / session / t 都在本渲染里）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.status.kind]);
  const focusControl = (
    <FocusControl
      status={focus.status}
      now={focus.now}
      workspaces={session.workspaces}
      defaultWorkspaceId={session.workspaceId}
      preset={focus.lastPreset}
      pickerRequest={focusPickerRequest}
      sessionCountOf={(id) =>
        rootSessions(session.sessions).filter((meta) => meta.workspaceId === id && !meta.archived).length
      }
      onStart={startFocus}
      onExtend={focus.extend}
      onEarlyEnd={focus.earlyEnd}
      onEnd={focus.end}
    />
  );

  // ── 星云要说的两句话与那张卡（原型状态 8 / 9；提前结束的问询也是气泡） ──
  const focusWorkspaceName =
    (focusRun !== null
      ? session.workspaces.find((item) => item.id === focusRun.workspaceId)?.name
      : undefined) ?? t.focus.deletedWorkspace;
  /** 正在整理（剩 5 分钟自动起跑 / 提前结束点「要」之后）：克制的提示，不弹窗不改胶囊 */
  const focusSay =
    focus.status.kind === "run" && focus.summary.state === "running" ? (
      <div className="usage-say usage-say-focus" role="status" data-edge="end">
        <span className="orbita-breath">{t.focus.summarizing}</span>
      </div>
    ) : focus.status.kind === "ending" && focus.summary.state === "idle" ? (
      <div className="usage-say usage-say-ask" role="status" data-edge="end">
        <span>{t.focus.askSummary}</span>
        <button type="button" className="usage-say-act" onClick={focus.requestSummary}>
          {t.focus.askYes}
        </button>
        <button type="button" className="usage-say-act" onClick={focus.end}>
          {t.focus.askNo}
        </button>
      </div>
    ) : focus.status.kind === "ending" && focus.summary.state === "running" ? (
      <div className="usage-say usage-say-focus" role="status" data-edge="end">
        <Icon name="loader-circle" size={12} spin />
        <span>{t.focus.summarizing}</span>
      </div>
    ) : null;
  /** 卡片：时间到（总结还没跑完就先出卡转圈）；提前结束点「要」且落定后也出卡 */
  const focusCardVisible =
    (focus.status.kind === "done" ||
      (focus.status.kind === "ending" &&
        (focus.summary.state === "ready" ||
          focus.summary.state === "failed" ||
          focus.summary.state === "none"))) &&
    !summaryCardClosed;
  const focusCard =
    focusCardVisible && focusRun !== null ? (
      <FocusSummaryCard
        ending={focus.status.kind === "ending"}
        minutes={
          focus.status.kind === "done"
            ? Math.round(focusRun.totalMs / 60_000)
            : Math.max(1, Math.round((Date.now() - focusRun.startedAt) / 60_000))
        }
        workspaceName={focusWorkspaceName}
        summary={focus.summary}
        onEnd={focus.end}
        onAgain={() => {
          const preset = focus.lastPreset ?? { workspaceId: focusRun.workspaceId, minutes: 25 };
          focus.end();
          openFocusPickerAt(preset.workspaceId, preset.minutes);
        }}
        onClose={() => setSummaryCardClosed(true)}
      />
    ) : null;

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
  /** 窗口宽（胶囊几何要用：会话胶囊居中于对话列、右栏胶囊钉分隔线） */
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const sync = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
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
  const channelParentId =
    overlay === "settings" || mainOpenId === "" || mainOpenMeta?.parentId !== undefined ? null : mainOpenId;
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
   * PDF 引用的一次性跳转请求（实验功能「PDF 引用」：正文里的引用编号被点）：同
   * reviewFocus 的 token 机制——同一条引用连点两次也会重新定位。开文件面板，由它找
   * PDF 所在的根、打开预览、滚到原文并高亮。
   */
  const [citeFocus, setCiteFocus] = useState<PdfJump | null>(null);
  const citeFocusTokenRef = useRef(0);
  const openCitation = useCallback((citation: PdfCitation) => {
    citeFocusTokenRef.current += 1;
    setCiteFocus({ citation, token: citeFocusTokenRef.current });
    setRightPanel("files");
  }, []);
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

  // 主槽不再是「有子会话的根会话」→ 入口消失，面板若开着就关（不止是不显示入口，
  // 面板本身也不该继续挂着一条够不到数据的内容）
  useEffect(() => {
    if (rightPanel === "subsessions" && !hasSubSessions) setRightPanel(null);
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
  /** Open as main：主槽换看这条子会话，面板关闭（2.1 裁决） */
  const openAsMain = useCallback(
    (childId: string) => {
      void session.openSession(childId);
      setRightPanel(null);
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
   * agent 开了可见终端（terminal:agent-open）→ **自动点亮终端面板位并激活那个 tab**。
   * agent 的活要让人看见（Proma 的 terminal:agent-open 同款裁决）：否则它在你背后的
   * 面板里跑 dev server，你想接手都不知道去哪接。信号是一次性的，TerminalPanel
   * 消费完就清。
   */
  const [pendingTerminal, setPendingTerminal] = useState<string | null>(null);
  useEffect(
    () =>
      api.terminal.onEvent((event) => {
        if (event.type !== "agent-open") return;
        setRightPanel("terminal");
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
   *   **重启后还在**），侧栏那一行亮 3/3 竖条，辅助对话图标旁弹卡片问怎么看：
   *   马上看（主槽换成它）/ 辅助对话里看 / 稍后（保持未读）。
   * 点进去看过（主槽或辅助对话正显示它）即清未读（同样落盘）。判定在
   * completion-notice.ts；侧栏竖条与右下角铃铛清单都从 sessionRunState 读同一份
   * 状态。只认根会话——子会话跑完由母会话的通道回报，不单独打扰人。
   */
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [drawerFocus, setDrawerFocus] = useState<{ tab: string; token: number } | null>(null);
  const drawerFocusTokenRef = useRef(0);
  /** 此刻「在看」的会话：主槽（没被设置页盖住时）与开着的辅助对话 */
  const drawerOpenId = drawerView.sessionId ?? drawerView.opened?.id ?? null;
  const watchedIds = [
    ...(overlay === "settings" || mainOpenId === "" ? [] : [mainOpenId]),
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
  /** 专注中（计时里）：完成提醒静音——记未读、不响铃、不弹卡（用户裁决：专注期间
   * 其它会话跑完只记帐，专注结束后铃铛照常可见）。done 之后恢复常觃。 */
  const focusQuiet = focus.status.kind === "run";
  useEffect(() => {
    const prev = prevStatesRef.current;
    prevStatesRef.current = engine.states;
    // 只认根会话；列表里还查不到的（刚建）当根会话
    const settled = settledSessions(prev, engine.states).filter(
      (id) => session.sessions.find((meta) => meta.id === id)?.parentId === undefined,
    );
    if (settled.length === 0) return;
    const windowActive = !isWindowInactive({
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    });
    let ring = false;
    const fresh: string[] = [];
    for (const id of settled) {
      const plan = planNotice({
        watched: watchedIds.includes(id),
        windowActive,
        soundOn: focusQuiet ? false : (settings.completionSound ?? true),
      });
      ring ||= plan.sound;
      if (plan.unread) fresh.push(id);
    }
    // 同拍多条只响一声
    if (ring) playCompletionChime();
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
   * 右下角铃铛的清单（2026-10-10 二轮）：所有竖条亮着的根会话——在等你、未读
   * （跑完 / 跑挂没看）、在跑——排序「等你 > 未读 > 在跑，同档新在前」。与侧栏
   * 竖条同一份推导（sessionRunState，单一真源）；点行在主槽打开那条会话，
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
        },
        children: childSessions(session.sessions, meta.id).map((child) => ({
          phase: session.phaseOf(child.id),
          approvals: session.approvalsOf(child.id).length,
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
  }, [session.sessions, session.workspaces, session.phaseOf, session.approvalsOf, engine.states]);
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
    setRightPanel(next);
  }, []);
  /** 召回终态卡的「在右栏看图谱」（2026-10-14 终态卡重写）：直达右栏意图面板。引用稳定（TranscriptColumn 是 memo） */
  const openIntentPanel = useCallback(() => handlePanel("intent"), [handlePanel]);

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
  const openTokenPicker = useCallback((position: number): boolean => {
    tokenPickAnchorRef.current = position;
    setTokenPickerOn(true);
    setTokenPickRequest((n) => n + 1);
    setRightPanel("skills");
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
    if (tokenPickerOn && rightPanel !== "skills" && rightPanel !== "mcp") {
      setTokenPickerOn(false);
      tokenPickAnchorRef.current = null;
    }
  }, [rightPanel, tokenPickerOn]);
  const skillsPicker: TokenPickerControl = {
    onSelect: finishTokenPick,
    onCancel: () => finishTokenPick(null),
    onSwitch: () => setRightPanel("mcp"),
    request: tokenPickRequest,
    workspaceId: session.workspaceId,
  };
  const mcpPicker: TokenPickerControl = {
    onSelect: finishTokenPick,
    onCancel: () => finishTokenPick(null),
    onSwitch: () => setRightPanel("skills"),
    request: tokenPickRequest,
    workspaceId: session.workspaceId,
  };

  // ── 面板行内「选用」按钮的插入（panel-token.ts）─────────────────
  // Skills 行 / MCP 卡尾的选用键（RowHoverAction）：token 落到主槽输入框当前
  // 光标处（从未聚焦过则草稿末尾）、焦点回输入框。与选取的锚点回执分开走：
  // 按钮是浏览态入口，面板不关，可以连插几条
  const [panelInsert, setPanelInsert] = useState<PanelInsertRequest | null>(null);
  const panelInsertNonceRef = useRef(0);
  const insertPanelToken = useCallback((token: string): void => {
    panelInsertNonceRef.current += 1;
    setPanelInsert({ token, nonce: panelInsertNonceRef.current });
  }, []);

  // Esc 关面板（再点图标 / 面板内 × 之外的第二出口）。Sub-sessions 面板开着且在
  // 会话层时，Esc 只退一层回列表（escapeFrom），不直接关掉整个面板——与面板内部
  // 「返回」按钮同一个退出台阶（子会话 PR4c 2.1）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (rightPanel === "subsessions") {
        const next = escapeFrom(subSessionsNav);
        if (next === null) setRightPanel(null);
        else setSubSessionsNav(next);
      } else if (rightPanel === "files" && filesEscapeRef.current?.() === true) {
        // 文件面板开着预览：这一下 Esc 只关预览（退一层），面板留着
      } else if (rightPanel !== null) {
        setRightPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightPanel, subSessionsNav]);

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
  // MCP 面板与 Skills 面板共用这个 hook（servers 也在里面）：只认 skills 的话，
  // 单独打开 MCP 面板 active 恒为 false，列表永远停在「Loading servers…」（2026-09-21 实测）
  // workspaces 传的是 session.workspaces（侧栏渲染用的同一份，来自会话引擎）：
  // 两份列表不同步会导致侧栏删了工作区、面板还显示旧的（2026-09-23 真机复现的 bug）
  const skills = useSkills(shownPanel === "skills" || shownPanel === "mcp", session.workspaces);

  /**
   * Create skill…（4-7）：新建会话并预填 composer——skill 正文是给 agent 读的，
   * 创建走对话里的 create_skill 工具。**面板不关**（用户可能对着现有 skill 参考），
   * 新会话落在当前 workspace（有的话，agent 的默认 scope 才对）。
   */
  const createSkillDraft = useCallback(() => {
    const intent = session.workspaces.find((w) => w.id === session.workspaceId);
    if (intent !== undefined) session.newTaskIn(intent);
    else session.newTask();
    session.setDraft(t.app.skillDraft);
  }, [session, t]);
  /** 抽屉选择器要排除的：主槽正看着的那条（它已经在中间了） */
  const mainSessionId = session.sessionId ?? session.opened?.id ?? null;

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
  // 实验功能逐项开关（会话生命周期挂在其中）：关着时右栏底部的遗留事项
  // 入口不渲染；showCarryovers 的本地状态可能残留（开着面板去设置里关了开关），
  // 在传给 Sidebar 的路上一并压掉——开关关了，这个子视图就不该再出得来
  const experimentalFeatures = settings.experimentalFeatures ?? {};
  const sessionLifecycle = experimentalFeatures["session-lifecycle"] === true;
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
    overlay === "settings" ? (
      <div className="cap-sess">
        <div className="cap-sc">
          <strong className="cap-title">{t.settings.tabs[settingsTab]}</strong>
        </div>
      </div>
    ) : mainOpenId === "" && session.opened === null ? null : (
      <SessionCapsule
        title={capsuleTitle}
        shortId={capsuleShortId}
        onRename={mainOpenId === "" ? undefined : (title) => session.renameSession(mainOpenId, title)}
        completion={
          sessionLifecycle && mainOpenId !== ""
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
    // 遗留事项入口（收尾扫描的下游）挂会话生命周期开关；Archived / Browser / Settings 不挂
    ...(sessionLifecycle
      ? [
          {
            icon: "list-todo" as const,
            label: t.app.carryoversEntry(openCarryoverCount),
            lit: railSubviewLit(subviewState, "carryovers"),
            onClick: () => applySubviewState(toggleRailSubview(subviewState, "carryovers")),
          },
        ]
      : []),
    {
      icon: "archive" as const,
      label: t.app.archivedEntry(archivedCount),
      lit: railSubviewLit(subviewState, "archived"),
      onClick: () => applySubviewState(toggleRailSubview(subviewState, "archived")),
    },
    {
      // 受管浏览器是独立的沙盒窗口（不占右栏面板位）：点了就打开或聚焦它，没有「亮」的状态。
      // 它是 agent 的工具，这个入口给用户提前登录、看一眼 agent 停在哪
      icon: "globe" as const,
      label: t.rail.browser,
      lit: false,
      onClick: () => {
        api.browser.open().catch((cause: unknown) => console.error("[browser] 打开沙盒窗口失败", cause));
      },
    },
    {
      icon: "settings" as const,
      label: t.common.settings,
      lit: overlay === "settings",
      onClick: () => setOverlay(overlay === "settings" ? null : "settings"),
    },
  ];

  return (
    <LocaleContext.Provider value={locale}>
    <ExperimentalFeaturesContext.Provider value={experimentalFeatures}>
    <PastedTextCollapseContext.Provider value={settings.collapsePastedText ?? true}>
    {/* 输入框材料盒：开关 × 主题（只在浅 / 黛 / 玄）× 黑洞与俄罗斯方块的互斥优先级，
        在这里用 materialBoxStyle 算一次，输入框与转录都读它 */}
    <MaterialBoxContext.Provider
      value={materialBoxStyle(
        experimentalFeatures["composer-blackhole"] === true,
        experimentalFeatures["composer-tetris"] === true,
        resolvedTheme,
      )}
    >
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
          panelWidth={panelWidth}
          narrow={narrow}
          sessionSlot={sessionSlot}
          onPanelSlot={setPanelSlot}
          onToggleDrawer={() => setRightPanel(rightPanel === null ? "drawer" : null)}
          focus={focusControl}
        />
        <Sidebar
          session={session}
          overlay={overlay}
          settingsTab={settingsTab}
          onSettingsTab={setSettingsTab}
          onOverlay={setOverlay}
          showArchived={showArchived}
          showCarryovers={showCarryovers && sessionLifecycle}
          onShowArchived={setShowArchived}
          onShowCarryovers={setShowCarryovers}
          width={sidebarWidth}
          unread={new Set(unreadSessions.map((meta) => meta.id))}
          onWidthChange={setSidebarWidth}
          onWidthCommit={(width) => {
            setSidebarWidth(width);
            changeSettings({ sidebarWidth: width });
          }}
          usagePet={settings.usagePet}
          onUsagePetChange={(usagePet) => changeSettings({ usagePet })}
          usageSay={focusSay}
          usageCard={focusCard}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          newTaskSignal={newTaskSignal}
          filesView={focusFilesView}
          onBrowseWorkspace={(id) => {
            setOverlay(null);
            setShowArchived(false);
            setShowCarryovers(false);
            setWsBrowse(id);
          }}
          onExitBrowse={() => setWsBrowse(null)}
          onStartFocusHere={openFocusPickerAt}
        />

        <main className="pane">
          <div className="pane-main">
            {/* 主槽内的弹出宿主（完成提醒卡 / 铃铛清单）：卡片属于内容面这一层，
                与主槽边框隔一条血线；右栏面板开着时停在主槽这一侧 */}
            <div className="pane-pop-host" ref={setPopHost} />
            {overlay === "settings" ? (
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
                onTab={setSettingsTab}
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
                panelInsert={panelInsert}
                intentNewSessionDefault={effectiveIntentSettings(settings.intent).newSessionOn}
                onOpenIntentPanel={openIntentPanel}
                onOpenSideChat={openInSideChat}
                intentOpenableIds={intentOpenableIds}
              />
            )}
          </div>
          {/* 右侧面板壳：三菜单共用的常驻分栏。展开/收起/切换只有一条动画路径 */}
          <RightPanelSlot
            open={rightPanel !== null}
            width={panelWidth}
            narrow={narrow}
            onWidthChange={setPanelWidth}
            onWidthCommit={(width) => changeSettings({ rightPanelWidth: width })}
          >
            {/* 收起动画期间保持原内容；切换时 key 变化触发 120ms 内容淡入 */}
            <div
              key={shownPanel ?? "closed"}
              style={{
                height: "100%",
                animation: "right-panel-fade 120ms var(--ease-out-quint)",
              }}
            >
              {shownPanel === "files" ? (
                <FilesPanel session={session} escapeRef={filesEscapeRef} citeFocus={citeFocus} />
              ) : shownPanel === "review" ? (
                <ReviewPanel
                  sessionId={session.sessionId ?? session.opened?.id ?? null}
                  focus={reviewFocus}
                  revision={`${session.fileTurns.length}:${session.reverts.length}:${session.undos.length}:${session.phase}`}
                  cwd={session.cwd}
                  excerptRevision={excerptRevision}
                  onJumpExcerpt={openExcerpt}
                />
              ) : shownPanel === "skills" ? (
                <SkillsPanel
                  skills={skills}
                  defaultWorkspaceId={session.workspaceId}
                  onCreateSkill={createSkillDraft}
                  picker={tokenPickerOn ? skillsPicker : undefined}
                  onInsert={insertPanelToken}
                />
              ) : shownPanel === "mcp" ? (
                <McpPanel
                  skills={skills}
                  picker={tokenPickerOn ? mcpPicker : undefined}
                  onInsert={insertPanelToken}
                />
              ) : shownPanel === "terminal" ? (
                <TerminalPanel
                  cwd={session.cwd}
                  activateId={pendingTerminal}
                  onActivated={() => setPendingTerminal(null)}
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
            </div>
          </RightPanelSlot>
        </main>

        <RightRail
          panel={rightPanel}
          onPanel={handlePanel}
          railEntries={railEntries}
          intentAvailable={settings.experimentalFeatures?.["intent-system"] === true}
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
          }}
        />
      </div>
    </div>
    </ToolbarPanelSlotContext.Provider>
    </CitationOpenContext.Provider>
    </MaterialBoxContext.Provider>
    </PastedTextCollapseContext.Provider>
    </ExperimentalFeaturesContext.Provider>
    </LocaleContext.Provider>
  );
}

/**
 * 平台写到 `<html data-platform>` 上。CSS 需要它：macOS 的窗口是透明的
 * （body 不许上底色），红黄绿三个键要在侧栏顶栏里留净空。
 */
function usePlatform(): void {
  useEffect(() => {
    document.documentElement.dataset["platform"] = api.platform;
  }, []);
}
