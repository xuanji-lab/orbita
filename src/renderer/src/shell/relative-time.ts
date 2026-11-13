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

/** 左栏时间范围筛选与行尾「多久没动了」共用的一天（毫秒）。窗口按滚动的 N×24 小时算，不按日历日 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地日历日的序号（只用来相减算「隔了几个日历日」；Date.UTC 不受夏令时的 23 / 25 小时日影响） */
function calendarDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 左栏会话行尾的「多久没动了」（按最后活动时间）：
 * - 1 分钟内 = 刚刚；1 小时内 = N 分钟（向下取整）
 * - 同一个日历日 = N 小时；**昨天 = 隔 1 个日历日**（所以昨晚 23:50 看，00:10 就已是「昨天」）
 * - 隔 2–7 个日历日 = N 天；更早写日期：MM-DD，跨年写 YYYY-MM-DD（语言无关的数字，不翻译）
 * 与 `relativeTime`（四舍五入、「…前」）是两套口径，互不影响；`now` 由调用方传入以便测试。
 * 未来时间（时钟漂移）按「刚刚」。
 */
export function sessionAgeLabel(at: number, now: number, t: Messages): string {
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return t.time.ageNow;
  if (minutes < 60) return t.time.ageMinutes(minutes);
  const dayGap = calendarDay(now) - calendarDay(at);
  if (dayGap <= 0) return t.time.ageHours(Math.floor(minutes / 60));
  if (dayGap === 1) return t.time.ageYesterday;
  if (dayGap <= 7) return t.time.ageDays(dayGap);
  const date = new Date(at);
  const monthDay = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return date.getFullYear() === new Date(now).getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`;
}
