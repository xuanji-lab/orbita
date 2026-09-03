import { useCallback, useEffect, useState } from "react";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/settings";
import { useChatSession } from "./features/chat/useChatSession";
import { ChatView } from "./features/chat/ChatView";
import { transcriptToMarkdown } from "@shared/session";
import { SettingsView, type SettingsTab } from "./features/settings/SettingsView";
import { Sidebar } from "./shell/Sidebar";
import { ActionRail } from "./shell/ActionRail";

/**
 * App shell —— 设计系统的构图，不只是它的 token。
 *
 * **三层，不是四层**：用户自己的桌面 → **边界卡**（`.layer`，layer 1，就是窗口本身，
 * 侧栏也在里面）→ **内容面**（`.pane`，layer 2，四边等距浮在边界卡里，
 * 它的左边缘决定侧栏宽度）→ **输入卡**（layer 3）。
 * 两层玻璃画同一个 `--glass-bg`，深度是合成出来的；两层都 `border: 0`。
 *
 * 侧栏 288px 与动作条 32px 都没有自己的面，直接坐在边界卡上
 * （设计系统 *Layout*：both sidebars are unbounded）。
 */
export function App() {
  usePlatform();
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  /** provider 列表加载失败的原因；null = 正常。**失败要亮在聊天面上**，
   * 不然一次 IPC 失败会显示成「还没有 provider」，用户被引去白配一遍。 */
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const changeSettings = useCallback((patch: Partial<AppSettings>) => {
    void api.settings.set(patch).then(setSettings);
  }, []);

  const session = useChatSession(providers);
  /** 动作条只在有内容可操作时出现——它承载的是「对这条会话做点什么」 */
  const showRail = !settingsOpen && (session.sessionId !== null || session.opened !== null);

  return (
    <div className="layer">
      <Sidebar
        session={session}
        settingsOpen={settingsOpen}
        settingsTab={settingsTab}
        onSettingsTab={setSettingsTab}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
      />

      <main className="pane">
        {settingsOpen ? (
          <SettingsView
            tab={settingsTab}
            settings={settings}
            onSettingsChange={changeSettings}
            onProvidersChange={refresh}
          />
        ) : (
          <ChatView session={session} providersError={providersError} />
        )}
      </main>

      {showRail && (
        <ActionRail
          canCopy={session.transcript.length > 0}
          onCopyTranscript={() =>
            // 与「导出」同一份实现：复制出来的和导出的必须长得一样
            void navigator.clipboard.writeText(transcriptToMarkdown(session.transcript))
          }
        />
      )}
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
