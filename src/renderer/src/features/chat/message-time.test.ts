/**
 * 消息时间显示口径的测试：今天 / 昨天（跨午夜）/ 今年 / 跨年 / 非法 timestamp。
 * 全部用本地时区构造（与 renderer 的 Date 行为同源），跨午夜边界用
 * msUntilNextMidnight 推「明天 0 点」而不是加 24 小时（夏令时那天不是 24 小时）。
 */
import { strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { formatMessageTime, fullTimestamp, calendarStamp } from "./message-time.ts";
import { msUntilNextMidnight } from "./today.ts";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

describe("formatMessageTime", () => {
  test("今天：只写时分", () => {
    const now = new Date(2026, 9, 12, 15, 0, 0);
    strictEqual(formatMessageTime(new Date(2026, 9, 12, 14, 32, 5).getTime(), calendarStamp(now)), "14:32");
  });

  test("昨天（跨午夜）：补月日", () => {
    const now = new Date(2026, 9, 12, 0, 5, 0); // 12 号凌晨
    strictEqual(formatMessageTime(new Date(2026, 9, 11, 23, 59, 0).getTime(), calendarStamp(now)), "10-11 23:59");
  });

  test("午夜整点翻档：23:59:59.999 还是昨天，0:00 起是今天", () => {
    const eve = new Date(2026, 9, 11, 23, 59, 59, 999);
    const midnight = eve.getTime() + 1;
    const today = calendarStamp(new Date(midnight));
    strictEqual(formatMessageTime(eve.getTime(), today), "10-11 23:59");
    strictEqual(formatMessageTime(midnight, today), "00:00");
  });

  test("今年更早的日期：补月日不带年", () => {
    const now = new Date(2026, 9, 12, 15, 0, 0);
    strictEqual(formatMessageTime(new Date(2026, 2, 1, 9, 5, 0).getTime(), calendarStamp(now)), "03-01 09:05");
  });

  test("往年：连年份一起", () => {
    const now = new Date(2026, 0, 2, 15, 0, 0);
    strictEqual(formatMessageTime(new Date(2025, 11, 31, 18, 0, 0).getTime(), calendarStamp(now)), "2025-12-31 18:00");
  });

  test("跨年边界：去年 12-31 与今年 1-1 只差一秒，档位不同", () => {
    const newYear = new Date(2027, 0, 1, 0, 0, 0).getTime();
    const today = calendarStamp(new Date(newYear));
    strictEqual(formatMessageTime(newYear - 1000, today), "2026-12-31 23:59");
    strictEqual(formatMessageTime(newYear, today), "00:00");
  });

  test("夏令时切换日：用日历日推「明天」，不受 23/25 小时天影响", () => {
    // 美式夏令时 2026-03-08 02:00 跳到 03:00（本地时区不是美式时也能测：
    // msUntilNextMidnight 是纯日历运算，这里只验证口径本身自洽）
    const lateNight = new Date(2026, 2, 8, 23, 30, 0);
    const tomorrow = new Date(lateNight.getTime() + msUntilNextMidnight(lateNight));
    strictEqual(formatMessageTime(lateNight.getTime(), calendarStamp(tomorrow)), "03-08 23:30");
  });

  test("非法 timestamp：空串（调用方不渲染）", () => {
    strictEqual(formatMessageTime(Number.NaN, { year: 2026, month: 10, day: 12 }), "");
  });
});

describe("fullTimestamp", () => {
  test("含秒与星期，零填充", () => {
    strictEqual(fullTimestamp(new Date(2026, 9, 12, 2, 31, 5).getTime(), WEEKDAYS), "2026-10-12 02:31:05 周一");
    // 2026-10-12 是周一；周日打头验证 getDay 序
    strictEqual(fullTimestamp(new Date(2026, 9, 11, 23, 0, 0).getTime(), WEEKDAYS), "2026-10-11 23:00:00 周日");
  });

  test("星期表缺项时不留尾空格；非法 timestamp 空串", () => {
    strictEqual(fullTimestamp(new Date(2026, 9, 12, 2, 31, 5).getTime(), []), "2026-10-12 02:31:05");
    strictEqual(fullTimestamp(Number.NaN, WEEKDAYS), "");
  });
});
