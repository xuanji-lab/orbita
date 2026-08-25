import { useCallback, useEffect, useState } from "react";
import { useSystemTheme } from "./useSystemTheme";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";
import { useChatSession } from "./features/chat/useChatSession";
import { ChatView, sessionTitle, transcriptToText } from "./features/chat/ChatView";
import { ProvidersView } from "./features/settings/ProvidersView";
import { Sidebar } from "./shell/Sidebar";
import { ActionRail } from "./shell/ActionRail";

/**
 * App shell —— 设计系统的构图，不只是它的 token。
 *
 * 三层：**壁纸**（body）→ **layer 1 玻璃大卡**（`.layer`，app 的边界，侧栏也在里面）
 * → **layer 2 中卡**（`.pane`，四边等距浮在大卡里，它的左边缘决定左栏宽度）。
 * 两层画同一个 `--glass-bg`，深度是合成出来的；两层都 `border: 0`。
 *
 * 左右两条栏都没有自己的面：左栏 288px 是会话与工作区，右栏 32px 是会话动作，
 * 都直接坐在 layer 1 上（设计系统 *Layout*：both sidebars are unbounded）。
 */
export function App() {
  useSystemTheme();
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  }, [refresh]);

  const session = useChatSession(providers);
  const title = sessionTitle(session.transcript);
  /** 右图标条只在有会话时出现——它承载的是「对这个会话做点什么」 */
  const showRail = !settingsOpen && session.sessionId !== null;

  return (
    <div className="shell">
      <div className="layer">
        <Sidebar
          session={session}
          title={title}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
        />

        <main className="pane">
          {settingsOpen ? (
            <div className="scroll" style={{ height: "100%", padding: "var(--space-6) var(--space-5)" }}>
              <div style={{ maxWidth: 640, margin: "0 auto" }}>
                <ProvidersView onChange={refresh} />
              </div>
            </div>
          ) : (
            <ChatView session={session} />
          )}
        </main>

        {showRail && (
          <ActionRail
            canCopy={session.transcript.length > 0}
            onCopyTranscript={() =>
              void navigator.clipboard.writeText(transcriptToText(session.transcript))
            }
          />
        )}
      </div>
    </div>
  );
}
