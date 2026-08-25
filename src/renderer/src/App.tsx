import { useCallback, useEffect, useState } from "react";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/settings";
import { useChatSession } from "./features/chat/useChatSession";
import { ChatView, transcriptToText } from "./features/chat/ChatView";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  useTheme(settings.theme);
  const refresh = useCallback(async () => {
    // 读不到就当没有 provider——真正的原因由设置面自己报（它有 error 行），
    // 外壳不该因为一次 IPC 失败而白屏
    try {
      setProviders(await api.provider.list());
    } catch {
      setProviders([]);
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
  /** 看历史时复制的是历史那一份，不是实时那一份 */
  const visibleTranscript = session.archived?.transcript ?? session.transcript;
  /** 动作条只在有内容可操作时出现——它承载的是「对这条会话做点什么」 */
  const showRail = !settingsOpen && (session.sessionId !== null || session.archived !== null);

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
          <ChatView session={session} />
        )}
      </main>

      {showRail && (
        <ActionRail
          canCopy={visibleTranscript.length > 0}
          onCopyTranscript={() =>
            void navigator.clipboard.writeText(transcriptToText(visibleTranscript))
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
