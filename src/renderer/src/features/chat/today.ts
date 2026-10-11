import { useEffect, useState } from "react";

/**
 * 「今天」：需要按本地日历日分档的显示用——首页红笔批语落当天日期（「阅 9.25」/
 * 「Sept 25」），聊天流里消息时间的「今天只写时分」口径（message-time.ts）。
 *
 * 过了午夜要自己翻篇——orbita 常开着不关，批语停在昨天、昨天的消息还写着犹如
 * 今天的时分，都是错的。useToday 在下一个本地午夜刷新一次；睡眠 / 合盖期间
 * 计时器会被推迟，所以窗口重新可见时也再对一次。
 */
export interface CalendarDay {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}

export function calendarDay(now: Date): CalendarDay {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * 距下一个本地午夜还有多少毫秒。**纯函数**。用「明天 0 点」的本地日期构造，不用
 * 「加 24 小时」——夏令时切换那天一天不是 24 小时。
 */
export function msUntilNextMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

export function useToday(): CalendarDay {
  const [today, setToday] = useState(() => calendarDay(new Date()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = new Date();
      const next = calendarDay(now);
      // 同一天不换对象：别让首页无谓重渲
      setToday((current) =>
        current.year === next.year && current.month === next.month && current.day === next.day
          ? current
          : next,
      );
      if (timer !== undefined) clearTimeout(timer);
      // 多等 1 秒再翻：计时器略早触发时还停在 23:59:59，会白跑一趟
      timer = setTimeout(refresh, msUntilNextMidnight(now) + 1000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return today;
}
