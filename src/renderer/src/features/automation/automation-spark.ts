/**
 * 自动化行右侧的「近 7 天小柱状图」的纯逻辑：按**本地时区自然日**把 runs 归日、取所有行共用的一把尺、算柱高。
 * 不 import React，node --test 直接加载。口径与 runCount 一致：skipped 没真跑，不计；running 算（已经开跑）。
 */
import type { Automation } from "../../../../shared/automation.ts";

/** 柱状图画几天（含今天） */
export const SPARK_DAYS = 7;
/** 单日最大次数的那根柱的满高（px） */
export const SPARK_FULL_PX = 18;
/** 跑过的天至少这么高：1 次碰上别人 8 次也要看得见 */
export const SPARK_MIN_PX = 3;
/** 没跑的天：一道细线 */
export const SPARK_ZERO_PX = 2;

export interface SparkDay {
  /** 当天 00:00（本地）的 epoch ms */
  dayStart: number;
  /** 当天真正跑的次数（不含 skipped） */
  count: number;
  /** 当天至少有一次失败 */
  failed: boolean;
  today: boolean;
}

/** 近 SPARK_DAYS 个本地自然日的起点，旧 → 新，最后一个是 now 所在那天。用日期构造而不是减 24h：夏令时当天不错位 */
export function sparkDayStarts(now: number): number[] {
  const base = new Date(now);
  const starts: number[] = [];
  for (let back = SPARK_DAYS - 1; back >= 0; back -= 1) {
    starts.push(new Date(base.getFullYear(), base.getMonth(), base.getDate() - back).getTime());
  }
  return starts;
}

/** 一条自动化近 7 天每天的次数（旧 → 新）。早于第 7 天起点、或晚于 now 的运行不算 */
export function sparkDays(automation: Pick<Automation, "runs">, now: number): SparkDay[] {
  const starts = sparkDayStarts(now);
  const days: SparkDay[] = starts.map((dayStart, index) => ({
    dayStart,
    count: 0,
    failed: false,
    today: index === starts.length - 1,
  }));
  const oldest = days[0]?.dayStart ?? now;
  for (const run of automation.runs) {
    if (run.status === "skipped" || run.runAt < oldest || run.runAt > now) continue;
    // 从今天往回找第一个起点 <= runAt 的那天
    const day = [...days].reverse().find((candidate) => run.runAt >= candidate.dayStart);
    if (day === undefined) continue;
    day.count += 1;
    if (run.status === "error") day.failed = true;
  }
  return days;
}

/** 一次性任务只写累计，不画图 */
export function showsSpark(automation: Pick<Automation, "schedule">): boolean {
  return automation.schedule.kind !== "once";
}

/**
 * 共用的一把尺：列表里所有要画图的自动化 × 近 7 天的单日最大次数。滑出 7 天的那天自然不再算。
 * 全是 0 返回 0（柱高函数据此全画细线）。
 */
export function sparkScale(automations: readonly Automation[], now: number): number {
  let max = 0;
  for (const automation of automations) {
    if (!showsSpark(automation)) continue;
    for (const day of sparkDays(automation, now)) if (day.count > max) max = day.count;
  }
  return max;
}

/** 柱高（px）：没跑 = 细线；跑过的按 次数 / max × 满高，至少 SPARK_MIN_PX */
export function sparkBarHeight(count: number, max: number): number {
  if (count <= 0 || max <= 0) return SPARK_ZERO_PX;
  return Math.min(SPARK_FULL_PX, Math.max(SPARK_MIN_PX, Math.round((count / max) * SPARK_FULL_PX)));
}
