/**
 * 7 天用量格的派生数据 —— 纯函数，node --test 可直接加载。
 *
 * 抽出来是因为这几条规则会被争论（档位边界、往回数天、今天在哪端），
 * 争论的东西必须能单测（sidebar-fold.ts 同款先例）。
 *
 * 日期键与主进程账本同一份实现（shared/usage.ts 的 localDateKey，本地时区）——
 * 两边各写一份的话，跨午夜那一刻格子与账会对不上。
 */
import { localDateKey } from "../../../shared/usage.ts";

/** 档位：0 = 没用量（睡着），1/2/3 = 低 / 中 / 高 */
export type UsageTier = 0 | 1 | 2 | 3;

/** 一格的全部派生数据 */
export interface UsageCell {
  /** 本地日期键 YYYY-MM-DD（与账本同口径） */
  date: string;
  /** 星期索引：0 = 周一 … 6 = 周日（标签表按这个序） */
  weekday: number;
  isToday: boolean;
  tokens: number;
  tier: UsageTier;
}

/**
 * 档位：按「当天 / 7 天里最忙的一天」的比例——≤ 1/3 低，≤ 2/3 中，其余高；
 * 没用量是 0 档。max ≤ 0（整周没用量）时一律 0：没有参照系就没有档位。
 */
export function usageTier(tokens: number, max: number): UsageTier {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio <= 1 / 3) return 1;
  if (ratio <= 2 / 3) return 2;
  return 3;
}

/** Date → 周一基的星期索引（getDay 是周日基） */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * 从今天往回数 7 天（**右端是今天**），缺的天补 0。tier 以这 7 天的最大值为
 * 参照——「最近一周里忙不忙」而不是「绝对值多少」，换模型、换价目都不用调。
 */
export function usageWeekCells(now: Date, totals: ReadonlyMap<string, number>): UsageCell[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const keys: string[] = [];
  const raw: { date: string; weekday: number; isToday: boolean; tokens: number }[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const date = localDateKey(day.getTime());
    keys.push(date);
    raw.push({ date, weekday: weekdayIndex(day), isToday: back === 0, tokens: totals.get(date) ?? 0 });
  }
  const max = Math.max(...raw.map((cell) => cell.tokens));
  return raw.map((cell) => ({ ...cell, tier: usageTier(cell.tokens, max) }));
}

/** 日期键 → 悬停文案里的短日期 `10-08`（去年掉年份：格子本身就说的是「最近这周」） */
export function shortDate(dateKey: string): string {
  return dateKey.slice(5);
}

/** 能量体的 SVG 宽（viewBox 80×48，云心在正中） */
const PET_WIDTH = 80;

/**
 * 星云能量体的落位（返回 SVG 左缘）：**云心始终对准第 index 格的中心**（2026-10-12
 * 用户验收：按盒子夹取时云心落在周日与今天之间；按可见边缘右对齐又「偏、不舒服」——
 * 居中最稳）。最大的云可见半径约 20px、格子半宽 12px，两端各出界约 8px，落在侧栏
 * 12px 内边距里，不出侧栏；SVG overflow 可见，盒子出界无妨。
 */
export function petLeft(index: number): number {
  return index * 32 + 12 - PET_WIDTH / 2;
}
