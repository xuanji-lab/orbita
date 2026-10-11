/**
 * 每日用量契约的纯函数测试（shared/usage.ts）。
 *
 * 重点钉两件事：
 *  1. **跨午夜切天**：同一 timestamp 在不同时区落到不同的日期键——账本按用户
 *     本地时区切天，测试必须能注入时区复现，不能赌跑测试的机器设的是哪个时区。
 *  2. **四项相加的口径**：缺席 / 非有限的分项按 0，不取 totalTokens。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dateKeysBack, localDateKey, usageTotalOf } from "./usage.ts";

/** 2026-10-08 16:00:00 UTC：上海已是 10-09 零点后，纽约还在 10-08 中午 */
const TS = Date.UTC(2026, 9, 8, 16, 0, 0);

describe("localDateKey —— 本地日期键", () => {
  test("同一时刻在不同时区切到不同的天", () => {
    assert.equal(localDateKey(TS, "UTC"), "2026-10-08");
    assert.equal(localDateKey(TS, "Asia/Shanghai"), "2026-10-09");
    assert.equal(localDateKey(TS, "America/New_York"), "2026-10-08");
  });

  test("本地零点整属于新的一天（跨午夜边界）", () => {
    const midnight = Date.UTC(2026, 9, 9, 0, 0, 0);
    assert.equal(localDateKey(midnight, "UTC"), "2026-10-09");
    assert.equal(localDateKey(midnight - 1, "UTC"), "2026-10-08");
    // 23:59:59.999 与 00:00:00.000 分属两天——这是账本切天的全部边界
    const shanghaiMidnight = Date.UTC(2026, 9, 8, 16, 0, 0);
    assert.equal(localDateKey(shanghaiMidnight - 1, "Asia/Shanghai"), "2026-10-08");
    assert.equal(localDateKey(shanghaiMidnight, "Asia/Shanghai"), "2026-10-09");
  });

  test("夏令时切换日也能切对（切日按本地日历，不按 86400000）", () => {
    // 美东 2026-11-01 凌晨回拨：这天只有 25 小时。切换点前后都该落在同一天
    assert.equal(localDateKey(Date.UTC(2026, 10, 1, 4, 0, 0), "America/New_York"), "2026-11-01");
    assert.equal(localDateKey(Date.UTC(2026, 10, 1, 9, 0, 0), "America/New_York"), "2026-11-01");
  });
});

describe("usageTotalOf —— 四项相加", () => {
  test("input + output + cacheRead + cacheWrite", () => {
    assert.equal(usageTotalOf({ input: 100, output: 20, cacheRead: 300, cacheWrite: 5 }), 425);
  });

  test("缺席的分项按 0", () => {
    assert.equal(usageTotalOf({}), 0);
    assert.equal(usageTotalOf({ input: 7 }), 7);
    assert.equal(usageTotalOf({ cacheWrite: 3 }), 3);
  });

  test("非有限的分项按 0，不把整本账打歪", () => {
    assert.equal(usageTotalOf({ input: Number.NaN, output: 10 }), 10);
    assert.equal(usageTotalOf({ input: Number.POSITIVE_INFINITY }), 0);
  });
});

describe("dateKeysBack —— 从今天往回数", () => {
  test("含今天、旧的在前，共 n 个键", () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    assert.deepEqual(dateKeysBack(7, now, "UTC"), [
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
    ]);
  });

  test("跨月也按本地日历回退", () => {
    const now = Date.UTC(2026, 9, 2, 23, 0, 0);
    assert.deepEqual(dateKeysBack(3, now, "UTC"), ["2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});
