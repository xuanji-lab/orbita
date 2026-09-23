import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from "@shared/settings";
import { childSessions, rootSessions } from "@shared/session";
import { useChatSession, useSessionView } from "./features/chat/useChatSession";
import { ChatView } from "./features/chat/ChatView";
import { ChannelColumn, type ChannelOpenRequest } from "./features/chat/ChannelColumn";
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
import { RightRail, type RailEntry, type RightPanelKind } from "./shell/RightRail";
import { RightPanelSlot } from "./shell/RightPanel";
import { SkillsPanel } from "./features/skills/SkillsPanel";
import { McpPanel } from "./features/mcp/McpPanel";
import { FilesPanel } from "./features/files/FilesPanel";
import { CHANNEL_COLUMN_WIDTH_DEFAULT, RIGHT_PANEL_WIDTH_DEFAULT, SIDEBAR_WIDTH_DEFAULT } from "@shared/settings";
import { Titlebar } from "./shell/Titlebar";
import { Drawer, type DockedTab } from "./shell/Drawer";
import { NEW_TASK_TAB } from "./shell/drawer-state";

/**
 * App shell —— 设计系统的构图，不只是它的 token。
 *
 * **三层，不是四层**：用户自己的桌面 → **边界卡**（`.layer`，layer 1，就是窗口本身，
 * 侧栏也在里面）→ **内容面**（`.pane`，layer 2，四边等距浮在边界卡里，
 * 它的左边缘决定侧栏宽度）→ **输入卡**（layer 3）。
 * 两层玻璃画同一个 `--glass-bg`，深度是合成出来的；两层都 `border: 0`。
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
  });
  useTheme(settings.theme);
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

  /** 通道列宽度（子会话 2026-09-23 裁决：可拖宽）：同一套口径——拖动中只改本地，松手才落 settings */
  const [channelColumnWidth, setChannelColumnWidth] = useState(CHANNEL_COLUMN_WIDTH_DEFAULT);
  useEffect(() => {
    if (settings.channelColumnWidth !== undefined) setChannelColumnWidth(settings.channelColumnWidth);
  }, [settings.channelColumnWidth]);

  const { session, engine } = useChatSession(providers);
  /** 抽屉槽：与主槽共用引擎的第二个「正在看」。辅助对话就是普通 task（Q2 裁决）。 */
  const drawerView = useSessionView(engine, "drawer");

  /**
   * 通道列（子会话 PR4b）：只在主槽正看着一条**根会话**（meta 没有 parentId）且
   * 没盖着设置页时才有意义——同 ChatView.tsx 里 `ownSide` 的推导口径（meta 查不到
   * 时缺省当根会话），两处必须一致，否则标记可点但通道列不出来。
   */
  const mainOpenId = session.sessionId ?? session.opened?.id ?? "";
  const mainOpenMeta = session.sessions.find((m) => m.id === mainOpenId) ?? session.opened;
  const channelParentId =
    overlay === "settings" || mainOpenId === "" || mainOpenMeta?.parentId !== undefined ? null : mainOpenId;
  const channelParentTitle = mainOpenMeta?.title ?? "";

  /**
   * 用户对每个父会话显隐通道列的**显式选择**（ephemeral，不落盘，按父会话 id 记
   * ——3.2 裁决）。缺席 = 没有显式选择，走默认：放得下（inline）有可见通道即
   * 显示，放不下（overlay）不自动出现（ChannelColumn 内部按 `shown ?? !overlay`
   * 解析，这里只存显式值）。
   */
  const [channelShown, setChannelShown] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** 当前根会话有没有可见通道——ChannelColumn 上报，右图标条入口的显隐 / 点亮靠它 */
  const [hasVisibleChannels, setHasVisibleChannels] = useState(false);
  /**
   * 通道列此刻是 inline 还是 overlay（子会话 PR4c fix：CDP 实测发现窗口 1200px、
   * 右栏与通道列同开时主槽被挤到 ~200px）——不只是全局 `narrow`：右栏开着时挤占
   * 的空间也要算进去，`ChannelColumn` 内部量好后经 `onLayoutChange` 上报。
   * App 这里需要它做与 `ChannelColumn` 内部同款的默认显隐判定（下面
   * `channelColumnOpen`）与 Esc 协调（见下方 Esc 的 useEffect），两处口径必须
   * 一致，否则右图标条亮着的状态和 Esc 实际收起的行为对不上。
   */
  const [channelColumnOverlay, setChannelColumnOverlay] = useState(false);
  const channelShownOverride = channelParentId !== null ? (channelShown.get(channelParentId) ?? null) : null;
  const channelColumnOpen =
    channelParentId !== null && hasVisibleChannels && (channelShownOverride ?? !channelColumnOverlay);
  const setChannelShownOverride = useCallback(
    (shown: boolean) => {
      if (channelParentId === null) return;
      setChannelShown((prev) => {
        if (prev.get(channelParentId) === shown) return prev;
        return new Map(prev).set(channelParentId, shown);
      });
    },
    [channelParentId],
  );
  /** 点父流里的标记 → 通道列的一次性请求（token 每次自增，同一条消息再点一次也要能重新触发滚动与高亮） */
  const [channelOpenRequest, setChannelOpenRequest] = useState<ChannelOpenRequest | null>(null);
  const openChannel = useCallback(
    (childId: string, messageId: string | null) => {
      setChannelShownOverride(true);
      setChannelOpenRequest((prev) => ({ childId, messageId, token: (prev?.token ?? 0) + 1 }));
    },
    [setChannelShownOverride],
  );

  /**
   * Sub-sessions 面板（子会话 PR4c）：入口只在主槽正看着一条有子会话的根会话时出现，
   * 复用上面 `channelParentId` 的「根会话 / 非设置页」口径——两处必须一致，否则
   * 入口出现但点开是空的，或入口消失了通道数据还在算。
   */
  const subSessionChildren = channelParentId === null ? [] : childSessions(session.sessions, channelParentId);
  const hasSubSessions = subSessionChildren.length > 0;

  /**
   * 面板两层状态机（`sub-sessions-state.ts`，原样搬自旧 wip）：App 持有，
   * `SubSessionsPanel` 受控渲染——理由同 `channelShown`/`channelOpenRequest`：
   * 派出卡点击（主槽的 `ChatView`）与面板本体分处两棵子树，accent 描边要在
   * 主槽里知道「面板会话层现在开着哪条」，状态放子组件里够不到。
   */
  const [subSessionsNav, setSubSessionsNav] = useState<SubSessionsView>(SUB_SESSIONS_LIST);
  /** 会话层的查看槽：与主槽/抽屉槽同一份引擎，互不串（同 drawerView 的先例） */
  const subSessionsView = useSessionView(engine, "subsessions");

  // 主槽换会话 → 面板回列表层（“面板里开着的那条挂错了母亲”，2.1 裁决）；
  // 只在 mainOpenId 真的变化时才重置——见 syncToMainSession 本身的纯逻辑
  const subSessionsMainIdRef = useRef<string | null>(null);
  /** 文件面板的「Esc 先退一层」：预览开着时由它关预览（FilesPanel 填，Esc 监听里先问它） */
  const filesEscapeRef = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    const nextMainId = mainOpenId === "" ? null : mainOpenId;
    setSubSessionsNav((prev) => syncToMainSession(prev, subSessionsMainIdRef.current, nextMainId));
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
  /** 子会话头部面包屑「↑ 父标题」：主槽回到父会话（2.2） */
  const openParent = useCallback(
    (parentId: string) => {
      void session.openSession(parentId);
    },
    [session],
  );
  /** 右栏会话层正开着的那条子会话 id——只在面板真的开着时才算「点亮」，见派出卡描边 */
  const litSubSessionId =
    rightPanel === "subsessions" && subSessionsNav.kind === "session" ? subSessionsNav.sessionId : null;

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

  /** 右侧三个图标共用**一个面板位**（2026-09-12 裁决）：同一时刻至多展开一个，
   *  "drawer" 即辅助对话——三个菜单在同一个壳里只是三种内容。 */
  const handlePanel = useCallback((next: RightPanelKind | null) => {
    setRightPanel(next);
  }, []);

  // Esc 关面板（再点图标 / 面板内 × 之外的第二出口）；通道列是 overlay 时
  // （全局窄窗，或非窄窗但放不下——子会话 PR4c fix），Esc 同样收起（3.2 裁决：
  // Esc 或再点入口收起）。Sub-sessions 面板开着且在会话层时，Esc 只退一层回
  // 列表（escapeFrom），不直接关掉整个面板——与面板内部「返回」按钮同一个退出
  // 台阶（子会话 PR4c 2.1）
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
      if (channelColumnOverlay && channelColumnOpen) setChannelShownOverride(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightPanel, subSessionsNav, channelColumnOverlay, channelColumnOpen, setChannelShownOverride]);

  // Ctrl+Alt+D 开关辅助对话（与右图标条按钮同源）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && (event.key === "d" || event.key === "D")) {
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
    session.setDraft("Describe the workflow you want to turn into a skill.");
  }, [session]);
  /** 抽屉选择器要排除的：主槽正看着的那条（它已经在中间了） */
  const mainSessionId = session.sessionId ?? session.opened?.id ?? null;

  /**
   * 右栏底部的应用入口（wafo 2026-09-22：设置、遗留、归档全拸到右栏底部 stack，
   * 首页常驻——它们是应用入口不是会话动作）。点亮判定与互斥规则沿用侧栏
   * 底部行时代的行为：子视图互斥，设置盖着时谁也不亮。Carryovers 沿用折叠
   * rail 时代的先例：0 条不渲染入口（Archived 恒渲染，同先例）。
   */
  // 子会话不参与归档（子会话 PR4c 2.3：session.ts 的契约），角标按根会话数
  const archivedCount = rootSessions(session.sessions).filter((m) => m.archived).length;
  const openCarryoverCount = session.carryovers.filter((item) => item.status === "open").length;
  const railEntries: RailEntry[] = [
    ...(session.carryovers.length > 0
      ? [
          {
            icon: "list-todo" as const,
            label: `Carryovers (${openCarryoverCount} open)`,
            lit: showCarryovers && overlay === null && !showArchived,
            onClick: () => {
              setShowArchived(false);
              setShowCarryovers((value) => !value);
            },
          },
        ]
      : []),
    {
      icon: "archive" as const,
      label: `Archived (${archivedCount})`,
      lit: showArchived && overlay === null && !showCarryovers,
      onClick: () => {
        setShowCarryovers(false);
        setShowArchived((value) => !value);
      },
    },
    {
      icon: "settings" as const,
      label: "Settings",
      lit: overlay === "settings",
      onClick: () => setOverlay(overlay === "settings" ? null : "settings"),
    },
  ];

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="layer">
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
          onWidthChange={setSidebarWidth}
          onWidthCommit={(width) => {
            setSidebarWidth(width);
            changeSettings({ sidebarWidth: width });
          }}
        />

        <main className="pane">
          <div className="pane-main">
            {overlay === "settings" ? (
              <SettingsView
                tab={settingsTab}
                settings={settings}
                providers={providers}
                onSettingsChange={changeSettings}
                onProvidersChange={refresh}
                onImported={() => {
                  engine.refreshSessions();
                  engine.refreshWorkspaces();
                }}
              />
            ) : (
              <ChatView
                session={session}
                providersError={providersError}
                onOpenChannel={openChannel}
                onOpenSubSession={openSubSessionInPanel}
                onOpenSubSessions={openSubSessionsList}
                onOpenParent={openParent}
                litSubSessionId={litSubSessionId}
              />
            )}
          </div>
          {/* 通道列（子会话 PR4b）：主槽与右栏之间，常驻挂载同 RightPanelSlot 的先例——
              parentId 为 null 时组件自己不显示任何东西，宽度过渡才不会被条件卸载打断。 */}
          <ChannelColumn
            parentId={channelParentId}
            parentTitle={channelParentTitle}
            session={session}
            narrow={narrow}
            width={channelColumnWidth}
            onWidthChange={setChannelColumnWidth}
            onWidthCommit={(width) => changeSettings({ channelColumnWidth: width })}
            shown={channelShownOverride}
            onShownChange={setChannelShownOverride}
            onVisibilityChange={setHasVisibleChannels}
            onLayoutChange={setChannelColumnOverlay}
            openRequest={channelOpenRequest}
          />
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
                <FilesPanel session={session} onClose={() => handlePanel(null)} escapeRef={filesEscapeRef} />
              ) : shownPanel === "skills" ? (
                <SkillsPanel
                  skills={skills}
                  onClose={() => handlePanel(null)}
                  defaultWorkspaceId={session.workspaceId}
                  onCreateSkill={createSkillDraft}
                />
              ) : shownPanel === "mcp" ? (
                <McpPanel skills={skills} onClose={() => handlePanel(null)} />
              ) : shownPanel === "drawer" ? (
                <Drawer
                  engine={engine}
                  view={drawerView}
                  mainSessionId={mainSessionId}
                  providersError={providersError}
                  docked={docked}
                  onDockedChange={(list) =>
                    changeDocked(
                      // 没发过首条消息的新任务占位不是 task，不落盘——重启后从选择卡重新开
                      list.filter((tab) => tab !== NEW_TASK_TAB),
                    )
                  }
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
                  onClose={() => handlePanel(null)}
                  providersError={providersError}
                />
              ) : null}
            </div>
          </RightPanelSlot>
        </main>

        <RightRail
          panel={rightPanel}
          onPanel={handlePanel}
          railEntries={railEntries}
          channelColumn={
            channelParentId !== null && hasVisibleChannels
              ? { open: channelColumnOpen, onToggle: () => setChannelShownOverride(!channelColumnOpen) }
              : null
          }
          subSessions={channelParentId !== null && hasSubSessions ? { count: subSessionChildren.length } : null}
        />
      </div>
    </div>
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
