/**
 * 插件页的数据：真插件 + 旧技能 + 旧 MCP 一张表（主进程合成）。
 * 只在页面打开时读盘；写（开关、范围、配置、安装、卸载）一律**先落盘再回读**，
 * 不做乐观更新——旧技能的 global / 工作区互斥由主进程执行，乐观更新会把被删的那条留在屏幕上
 * （同 useSkills 的纪律）。读失败不清空手里那份。
 */
import { useCallback, useEffect, useState } from "react";
import type { PluginScope, PluginView } from "@shared/plugin";
import { api } from "../../api";
import { publishPluginNames } from "./usePluginNames.ts";
import { LOADING, READY, failed, type LoadState } from "../chat/load-state";

export interface PluginsState {
  plugins: PluginView[];
  /** mcp.json 读不出来的原文（其余照常列）；null = 读得出来 */
  mcpError: string | null;
  load: LoadState;
  refresh: () => Promise<void>;
  /** 改启用范围：失败往上抛，调用方就地说出来 */
  setScope: (id: string, scope: PluginScope) => Promise<void>;
}

export function usePlugins(active: boolean): PluginsState {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [load, setLoad] = useState<LoadState>(LOADING);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api.plugin.list();
      setPlugins(result.plugins);
      publishPluginNames(result.plugins);
      setMcpError(result.mcpError);
      setLoad(READY);
    } catch (cause) {
      setLoad(failed(cause));
    }
  }, []);

  // agent 的 install_plugin 装好了一个：开着的页面立刻重读（不用等下次打开）
  useEffect(() => {
    if (!active) return;
    return api.agent.onEvent((event) => {
      if (event.type === "pluginsChanged") void refresh();
    });
  }, [active, refresh]);

  // 每次打开都重读：用户很可能刚在文件管理器里动过插件目录，或在旧面板里拨过技能
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const setScope = useCallback(
    async (id: string, scope: PluginScope): Promise<void> => {
      try {
        await api.plugin.setScope(id, scope);
      } finally {
        // 写失败也回读：界面要如实反映磁盘上此刻的状态
        await refresh();
      }
    },
    [refresh],
  );

  return { plugins, mcpError, load, refresh, setScope };
}
