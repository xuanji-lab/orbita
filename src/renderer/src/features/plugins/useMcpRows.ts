/**
 * 插件详情里 MCP 的运行时状态：你自己的 MCP（api.mcp.list 的行）与插件自带 MCP（pluginServers）。
 * 连接状态是 agent 进程的运行时事实，随开会话、重载、闲置回收持续变化——详情开着就得跟着快照走，
 * 否则永远停在打开那一刻（旧 MCP 面板实测：会话里工具能用，面板却显示「还没连上」）。
 * `enabled` = false（这张详情不涉及 MCP）时一次都不读。读失败不清空手里那份，错误原文留给调用方贴出来。
 */
import { useCallback, useEffect, useState } from "react";
import type { McpServerInfo, McpStatusSnapshot } from "@shared/mcp";
import { api } from "../../api";

export interface McpRowsState {
  /** 全局 mcp.json ∪ 工作区 .mcp.json 的行（你配的） */
  servers: McpServerInfo[];
  /** 插件自带 MCP 的运行时行（名字是 plugin_<插件>_<服务>） */
  pluginServers: McpStatusSnapshot;
  /** 没读到（还没回来 / 读失败）= false；回来过一次 = true */
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** 重读 mcp.json 并重连（重试 / 重连键）；失败往上抛，调用方就地说出来 */
  reconnect: () => Promise<void>;
}

export function useMcpRows(enabled: boolean): McpRowsState {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [pluginServers, setPluginServers] = useState<McpStatusSnapshot>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api.mcp.list();
      setServers(result.servers);
      setPluginServers(result.pluginServers);
      setLoaded(true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    return api.agent.onEvent((event) => {
      if (event.type === "mcp") void refresh();
    });
  }, [enabled, refresh]);

  const reconnect = useCallback(async (): Promise<void> => {
    // invoke 在 agent 进程重连完、新快照已缓存时才返回；回来后重拉拿到新状态
    await api.mcp.reload();
    await refresh();
  }, [refresh]);

  return { servers, pluginServers, loaded, error, refresh, reconnect };
}
