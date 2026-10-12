/**
 * 消息时间的显示口径 —— 聊天流里「这条消息是什么时候发的」。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载（口径会被争论，
 * 争论的东西必须能单测——同 stats-format.ts 的规矩）。
 *
 * 显示档位（用户裁决 2026-10-12）：今天的只写时分（`14:32`）；更早的补月日
 * （`10-11 14:32`）；不是今年的连年份一起（`2025-10-11 14:32`）。悬停 title
 * 给全量（含秒与星期几）。字体 / 颜色与「用时」那行同一套灰色小字 token。
 */

/** 本地日历日（与 today.ts 的 CalendarDay 同形，这里只读不造） */
export interface CalendarStamp {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}

export function calendarStamp(at: number | Date): CalendarStamp {
  const date = at instanceof Date ? at : new Date(at);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * 气泡旁 / 轮头上的短标签。`today` 传当前的本地日历日（跨午夜要翻档，
 * 组件侧用 useToday 供这个真值）；时间非法（缺 timestamp 的旧记录）返回空串，
 * 调用方据此不渲染。
 */
export function formatMessageTime(sentAt: number, today: CalendarStamp): string {
  if (!Number.isFinite(sentAt)) return "";
  const stamp = calendarStamp(sentAt);
  const hm = clock(sentAt);
  if (stamp.year === today.year && stamp.month === today.month && stamp.day === today.day) {
    return hm;
  }
  const monthDay = `${two(stamp.month)}-${two(stamp.day)}`;
  return stamp.year === today.year ? `${monthDay} ${hm}` : `${stamp.year}-${monthDay} ${hm}`;
}

/**
 * 悬停 title 的全量时间：`2026-10-12 02:31:59 周日`。星期名由调用方给
 * （messages 表里的 timeWeekdays，getDay() 序、周日打头），保持中英一致的可译面。
 */
export function fullTimestamp(sentAt: number, weekdays: readonly string[]): string {
  if (!Number.isFinite(sentAt)) return "";
  const date = new Date(sentAt);
  const stamp = calendarStamp(sentAt);
  const weekday = weekdays[date.getDay()] ?? "";
  return (
    `${stamp.year}-${two(stamp.month)}-${two(stamp.day)} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}` +
    (weekday === "" ? "" : ` ${weekday}`)
  );
}
