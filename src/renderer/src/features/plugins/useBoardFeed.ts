/**
 * 看板的数据钩子：一块看板（已装的插件，或工作区里还没安装的草稿）的轮询，和草稿的扫描轮询。
 *
 * 轮询而不是主进程推送：agent 写数据通常是临时文件加 rename，单文件的 fs.watch 在 rename 后会丢句柄；
 * 数据目录可能还不存在；Windows / 网络盘上 watch 的行为也不一。看板**可见**时每 1.5 秒问主进程一次，
 * 带着上次的 stamp——没变主进程只做几次 stat 就回 unchanged，没有 watcher 要管生命周期。
 * 窗口隐藏时停，回到前台立刻补一次。
 */
import { useEffect, useRef, useState } from "react";
import type { PluginView } from "@shared/plugin";
import type { PluginBoardSnapshot, PluginPanelProblem, PluginPanelUnavailable } from "@shared/plugin-panel";
import { api } from "../../api";
import { mergeBoardCards, type BoardCardView, type CardMemory } from "./board-card.ts";

export const BOARD_POLL_MS = 1500;

/**
 * 看哪一块看板：已装的插件（按名字，范围由主进程查）或工作区里还没安装的草稿文件夹（按路径，
 * 主进程校验它在该工作区根内）。两种走各自的 IPC，快照同形，后面的轮询与渲染一份代码。
 */
export type BoardTarget =
  | { kind: "installed"; name: string; workspaceId: string | null }
  | { kind: "draft"; path: string; workspaceId: string | null };

export function boardTargetKey(target: BoardTarget): string {
  return `${target.kind}\u0000${target.kind === "installed" ? target.name : target.path}\u0000${target.workspaceId ?? ""}`;
}

export type BoardFeed =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: PluginPanelUnavailable; problems: PluginPanelProblem[] }
  | {
      kind: "ready";
      title: string;
      /** 看板说明 markdown 原文；没有为 null */
      spec: string | null;
      cards: BoardCardView[];
      /** 看板级的问题（说明读不出来、repeat 不是数组、超限） */
      problems: PluginPanelProblem[];
    };

function loadSnapshot(target: BoardTarget, stamp: string | null): Promise<PluginBoardSnapshot> {
  return target.kind === "installed"
    ? api.plugin.boardLoad({ name: target.name, workspaceId: target.workspaceId, stamp })
    : api.plugin.draftBoardLoad({ path: target.path, workspaceId: target.workspaceId, stamp });
}

/** 可见时按固定间隔跑 `run`（上一次没回来不叠）；窗口隐藏停，回到前台立刻补一次。返回清理函数。 */
function startPolling(run: () => Promise<void>, intervalMs: number): () => void {
  let cancelled = false;
  let timer: number | undefined;
  const schedule = (): void => {
    timer = window.setTimeout(() => {
      const next = document.visibilityState === "visible" ? run() : Promise.resolve();
      void next.then(() => {
        if (!cancelled) schedule();
      });
    }, intervalMs);
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
}

export function useBoardFeed(target: BoardTarget): BoardFeed {
  const [feed, setFeed] = useState<BoardFeed>({ kind: "loading" });
  const key = boardTargetKey(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    let stamp: string | null = null;
    let memory = new Map<string, CardMemory>();
    let frameCounter = 0;
    setFeed({ kind: "loading" });
    const run = async (): Promise<void> => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const snapshot = await loadSnapshot(targetRef.current, stamp);
        if (cancelled || snapshot.kind === "unchanged") return;
        stamp = snapshot.stamp;
        if (snapshot.kind === "unavailable") {
          memory = new Map();
          setFeed({ kind: "unavailable", reason: snapshot.reason, problems: snapshot.problems });
          return;
        }
        const merged = mergeBoardCards(memory, snapshot.cards, () => (frameCounter += 1));
        memory = merged.memory;
        setFeed({ kind: "ready", title: snapshot.title, spec: snapshot.spec, cards: merged.views, problems: snapshot.problems });
      } catch (cause) {
        // 读失败不清掉手里的看板：下一轮再试；只有从没读成功过才显示错误
        if (!cancelled) setFeed((current) => (current.kind === "ready" ? current : { kind: "error", message: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        inflight = false;
      }
    };
    const stop = startPolling(run, BOARD_POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [key]);
  return feed;
}

/** 草稿扫描轮询的间隔（比看板的数据轮询慢一点：每次是一整份扫描，不只是 stat）。 */
export const DRAFT_POLL_MS = 2000;

export type DraftScan =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: "not-found" | "outside-workspace" }
  | { kind: "ready"; view: PluginView };

/** 草稿（还没安装的插件文件夹）的扫描：一张与已装页同形的视图，文件一改几秒内跟着变。 */
export function useDraftScan(path: string, workspaceId: string | null): DraftScan {
  const [scan, setScan] = useState<DraftScan>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    let stamp: string | null = null;
    setScan({ kind: "loading" });
    const run = async (): Promise<void> => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const snapshot = await api.plugin.draftLoad({ path, workspaceId, stamp });
        if (cancelled || snapshot.kind === "unchanged") return;
        stamp = snapshot.stamp;
        setScan(snapshot.kind === "ready" ? { kind: "ready", view: snapshot.view } : { kind: "unavailable", reason: snapshot.reason });
      } catch (cause) {
        if (!cancelled) setScan((current) => (current.kind === "ready" ? current : { kind: "error", message: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        inflight = false;
      }
    };
    const stop = startPolling(run, DRAFT_POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [path, workspaceId]);
  return scan;
}
