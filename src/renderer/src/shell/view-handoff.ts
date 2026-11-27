/**
 * 换窗口材质时的视图交接（2026-11-27 用户：切进 / 切出液态玻璃后回到了首页，要停在原来那条会话）。
 *
 * 液态玻璃与不透明窗是建窗时定死的，切主题只能按原位置重开一扇新窗（main/index.ts 的
 * matchWindowMaterial）。新窗的渲染层从零起来，不知道旧窗刚才在看什么。
 *
 * 做法：每扇窗把「此刻在看什么」（开着的会话、设置 / 看板覆盖层、设置页签）随变随写进
 * localStorage——同一个应用的窗口共用它，写是同步的、很便宜；重开的新窗（preload 的
 * `reopened`，主进程只给重开的窗加参数）在第一次渲染时读一次，接上去。
 * 冷启动、Dock 重开不带那个参数，照旧落在首页——这里不做「启动时恢复上次的会话」。
 *
 * 为什么不走 IPC 问旧窗：主进程要在关旧窗前反向问渲染层、等回信再建新窗，多一条四层契约
 * 和一个超时分支；而两扇窗本来就共享 localStorage，旧窗随手写下的就是交接时的真值。
 */
import { SETTINGS_TABS, type SettingsTab } from "../features/settings/settings-tabs.ts";
import type { Overlay } from "./Sidebar.tsx";

export const VIEW_HANDOFF_KEY = "orbita:view-handoff";

export interface ViewHandoff {
  /** 主槽开着的会话；首页 / 新任务页是 null */
  sessionId: string | null;
  overlay: Overlay;
  settingsTab: SettingsTab;
}

/** localStorage 的最小接口（测试里给个 Map 套壳） */
export interface HandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function writeViewHandoff(storage: HandoffStorage, view: ViewHandoff): void {
  try {
    storage.setItem(VIEW_HANDOFF_KEY, JSON.stringify(view));
  } catch {
    // 存储满 / 被禁：交接只是锦上添花，写不进去就是回首页，不影响别的
  }
}

/** 读旧窗留下的视图。缺失、坏 JSON、字段不对一律回 null（新窗照旧落首页），不抛 */
export function readViewHandoff(storage: HandoffStorage): ViewHandoff | null {
  let raw: string | null;
  try {
    raw = storage.getItem(VIEW_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  const overlay = record.overlay;
  const settingsTab = record.settingsTab;
  if (sessionId !== null && (typeof sessionId !== "string" || sessionId === "")) return null;
  if (overlay !== null && overlay !== "settings" && overlay !== "board") return null;
  const tab = (SETTINGS_TABS as readonly { id: string }[]).some((def) => def.id === settingsTab)
    ? (settingsTab as SettingsTab)
    : "general";
  return { sessionId, overlay, settingsTab: tab };
}
