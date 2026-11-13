import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { QUOTA_STALE_MS, quotaIsStale } from "./quota.ts";

describe("quotaIsStale —— 24h 以上的旧值不展示", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  test("刚取到、10 分钟前、24h 整：都还能展示", () => {
    assert.equal(quotaIsStale(now, now), false);
    assert.equal(quotaIsStale(now - 10 * 60_000, now), false);
    // 边界：正好 24h 不算过期（严格大于才是）
    assert.equal(quotaIsStale(now - QUOTA_STALE_MS, now), false);
  });

  test("24h 零 1 毫秒：过期", () => {
    assert.equal(quotaIsStale(now - QUOTA_STALE_MS - 1, now), true);
  });

  test("时间戳在未来（本机时钟回拨过）：不当成过期", () => {
    assert.equal(quotaIsStale(now + 60_000, now), false);
  });
});
