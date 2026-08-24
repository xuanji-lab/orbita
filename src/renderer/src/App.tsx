import { useSystemTheme } from "./useSystemTheme";
import { useCallback, useEffect, useState } from "react";
import { ChatView } from "./features/chat/ChatView";
import { ProvidersView } from "./features/settings/ProvidersView";
import { api } from "./api";
import type { ProviderDto } from "@shared/provider";

/**
 * 应用外壳。目前只有 provider 设置这一面 —— 契约先行：
 * shared 契约 → main store → IPC → UI，会话与聊天面随后续 PR 落地。
 */
export function App() {
  useSystemTheme();
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const refresh = useCallback(async () => setProviders(await api.provider.list()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        display: "grid",
        justifyItems: "center",
        alignContent: "start",
        gap: "var(--space-8)",
        padding: "var(--space-8) var(--space-6)",
      }}
    >
      <header style={{ display: "grid", justifyItems: "center", gap: "var(--space-2)" }}>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-family-brand)",
            fontSize: "var(--font-size-heading)",
            fontWeight: "var(--weight-regular)",
          }}
        >
          orbita
        </h1>
        {/* 品牌标语保持中文，其余界面文案一律英文（设计系统内容规范） */}
        <p
          style={{
            margin: 0,
            fontFamily: "var(--text-slogan-family)",
            fontSize: "var(--font-size-caption)",
            letterSpacing: "var(--tracking-slogan)",
            color: "var(--color-text-tertiary)",
          }}
        >
          璇玑运转，诸事得序
        </p>
      </header>

      <ChatView providers={providers} />

      <ProvidersView onChange={refresh} />
    </div>
  );
}
