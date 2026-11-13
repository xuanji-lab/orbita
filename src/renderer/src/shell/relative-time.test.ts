import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../messages-en.ts";
import { zh } from "../messages-zh.ts";
import { sessionAgeLabel } from "./relative-time.ts";

/** 本地时间构造，用例与运行机器的时区无关（跨午夜按本地日历日算） */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 7, 14, 50);
const label = (past: number, now: number = NOW): string => sessionAgeLabel(past, now, zh);

describe("sessionAgeLabel 的分钟 / 小时档", () => {
  it("不满 1 分钟与未来时间都是刚刚", () => {
    strictEqual(label(NOW), "刚刚");
    strictEqual(label(NOW - 59_999), "刚刚");
    strictEqual(label(NOW + 5 * 60_000), "刚刚");
  });

  it("1 分钟起写分钟，59 分钟仍是分钟（向下取整）", () => {
    strictEqual(label(NOW - 60_000), "1 分钟");
    strictEqual(label(NOW - 59 * 60_000 - 59_999), "59 分钟");
  });

  it("满 60 分钟起写小时，同一日历日内向下取整，23 小时仍是小时", () => {
    strictEqual(label(NOW - 60 * 60_000), "1 小时");
    strictEqual(label(NOW - 119 * 60_000), "1 小时");
    // 23:30 → 次日 22:50 隔了一个日历日，走昨天；这里取同日最远：00:10 → 23:59 = 23 小时
    strictEqual(label(at(2026, 11, 7, 0, 10), at(2026, 11, 7, 23, 59)), "23 小时");
  });
});

describe("sessionAgeLabel 的日历日档", () => {
  it("昨天跨午夜：昨晚 23:50 在 00:10 就已是昨天，哪怕只隔 20 分钟", () => {
    strictEqual(label(at(2026, 11, 6, 23, 50), at(2026, 11, 7, 0, 10)), "20 分钟");
    // 超过 1 小时才进日历日判定：23:50 → 次日 01:10 = 80 分钟，隔一个日历日
    strictEqual(label(at(2026, 11, 6, 23, 50), at(2026, 11, 7, 1, 10)), "昨天");
  });

  it("昨天可以是不满 24 小时，也可以是 30 小时前（只看日历日差）", () => {
    strictEqual(label(at(2026, 11, 6, 21, 40)), "昨天");
    strictEqual(label(at(2026, 11, 6, 0, 0)), "昨天");
  });

  it("隔 2–7 个日历日写 N 天，7 天是上界", () => {
    strictEqual(label(at(2026, 11, 5, 23, 59)), "2 天");
    strictEqual(label(at(2026, 11, 4, 8, 0)), "3 天");
    strictEqual(label(at(2026, 10, 31, 8, 0)), "7 天");
  });

  it("再早写 MM-DD", () => {
    strictEqual(label(at(2026, 10, 30, 23, 59)), "10-30");
    strictEqual(label(at(2026, 1, 2, 9, 0)), "01-02");
  });

  it("跨年写 YYYY-MM-DD，年初看年末的会话也是 N 天 / 昨天而不是日期", () => {
    strictEqual(label(at(2025, 12, 31, 10, 0)), "2025-12-31");
    strictEqual(label(at(2025, 12, 31, 22, 0), at(2026, 1, 1, 9, 0)), "昨天");
    strictEqual(label(at(2025, 12, 30, 22, 0), at(2026, 1, 2, 9, 0)), "3 天");
    strictEqual(label(at(2025, 12, 20, 22, 0), at(2026, 1, 2, 9, 0)), "2025-12-20");
  });
});

describe("sessionAgeLabel 的两种语言", () => {
  it("英文用缩写，日期仍是数字", () => {
    strictEqual(sessionAgeLabel(NOW - 5 * 60_000, NOW, en), "5m");
    strictEqual(sessionAgeLabel(NOW - 3 * 3_600_000, NOW, en), "3h");
    strictEqual(sessionAgeLabel(at(2026, 11, 6, 9, 0), NOW, en), "1d");
    strictEqual(sessionAgeLabel(at(2026, 11, 3, 9, 0), NOW, en), "4d");
    strictEqual(sessionAgeLabel(at(2026, 10, 1, 9, 0), NOW, en), "10-01");
    strictEqual(sessionAgeLabel(NOW, NOW, en), "now");
  });

  it("tooltip 的完整时间：今年不带年份，跨年带", () => {
    const thisYear = at(new Date().getFullYear(), 11, 6, 21, 40);
    strictEqual(zh.time.lastActiveAt(thisYear), "最后活动 11 月 6 日 21:40");
    strictEqual(en.time.lastActiveAt(thisYear), "Last active Nov 6, 21:40");
    strictEqual(zh.time.lastActiveAt(at(2020, 3, 5, 8, 9)), "最后活动 2020 年 3 月 5 日 08:09");
    strictEqual(en.time.lastActiveAt(at(2020, 3, 5, 8, 9)), "Last active Mar 5, 2020, 08:09");
  });
});
