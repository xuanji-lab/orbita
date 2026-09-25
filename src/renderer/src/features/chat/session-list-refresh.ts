/**
 * renderer 手里那份会话列表（`session.sessions`）什么时候该从盘上重拉——事件泵
 * 每来一个 agent 事件问一次。列表是缓存，真值在主进程的 SessionStore；侧栏、
 * 右图标条的 Sub-sessions 入口、标题旁的子会话芯片都只读这份缓存。
 *
 * 四种情形：
 * - `phase idle`：一轮跑完，标题与 updatedAt 都变了。**哪条会话跑完都刷**，
 *   后台完成的会话侧栏也该亮起来。
 * - `title`：模型标题到了（主进程已落 meta），可能早于整轮结束，不等 idle。
 * - `model`：会话内模型切换成功（主进程已落 meta）。
 * - **列表里没有的会话发来 `phase`**：这条会话的 meta 不是 renderer 建的，
 *   renderer 也就没有「建完刷一次」的时机。今天的生产者是 delegate——主进程
 *   `applyDelegate` 先落子会话 meta 再开轮，只广播通道事件。漏掉这一条时，
 *   母会话这一轮没跑完之前子会话都不在列表里：通道列已经亮了（它每次现问
 *   主进程），Sub-sessions 入口却不出现，派出卡点开的面板也被立刻关掉
 *   （App 里「没有子会话就关面板」的守卫），2026-09-25 实测一整轮看不到子会话。
 *   meta 一定先于这个事件落盘：`applyDelegate` 里 `ensureSession` 在 `submitTurn`
 *   之前 await 完，`phase` 只在开轮之后才发。
 *
 * 纯判定，不 import React；`@shared` 只取类型（node --test 直接加载本文件）。
 */
import type { AgentEvent } from "@shared/agent-ipc";
import type { SessionMeta } from "@shared/session";

export function shouldRefreshSessions(event: AgentEvent, listed: readonly SessionMeta[]): boolean {
  if (event.type === "title" || event.type === "model") return true;
  if (event.type !== "phase") return false;
  return event.phase === "idle" || !listed.some((meta) => meta.id === event.sessionId);
}
