/**
 * bash 活行的状态通路（renderer 这一侧）—— 一个会话一份快照 + 一条 2s 轮询。
 *
 * **为什么是轮询而不是事件推送**：交还（detach）发生在工具调用**已经返回**之后，
 * 那之后进程的输出不再进转录，内核也没有「某个后台命令刚结束」这类事件可搭车。
 * 走推送就得在 agent 侧新造一条状态推送链，还要自己管订阅、重连与重放；而活行
 * 只活在一小段时间里、同一时刻最多几条，2s 拉一份几十字节的列表更省，也不会有
 * 「事件丢了界面就永远停在运行中」的形态。
 *
 * **为什么按会话共享一份而不是每行一条**：同一会话里可能同时挂着 b1 / b3 两条活行，
 * 逐行轮询会把同一份列表拉两遍。这里按 owner（会话 id）去重，谁还需要就登记一个
 * watcher；最后一个 watcher 走掉，轮询整个停下——**没有活行就完全不轮询**。
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../../api";
import type { BashSessionStatus } from "@shared/bash-session";
import { bashNeedsPolling } from "./tool-results.ts";

const POLL_INTERVAL_MS = 2_000;

/** 某一会话最近一拍的结果。`at` 既是「这份快照多新」，也是秒针外推的基准 */
export interface BashOwnerSnapshot {
  at: number;
  sessions: ReadonlyMap<string, BashSessionStatus>;
}

const snapshots = new Map<string, BashOwnerSnapshot>();
/** owner → 还在等它的行数。0 时不删快照：落定的行要靠它显示结果词 */
const watchers = new Map<string, number>();
const listeners = new Set<() => void>();
let timer: number | null = null;
let polling = false;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function put(owner: string, sessions: readonly BashSessionStatus[]): void {
  const map = new Map<string, BashSessionStatus>();
  for (const session of sessions) map.set(session.id, session);
  snapshots.set(owner, { at: Date.now(), sessions: map });
  notify();
}

async function pollOwner(owner: string): Promise<void> {
  try {
    const sessions = await api.agent.bashSessions(owner);
    // 回来时可能已经没人等它了（切走会话 / 行已落定）：丢掉，不留一份没人认领的快照
    if (!watchers.has(owner)) return;
    put(owner, sessions);
  } catch {
    // 一拍失败不吵人：agent 进程在重启、会话刚被删都是常态，下一拍照旧。
    // 界面保持上一拍的事实（不许把它画成「已结束」——那是撒谎）。
  }
}

async function tick(): Promise<void> {
  if (polling) return; // 上一拍还没回来就跳过这一拍，不在网络上叠请求
  polling = true;
  try {
    await Promise.all([...watchers.keys()].map((owner) => pollOwner(owner)));
  } finally {
    polling = false;
  }
}

/** 登记一个「有人要看这个会话的后台命令」的 watcher（返回退订函数） */
export function watchBashOwner(owner: string): () => void {
  if (owner === "") return () => undefined;
  watchers.set(owner, (watchers.get(owner) ?? 0) + 1);
  // 首拍立刻发：从旧会话切回来时不该先空等 2s 才看到真状态
  if (watchers.get(owner) === 1) void pollOwner(owner);
  if (timer === null) timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
  return () => {
    const left = (watchers.get(owner) ?? 1) - 1;
    if (left > 0) {
      watchers.set(owner, left);
      return;
    }
    watchers.delete(owner);
    if (watchers.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** 停止钮的回执直接进快照：按完立刻看到「已停止」，不必等下一拍 */
export function applyBashSessions(owner: string, sessions: readonly BashSessionStatus[]): void {
  put(owner, sessions);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshotOf(owner: string): BashOwnerSnapshot | undefined {
  return snapshots.get(owner);
}

/**
 * 一行的订阅：给出它自己那条会话的最新状态，并在「还该等」时打开轮询。
 *
 * `bashNeedsPolling` 在 tool-results.ts（纯函数、有测试）：落定 / 快照里已经没有它
 * 的行不再登记 watcher，也就不再为一个早就死掉的 id 每 2s 敲一次 agent 进程。
 */
export function useBashLive(
  owner: string,
  bashId: string | null,
  resultAt: number,
): BashOwnerSnapshot & { status: BashSessionStatus | undefined } {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => snapshotOf(owner),
    () => undefined,
  );
  const status = bashId === null ? undefined : snapshot?.sessions.get(bashId);
  const polling = bashId !== null && bashNeedsPolling(snapshot?.at, resultAt, status);
  // 订阅挂在 effect 里：渲染期不许有副作用（拉请求会被 StrictMode 跑两遍）
  useEffect(() => {
    if (!polling) return;
    return watchBashOwner(owner);
  }, [owner, polling]);
  return { at: snapshot?.at ?? 0, sessions: snapshot?.sessions ?? EMPTY, status };
}

const EMPTY: ReadonlyMap<string, BashSessionStatus> = new Map();
