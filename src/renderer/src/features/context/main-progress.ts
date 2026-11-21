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
