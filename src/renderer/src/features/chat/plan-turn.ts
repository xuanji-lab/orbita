/**
 * 这一轮开头那张计划卡（PlanTurnCard.tsx）出不出、出哪种：纯推导，可被 node --test 直接加载。
 * 只打勾不出卡（勾在过程里是一行「改计划」，全貌在右栏「进度」）。
 */
import type { PlanNotice, PlanTimeline, PlanVersion } from "../context/plan-timeline.ts";

export type PlanTurnState = { kind: "fresh"; version: PlanVersion } | { kind: "changed"; notice: PlanNotice; version: PlanVersion };

/** 这一块里的 update_plan 调用让计划发生了什么：第一次定下 / 改了结构 / 只打勾（null） */
export function planTurnState(timeline: PlanTimeline | null, notice: PlanNotice | null, toolCallIds: readonly string[]): PlanTurnState | null {
  if (timeline === null || toolCallIds.length === 0) return null;
  const wanted = new Set(toolCallIds);
  const mine = timeline.versions.filter((version) => wanted.has(version.toolCallId));
  const last = mine.at(-1);
  if (last === undefined) return null;
  if (mine.some((version) => version.n === 1)) return { kind: "fresh", version: last };
  if (notice !== null) return { kind: "changed", notice, version: last };
  return null;
}

