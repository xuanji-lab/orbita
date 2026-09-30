/**
 * 右栏 Sub-sessions 面板列表层与父子会话通道卡的纯函数：一行 / 一卡的状态怎么算、
 * 全部行怎么排序。组件不测（仓库 renderer 组件无测试框架先例，channel-column.ts 同款
 * 做法）——逻辑抽出来落在这里测，`SubSessionsPanel.tsx` 只负责取数据、拼行、调这里的
 * 函数。
 *
 * 纯模块：不 import React、不 import `@shared/*` 的值（只用类型），可被
 * `node --test` 直接加载。
 */
import type { ChannelStatus } from "@shared/channel";

/**
 * 一行的显示状态（七档，字面对应设计裁决的颜色/图标分配）：
 *   running  = 子在跑（accent）
 *   waiting  = 通道状态 waiting，子问了、父还没回（warning，"waiting for you"）
 *   approval = 子会话在 renderer 会话槽里有未答的工具审批（warning，"needs approval"）——
 *     manual 档下每个工具都要批，用户往往不在看这条子会话，必须顶到审批之上单独一档
 *   stopped  = 通道状态 stopped，**用户**终止了这个子会话（tertiary，"stopped"）——
 *     用户的裁决压过审批 / 在跑这些瞬时态：停都停了，不该再引导用户去批一个死轮
 *   done     = 通道 closed 于 done（success）
 *   failed   = 通道 closed 于 failed（danger）
 *   idle     = 都不是（tertiary）——子会话建了但通道还没有除 task 外的往来，也没在跑
 */
export type SubSessionRowStatus =
  | "running"
  | "waiting"
  | "approval"
  | "done"
  | "failed"
  | "stopped"
  | "idle";

/**
 * 一行状态怎么定：**waiting 优先于 stopped，优先于 approval，优先于 running**——
 * waiting 与 stopped 同源（通道状态，互斥），摆在一起只是让检查顺序可读；stopped
 * 压过 approval / running 是用户裁决的语义：终止了就别再拿「待批 / 在跑」引导用户。
 * approval 又比单纯 running 紧迫——running 只是「知会」，approval 是「卡住了，等你」。
 * done/failed 只在不满足前者时才看（正常情况下 done/failed 的通道不会同时在跑或有
 * 待批审批，但状态机不为「不会发生」的组合留特判缺口，见 channelStatus 同款纪律）。
 */
export function subSessionRowStatus(input: {
  channelStatus: ChannelStatus | undefined;
  needsApproval: boolean;
  running: boolean;
}): SubSessionRowStatus {
  if (input.channelStatus === "waiting") return "waiting";
  if (input.channelStatus === "stopped") return "stopped";
  if (input.needsApproval) return "approval";
  if (input.running) return "running";
  if (input.channelStatus === "done") return "done";
  if (input.channelStatus === "failed") return "failed";
  return "idle";
}

/** 排序优先级：数字越小越靠前；done/failed/stopped/idle 同一档（终局，不需要用户
 * 再动手），靠原始顺序（派出顺序）分先后。注意与 subSessionRowStatus 的支配关系不是
 * 一回事：那一处说的是这一行自己标什么，这里说的是它排在哪里。 */
const STATUS_PRIORITY: Record<SubSessionRowStatus, number> = {
  waiting: 0,
  approval: 1,
  running: 2,
  done: 3,
  failed: 3,
  stopped: 3,
  idle: 3,
};

/**
 * 列表层的行排序（交接原话）：**waiting 最前，其次需要审批的，其次 running，
 * 其余按派出顺序**。`Array.prototype.sort` 是稳定排序（ES2019 起规范保证），
 * 调用方按派出顺序（`childSessions` 已经是创建时间正序）传入即可，同优先级
 * 的行不需要再传第二个 tiebreaker。stopped 归「其余」档：终止是终局，不需要
 * 用户再动手，不该还压在待办之上。
 */
export function sortSubSessionRows<T extends { status: SubSessionRowStatus }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
}

/**
 * `subSessionStatusOf` 从引擎读的两个槽的**最小结构面**——结构化而不是直接引用
 * `SessionEngine` 整型：本模块保持纯模块纪律（不 import useChatSession），
 * 测试拿字面量假对象就能喂，真实引擎天然满足这个形状。
 */
export interface SubSessionEngineSlots {
  /** 分槽状态里的审批槽：有未答审批 = approval 档 */
  states: ReadonlyMap<string, { approvals: readonly unknown[] }>;
  /** 会话 phase：非 idle = 这条会话此刻真的在跑 */
  phaseOf: (id: string) => string;
}

/**
 * 一行 / 一张通道卡的显示状态怎么取：通道摘要的 status + 引擎的审批槽与 phase，
 * 拼成 `subSessionRowStatus` 的输入。Sub-sessions 面板的行与父子会话面板的通道卡
 * **共用这一份 glue**，两处画出来的状态永远同源。
 *
 * 2026-10 bug 的直接教训：通道卡曾只看 channelStatus，而它的 "running" 语义是
 * 「通道开着」（子会话还没报 done/failed/question），跟子会话在不在跑无关——子会话
 * 这一轮跑完但没调 report_to_parent 时，面板已按 phase 画 idle，通道卡还在画
 * accent 呼吸的「运行中」。phase 必须参与推导，且只能从这一处参与。
 */
export function subSessionStatusOf(
  childId: string,
  channelStatus: ChannelStatus | undefined,
  engine: SubSessionEngineSlots,
): SubSessionRowStatus {
  return subSessionRowStatus({
    channelStatus,
    needsApproval: (engine.states.get(childId)?.approvals.length ?? 0) > 0,
    running: engine.phaseOf(childId) !== "idle",
  });
}
