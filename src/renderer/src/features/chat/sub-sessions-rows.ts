/**
 * 右栏 Sub-sessions 面板列表层的纯函数：一行的状态怎么算、全部行怎么排序。
 * 组件不测（仓库 renderer 组件无测试框架先例，channel-column.ts 同款做法）——
 * 逻辑抽出来落在这里测，`SubSessionsPanel.tsx` 只负责取数据、拼行、调这两个函数。
 *
 * 纯模块：不 import React、不 import `@shared/*` 的值（只用类型），可被
 * `node --test` 直接加载。
 */
import type { ChannelStatus } from "@shared/channel";

/**
 * 一行的显示状态（六档，字面对应设计裁决的颜色/图标分配）：
 *   running  = 子在跑（accent）
 *   waiting  = 通道状态 waiting，子问了、父还没回（warning，"waiting for you"）
 *   approval = 子会话在 renderer 会话槽里有未答的工具审批（warning，"needs approval"）——
 *     manual 档下每个工具都要批，用户往往不在看这条子会话，必须顶到审批之上单独一档
 *   done     = 通道 closed 于 done（success）
 *   failed   = 通道 closed 于 failed（danger）
 *   idle     = 都不是（tertiary）——子会话建了但通道还没有除 task 外的往来，也没在跑
 */
export type SubSessionRowStatus = "running" | "waiting" | "approval" | "done" | "failed" | "idle";

/**
 * 一行状态怎么定：**waiting 优先于 approval，优先于 running**——一个用户此刻唯一
 * 需要动手的信号（子在等父答复）比「子会话里有个工具要批」更紧迫；approval 又比单纯
 * running 紧迫——running 只是「知会」，approval 是「卡住了，等你」。done/failed 只在
 * 不满足前三者时才看（正常情况下 done/failed 的通道不会同时在跑或有待批审批，但状态机
 * 不为「不会发生」的组合留特判缺口，见 channelStatus 同款纪律）。
 */
export function subSessionRowStatus(input: {
  channelStatus: ChannelStatus | undefined;
  needsApproval: boolean;
  running: boolean;
}): SubSessionRowStatus {
  if (input.channelStatus === "waiting") return "waiting";
  if (input.needsApproval) return "approval";
  if (input.running) return "running";
  if (input.channelStatus === "done") return "done";
  if (input.channelStatus === "failed") return "failed";
  return "idle";
}

/** 排序优先级：数字越小越靠前；done/failed/idle 同一档，靠原始顺序（派出顺序）分先后。 */
const STATUS_PRIORITY: Record<SubSessionRowStatus, number> = {
  waiting: 0,
  approval: 1,
  running: 2,
  done: 3,
  failed: 3,
  idle: 3,
};

/**
 * 列表层的行排序（交接原话）：**waiting 最前，其次需要审批的，其次 running，
 * 其余按派出顺序**。`Array.prototype.sort` 是稳定排序（ES2019 起规范保证），
 * 调用方按派出顺序（`childSessions` 已经是创建时间正序）传入即可，同优先级
 * 的行不需要再传第二个 tiebreaker。
 */
export function sortSubSessionRows<T extends { status: SubSessionRowStatus }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
}
