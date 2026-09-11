import { useCallback, useEffect, useState } from "react";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from "@shared/settings";
import { useChatSession, useSessionView } from "./features/chat/useChatSession";
import { ChatView } from "./features/chat/ChatView";
import { transcriptToMarkdown } from "@shared/session";
import { SettingsView, type SettingsTab } from "./features/settings/SettingsView";
import { useSkills } from "./features/skills/useSkills";
import { Sidebar, type Overlay } from "./shell/Sidebar";
import { RightRail, SessionActions, type RightPanelKind } from "./shell/RightRail";
import { SkillsPanel } from "./features/skills/SkillsPanel";
import { McpPanel } from "./features/mcp/McpPanel";
import { RIGHT_PANEL_WIDTH_DEFAULT } from "@shared/settings";
import { Titlebar } from "./shell/Titlebar";
import { Drawer, type DockedTab } from "./shell/Drawer";
import type { DrawerSettings } from "@shared/settings";

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
 * 中间只有一根竖线（wafo 2026-09-11 裁决）。转帧式窗口的窗口键在自绘标题栏
 * （Titlebar）上；复制转录与抽屉开关住在右图标条（wafo 2026-09-12 裁决）。
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

  const { session, engine } = useChatSession(providers);
  /** 抽屉槽：与主槽共用引擎的第二个「正在看」。辅助对话就是普通 task（Q2 裁决）。 */
  const drawerView = useSessionView(engine, "drawer");

  // 抽屉的开关 / 宽度 / 停靠，记忆在设置里（初次默认收起，之后记住上次——Q3/Q4 裁决）
  const [drawerOpen, setDrawerOpen] = useState(DEFAULT_SETTINGS.drawer.open);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_SETTINGS.drawer.width);
  const [docked, setDocked] = useState<DockedTab[]>(DEFAULT_SETTINGS.drawer.docked);
  useEffect(() => {
    setDrawerOpen(settings.drawer.open);
    setDrawerWidth(settings.drawer.width);
    setDocked(settings.drawer.docked);
  }, [settings.drawer]);

  /** 抽屉偏好改动：只发改的键，主进程做 drawer 内部的键级合并
   *  （整块回写会拿到渲染层闭包里的旧值，先后覆盖有竞态——真机冒烟实测） */
  const changeDrawer = useCallback(
    (patch: Partial<DrawerSettings>) => {
      if ("open" in patch) setDrawerOpen(patch.open ?? false);
      if ("width" in patch) setDrawerWidth(patch.width ?? DEFAULT_SETTINGS.drawer.width);
      if ("docked" in patch) setDocked(patch.docked ?? []);
      changeSettings({ drawer: patch });
    },
    [changeSettings],
  );

  const toggleDrawer = useCallback(() => {
    changeDrawer({ open: !drawerOpen });
  }, [changeDrawer, drawerOpen]);

  // Ctrl+Alt+D 开关抽屉（与右图标条按钮、动作同源）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && (event.key === "d" || event.key === "D")) {
        event.preventDefault();
        toggleDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDrawer]);

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
  const skills = useSkills(rightPanel === "skills");
  /** 会话动作只在有会话时出现——它承载的是「对这个会话做点什么」；
   * 顶部入口常驻，不随会话消失（首页也能开 Skills / MCP）。 */
  const sessionActions =
    session.sessionId !== null || session.opened !== null ? (
      <SessionActions
        canCopy={session.transcript.length > 0}
        onCopyTranscript={() =>
          // 与「导出」同一份实现：复制出来的和导出的必须长得一样
          void navigator.clipboard.writeText(transcriptToMarkdown(session.transcript))
        }
      />
    ) : (
      false
    );

  /** 抽屉选择器要排除的：主槽正看着的那条（它已经在中间了） */
  const mainSessionId = session.sessionId ?? session.opened?.id ?? null;

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
        />

        <main className="pane">
          {overlay === "settings" ? (
            <SettingsView
              tab={settingsTab}
              settings={settings}
              onSettingsChange={changeSettings}
              onProvidersChange={refresh}
            />
          ) : (
            <ChatView session={session} providersError={providersError} />
          )}
          {overlay === null && (
            <Drawer
              engine={engine}
              view={drawerView}
              mainSessionId={mainSessionId}
              providersError={providersError}
              open={drawerOpen}
              width={drawerWidth}
              onWidthChange={setDrawerWidth}
              onWidthCommit={() => changeDrawer({ width: drawerWidth })}
              docked={docked}
              onDockedChange={(list) => changeDrawer({ docked: [...list] })}
            />
          )}
        </main>

        {rightPanel === "skills" ? (
          <SkillsPanel
            narrow={narrow}
            skills={skills}
            onClose={() => setRightPanel(null)}
            width={panelWidth}
            onWidthChange={setPanelWidth}
            onWidthCommit={(width) => changeSettings({ rightPanelWidth: width })}
            defaultWorkspaceId={session.workspaceId}
            onCreateSkill={createSkillDraft}
          />
        ) : rightPanel === "mcp" ? (
          <McpPanel
            narrow={narrow}
            skills={skills}
            onClose={() => setRightPanel(null)}
            width={panelWidth}
            onWidthChange={setPanelWidth}
            onWidthCommit={(width) => changeSettings({ rightPanelWidth: width })}
          />
        ) : null}

        <RightRail
          panel={rightPanel}
          onPanel={setRightPanel}
          sessionActions={sessionActions}
          drawerOpen={drawerOpen}
          onToggleDrawer={toggleDrawer}
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
