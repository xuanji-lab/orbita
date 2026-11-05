/**
 * 插件面板的两个数据钩子：右栏页签（哪些插件在当前工作区带面板）与单个面板的轮询。
 *
 * 轮询而不是主进程推送：agent 写数据通常是临时文件加 rename，单文件的 fs.watch 在 rename 后会丢句柄；
 * 数据目录可能还不存在；Windows / 网络盘上 watch 的行为也不一。面板**可见**时每 1.5 秒问主进程一次，
 * 带着上次的 stamp——没变主进程只做几次 stat 就回 unchanged，没有 watcher 要管生命周期。
 * 窗口隐藏时停，回到前台立刻补一次。
 */
import { useEffect, useState } from "react";
import type {
  PluginPanelData,
  PluginPanelDataProblem,
  PluginPanelInfo,
  PluginPanelProblem,
  PluginPanelTab,
  PluginPanelUnavailable,
} from "@shared/plugin-panel";
import { api } from "../../api";
import { reduceShownData, type ShownData } from "./panel-view.ts";

export const PANEL_POLL_MS = 1500;

export type PanelFeed =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: PluginPanelUnavailable; problems: PluginPanelProblem[] }
  | {
      kind: "ready";
      title: string;
      frameUrl: string;
      /** 换 iframe 的计数：key 一变整只 iframe 重建，里面的状态跟着清零 */
      frameKey: number;
      shown: PluginPanelData;
      problem: PluginPanelDataProblem | null;
    };

export function usePanelFeed(name: string, workspaceId: string | null): PanelFeed {
  const [feed, setFeed] = useState<PanelFeed>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inflight = false;
    let stamp: string | null = null;
    let lastGood: ShownData["lastGood"] = null;
    let frameUrl: string | null = null;
    let frameKey = 0;
    setFeed({ kind: "loading" });

    const run = async (): Promise<void> => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const snapshot = await api.plugin.panelLoad({ name, workspaceId, stamp });
        if (cancelled || snapshot.kind === "unchanged") return;
        stamp = snapshot.stamp;
        if (snapshot.kind === "unavailable") {
          frameUrl = null;
          lastGood = null;
          setFeed({ kind: "unavailable", reason: snapshot.reason, problems: snapshot.problems });
          return;
        }
        // frameUrl 非 null = 模板是新的（或第一次来）：换 iframe；null = 只更新数据
        if (snapshot.frameUrl !== null) {
          frameUrl = snapshot.frameUrl;
          frameKey += 1;
        }
        if (frameUrl === null) return;
        const next = reduceShownData(lastGood, snapshot.data);
        lastGood = next.lastGood;
        setFeed({ kind: "ready", title: snapshot.title, frameUrl, frameKey, shown: next.shown, problem: next.problem });
      } catch (cause) {
        // 读失败不清掉手里的面板：下一轮再试；只有从没读成功过才显示错误
        if (!cancelled) setFeed((current) => (current.kind === "ready" ? current : { kind: "error", message: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        inflight = false;
      }
    };
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        const next = document.visibilityState === "visible" ? run() : Promise.resolve();
        void next.then(() => {
          if (!cancelled) schedule();
        });
      }, PANEL_POLL_MS);
    };
    const wake = (): void => {
      if (document.visibilityState === "visible") void run();
    };
    void run().then(() => {
      if (!cancelled) schedule();
    });
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [name, workspaceId]);
  return feed;
}

/**
 * 右栏页签：当前工作区里已启用、带面板的插件。`revision` 变了就重读（插件页关掉后范围可能改过）；
 * 窗口回到前台也读一次（agent 可能刚在对话里建好了插件）。`loadedFor` 是这份结果对应的工作区——
 * 切会话那一拍它与当前不等，调用方据此不把「还没读完」当成「没有这个面板」。
 */
const NO_TABS: { tabs: PluginPanelTab[]; loadedFor: string | null | undefined } = { tabs: [], loadedFor: undefined };

export function usePluginPanelTabs(
  enabled: boolean,
  workspaceId: string | null,
  revision: unknown,
): { tabs: PluginPanelTab[]; loadedFor: string | null | undefined } {
  const [state, setState] = useState(NO_TABS);
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState(NO_TABS);
      return;
    }
    const load = (): void => {
      api.plugin
        .panelTabs(workspaceId)
        .then((tabs) => {
          if (!cancelled) setState({ tabs, loadedFor: workspaceId });
        })
        .catch((cause: unknown) => console.error("[plugin] 读面板页签失败", cause));
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [enabled, workspaceId, revision]);
  return state;
}

/** 详情页「面板」「最近产出」的数据：打开时读一次，之后窗口可见时每 4 秒读一次（看得到刚点的反馈、刚写的数据）。 */
export const PANEL_INFO_POLL_MS = 4000;

export function usePanelInfo(name: string | null, workspaceId: string | null): PluginPanelInfo | null | undefined {
  const [info, setInfo] = useState<PluginPanelInfo | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    // 旧技能 / 旧 MCP 不是真插件，没有面板：不问主进程
    if (name === null) {
      setInfo(null);
      return;
    }
    setInfo(undefined);
    const load = (): void => {
      api.plugin
        .panelInfo(name, workspaceId)
        .then((next) => {
          if (!cancelled) setInfo(next);
        })
        .catch((cause: unknown) => console.error("[plugin] 读面板信息失败", cause));
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, PANEL_INFO_POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [name, workspaceId]);
  return info;
}
