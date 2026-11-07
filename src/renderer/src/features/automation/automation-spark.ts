/**
 * 自动化行右侧的「近 7 天小柱状图」的纯逻辑：按**本地时区自然日**把 runs 归日、取所有行共用的一把尺、算柱高。
 * 不 import React，node --test 直接加载。口径与 runCount 一致：skipped 没真跑，不计；running 算（已经开跑）。
 */
import type { Automation } from "../../../../shared/automation.ts";

/** 柱状图画几天（含今天） */
export const SPARK_DAYS = 7;
/** 单日最大次数的那根柱的满高（px） */
export const SPARK_FULL_PX = 18;
/** 跑过的天（含失败、正在跑）至少这么高：用户只关心「有没有跑」，次数只让特别多的那天稍高 */
export const SPARK_RAN_PX = 11;
/** 没跑的天：一道细线 */
export const SPARK_ZERO_PX = 2;

/**
 * 一天的画法：
 * - na：自动化创建之前，什么都不画（不是「没跑」）
 * - none：创建之后这天没跑，细线
 * - ran：跑过，实心
 * - failed：至少一次 error，红
 * - running：仅今天——有一条 running 且今天没有 error，空心描边；跑完变 ran
 */
export type SparkKind = "na" | "none" | "ran" | "failed" | "running";

export interface SparkDay {
  /** 当天 00:00（本地）的 epoch ms */
  dayStart: number;
  /** 当天真正跑的次数（不含 skipped，含 running） */
  count: number;
  /** 当天至少有一次失败 */
  failed: boolean;
  /** 当天有一条 running 的运行 */
  running: boolean;
  kind: SparkKind;
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

/** 本地自然日的 00:00 */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 一条自动化近 7 天每天的画法（旧 → 新）。早于第 7 天起点、或晚于 now 的运行不算。
 * 正在跑：今天有 running、且今天没有 error → running（即使今天已有完成的，再加一条在跑的也是「今天正在跑」，
 * 空心比实心多一个信息；红色优先，失败是要人看的）。非今天遗留的 running 当作跑过。
 * 创建日之前且没有任何运行的天 → na；有运行的天不隐藏（脏数据也不能把真实运行画没）。
 */
export function sparkDays(automation: Pick<Automation, "runs" | "createdAt">, now: number): SparkDay[] {
  const starts = sparkDayStarts(now);
  const createdDay = localDayStart(automation.createdAt);
  const days: SparkDay[] = starts.map((dayStart, index) => ({
    dayStart,
    count: 0,
    failed: false,
    running: false,
    kind: "none",
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
    if (run.status === "running") day.running = true;
  }
  for (const day of days) {
    if (day.failed) day.kind = "failed";
    else if (day.running && day.today) day.kind = "running";
    else if (day.count > 0) day.kind = "ran";
    else day.kind = day.dayStart < createdDay ? "na" : "none";
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

/**
 * 柱高（px）：na 不画（0）；没跑 = 细线；正在跑 = 跑过的底高；
 * 跑过的 = max(底高, 次数 / 尺子最大值 × 满高)——1 次碰上别人 8 次也不会被压成一道线。
 */
export function sparkBarHeight(day: Pick<SparkDay, "kind" | "count">, max: number): number {
  if (day.kind === "na") return 0;
  if (day.kind === "none") return SPARK_ZERO_PX;
  if (day.kind === "running" || max <= 0) return SPARK_RAN_PX;
  return Math.min(SPARK_FULL_PX, Math.max(SPARK_RAN_PX, Math.round((day.count / max) * SPARK_FULL_PX)));
}
