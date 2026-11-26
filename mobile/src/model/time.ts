/**
 * 行尾的「多久没动了」，与桌面 `sessionAgeLabel`（src/renderer/src/shell/relative-time.ts）同一口径：
 * 1 分钟内刚刚；1 小时内 N 分钟；同一日历日 N 小时；隔 1 个日历日昨天；2–7 天 N 天；更早写 MM-DD，
 * 跨年写 YYYY-MM-DD。桌面那份绑着 renderer 的文案表，这里照抄口径、用手机自己的文案。
 */
import { copy } from "../copy.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function calendarDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function ageLabel(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return copy.time.now;
  if (minutes < 60) return copy.time.minutes(minutes);
  const gap = calendarDay(now) - calendarDay(at);
  if (gap <= 0) return copy.time.hours(Math.floor(minutes / 60));
  if (gap === 1) return copy.time.yesterday;
  if (gap <= 7) return copy.time.days(gap);
  const date = new Date(at);
  const monthDay = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return date.getFullYear() === new Date(now).getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`;
}

/** 时:分（对话里用户消息下面的时间、断线时的「最后同步」） */
export function clockOf(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
