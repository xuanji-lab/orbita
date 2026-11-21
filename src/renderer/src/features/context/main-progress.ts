/**
 * 主智能体进度面板的纯推导（2026-11-21）。侧栏工作区下面不再列子行之后，旧会话从进度面板「以前的会话」找回。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { SessionMeta } from "@shared/session";

/**
 * 这个工作区里用户以前自己开的会话：根会话、没归档、不是主智能体本身；自动化开出的只在转成普通会话后才算
 * （与 workspace-rows.ts 的根会话同口径）。主智能体派出去的活不在这里——它们在「各件活」。最近动过的在前。
 */
export function mainAgentEarlier(sessions: readonly SessionMeta[], workspaceId: string): SessionMeta[] {
  return sessions
    .filter(
      (meta) =>
        meta.workspaceId === workspaceId &&
        !meta.archived &&
        meta.role !== "main" &&
        meta.parentId === undefined &&
        (meta.automationId === undefined || meta.promoted === true),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 「全部以前的会话」：右栏进度面板 → 侧栏里现有的「以前的会话」那一页（搜索与筛选都在那里）。
 * 那一页的开关是 Sidebar 自己的页内状态，用一个窗口事件递过去（同 REVEAL_ENTRY_EVENT 的做法），不为它把状态提到 App。
 */
export const OPEN_EARLIER_EVENT = "orbita:open-earlier-sessions";

export function openEarlierSessions(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EARLIER_EVENT, { detail: workspaceId }));
}

/**
 * 「等你」先露几件（每件带三行摘要，再多就把目标与计划挤出一屏）；其余折成「还有 N 件等你」，点开全露。
 * 排序已是最急、最新的在前（sortSubSessionRows），这里只切。
 */
export const WAITING_SHOWN = 3;

export function splitWaiting<T>(asks: readonly T[], limit: number = WAITING_SHOWN): { rows: T[]; folded: T[] } {
  return { rows: asks.slice(0, limit), folded: asks.slice(limit) };
}

/**
 * 折叠行在收起 / 展开两态写什么：「等你」展开后不能还写「还有 N 件等你」（那几件已经露出来了），改写「收起」、箭头朝上；
 * 没给展开态文案的（「做完 N 件 · 停着 M 件」这种组名）两态同一句，箭头朝下表示已展开。
 */
export function foldToggle(
  open: boolean,
  closedLabel: string,
  openLabel: string | undefined,
): { label: string; icon: "chevron-right" | "chevron-down" | "chevron-up" } {
  if (!open) return { label: closedLabel, icon: "chevron-right" };
  return openLabel === undefined ? { label: closedLabel, icon: "chevron-down" } : { label: openLabel, icon: "chevron-up" };
}
