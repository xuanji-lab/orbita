/**
 * 聊天里 chip 用的「标识 → 显示名」小表（纯函数在 plugin-names.ts）。输入框与气泡远离插件页，
 * 不该各自去读盘：`usePlugins` 每次读到列表就发布进来（publishPluginNames），chip 订阅它；
 * 表还没人发布过（没开过插件页）时由第一个订阅者读一次。
 */
import { useEffect, useSyncExternalStore } from "react";
import type { PluginView } from "@shared/plugin";
import { api } from "../../api";
import { pluginNameMap } from "./plugin-names.ts";

let current: ReadonlyMap<string, string> = new Map();
let loaded = false;
const listeners = new Set<() => void>();

/** 每次读到插件列表就调（usePlugins 的 refresh）：表整个换掉，订阅者重画。 */
export function publishPluginNames(views: ReadonlyArray<Pick<PluginView, "id" | "origin" | "name">>): void {
  current = pluginNameMap(views);
  loaded = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅标识 → 显示名表。第一个订阅者在表还没人发布过时读一次列表（读失败不管：chip 退回标识）。 */
export function usePluginNames(): ReadonlyMap<string, string> {
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void api.plugin.list().then(
      (result) => publishPluginNames(result.plugins),
      () => {
        loaded = false;
      },
    );
  }, []);
  return useSyncExternalStore(subscribe, () => current);
}
