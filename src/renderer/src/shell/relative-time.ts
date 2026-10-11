import type { Messages } from "../messages-en.ts";

/**
 * 相对时间的最简口径（「刚刚 / N 分钟前 / N 小时前 / N 天前」）：侧栏的抽屉选择器
 * 与 Sub-sessions 收件箱行共用，不引入第二个日期库。时间在渲染时现算——不监听
 * 时钟，列表因别的理由重渲染时自然纠正。
 */
export function relativeTime(at: number, t: Messages): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return t.time.justNow;
  if (minutes < 60) return t.time.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t.time.hoursAgo(hours);
  return t.time.daysAgo(Math.round(hours / 24));
}
