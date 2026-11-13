/**
 * 「现在装着哪些插件」的共享快照：对话里那一行（PluginInstallLine）据此判断该说「已装上」还是「安装」。
 *
 * 为什么不是每行各读一次 usePlugins：一条会话里可能有好几行，每行都读一遍整张已装表（要扫技能目录与 mcp.json）
 * 不值；而且行是**重开会话、隔很久之后**也要说对话的——所以数据来自此刻的已装列表，不来自行落盘时的样子。
 * 模块级快照 + useSyncExternalStore：第一个订阅者触发读取，之后每次 pluginsChanged 重读；全部订阅者退出就停听。
 * 读失败不清空手里那份（null = 还没读到）。
 */
import { useSyncExternalStore } from "react";
import { api } from "../../api";
import { installedNamesOf } from "./plugin-view.ts";

let names: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;
let inflight: Promise<void> | null = null;
let again = false;

/**
 * 重读。并发的请求合并，但**读到一半又来了新请求**必须再读一遍：先开始的那次读的是装之前的盘，
 * 合并掉后来的就会让行停在旧状态（装上了却还显示「安装」）。返回的 promise 在最后一遍读完才落定。
 */
export function refreshInstalledPlugins(): Promise<void> {
  if (inflight !== null) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      try {
        const result = await api.plugin.list();
        const next = installedNamesOf(result.plugins);
        // 内容没变就不换引用，订阅者不白渲染
        if (names === null || next.size !== names.size || [...next].some((name) => !names?.has(name))) {
          names = next;
          for (const listener of listeners) listener();
        }
      } catch {
        // 读失败不清空手里那份
      }
    } while (again);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    stopListening = api.agent.onEvent((event) => {
      if (event.type === "pluginsChanged") void refreshInstalledPlugins();
    });
    void refreshInstalledPlugins();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

/** 已装的插件名；null = 还没读到（行先按落盘时的样子画，不闪成「没装」）。 */
export function useInstalledPluginNames(): ReadonlySet<string> | null {
  return useSyncExternalStore(subscribe, () => names);
}
