import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calendarDay, msUntilNextMidnight } from "./today.ts";

describe("calendarDay", () => {
  test("月份从 1 数起", () => {
    assert.deepEqual(calendarDay(new Date(2026, 8, 25, 13, 45)), { month: 9, day: 25 });
    assert.deepEqual(calendarDay(new Date(2026, 0, 1, 0, 0)), { month: 1, day: 1 });
  });
});

describe("msUntilNextMidnight", () => {
  test("下午到当晚午夜", () => {
    const now = new Date(2026, 8, 25, 13, 45, 0, 0);
    assert.equal(msUntilNextMidnight(now), (10 * 60 + 15) * 60 * 1000);
  });

  test("午夜整点：等满一天，不是 0", () => {
    const now = new Date(2026, 8, 25, 0, 0, 0, 0);
    const next = new Date(2026, 8, 26, 0, 0, 0, 0);
    assert.equal(msUntilNextMidnight(now), next.getTime() - now.getTime());
  });

  test("跨月、跨年", () => {
    assert.equal(calendarDay(new Date(new Date(2026, 8, 30, 23, 0).getTime() + msUntilNextMidnight(new Date(2026, 8, 30, 23, 0)))).month, 10);
    const eve = new Date(2026, 11, 31, 23, 59, 30);
    const after = new Date(eve.getTime() + msUntilNextMidnight(eve));
    assert.deepEqual([after.getFullYear(), after.getMonth(), after.getDate(), after.getHours()], [2027, 0, 1, 0]);
  });
});
