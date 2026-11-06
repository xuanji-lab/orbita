/**
 * 插件页「正在做」组的数据：主进程扫出来的、有清单但还没安装的插件文件夹（`plugin:drafts`）。
 * 和已装列表同一个纪律：只在页面开着时读；读失败不清空手里那份、把原因留给页面说出来
 * （读不到不等于没有——别让一个坏目录把用户的草稿说成「没有」）。
 *
 * 什么时候重读：打开时；agent 预览了草稿（pluginDraft：名字 / 描述可能刚写进清单）；agent 装好了（pluginsChanged）；
 * 已装列表变了（`installed` 换了引用：用户自己在页面里装 / 卸载 / 改范围不广播事件，但都会重读已装列表——
 * 草稿从这里消失、出现在已装里就靠它）；用户从草稿长页回到列表（`viewing` 变了：agent 这期间可能改过清单）。
 */
import { useCallback, useEffect, useState } from "react";
import type { PluginDraftEntry, PluginView } from "@shared/plugin";
import { api } from "../../api";

export interface DraftListState {
  drafts: PluginDraftEntry[];
  /** 最近一次读失败的原因；null = 读得出来 */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDraftList(active: boolean, installed: readonly PluginView[], viewing: string | null): DraftListState {
  const [drafts, setDrafts] = useState<PluginDraftEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDrafts(await api.plugin.drafts());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh, installed, viewing]);

  useEffect(() => {
    if (!active) return;
    return api.agent.onEvent((event) => {
      if (event.type === "pluginsChanged" || event.type === "pluginDraft") void refresh();
    });
  }, [active, refresh]);

  return { drafts, error, refresh };
}
