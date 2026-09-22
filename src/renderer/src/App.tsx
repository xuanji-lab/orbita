import { useCallback, useEffect, useState } from "react";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from "@shared/settings";
import { useChatSession, useSessionView } from "./features/chat/useChatSession";
import { ChatView } from "./features/chat/ChatView";
import { SettingsView, type SettingsTab } from "./features/settings/SettingsView";
import { useSkills } from "./features/skills/useSkills";
import { Sidebar, type Overlay } from "./shell/Sidebar";
import { RightRail, type RailEntry, type RightPanelKind } from "./shell/RightRail";
import { RightPanelSlot } from "./shell/RightPanel";
import { SkillsPanel } from "./features/skills/SkillsPanel";
import { McpPanel } from "./features/mcp/McpPanel";
import { FilesPanel } from "./features/files/FilesPanel";
import { RIGHT_PANEL_WIDTH_DEFAULT, SIDEBAR_WIDTH_DEFAULT } from "@shared/settings";
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
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
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

  const { session, engine } = useChatSession(providers);
  /** 抽屉槽：与主槽共用引擎的第二个「正在看」。辅助对话就是普通 task（Q2 裁决）。 */
  const drawerView = useSessionView(engine, "drawer");

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

  // Esc 关面板（再点图标 / 面板内 × 之外的第二出口）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && rightPanel !== null) setRightPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightPanel]);

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
  const skills = useSkills(shownPanel === "skills" || shownPanel === "mcp");

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
  const archivedCount = session.sessions.filter((m) => m.archived).length;
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
              <ChatView session={session} providersError={providersError} />
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
                <FilesPanel session={session} onClose={() => handlePanel(null)} />
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
              ) : null}
            </div>
          </RightPanelSlot>
        </main>

        <RightRail panel={rightPanel} onPanel={handlePanel} railEntries={railEntries} />
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
