import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTA_HINT_FRESH_MS,
  QUOTA_STALE_MS,
  exhaustedWindowOf,
  quotaHintOf,
  quotaIsStale,
  type QuotaSnapshot,
  type QuotaWindow,
} from "./quota.ts";

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

// ── 额度用尽 → 失败提示（PR3） ──

const NOW = Date.UTC(2026, 9, 23, 9, 0, 0);
const HOUR = 60 * 60 * 1000;

const snapshot = (windows: QuotaWindow[], fetchedAt = NOW): QuotaSnapshot => ({ windows, fetchedAt });
const window = (overrides: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: "tokens_limit:3:5",
  label: "5-hour window",
  kind: "5h",
  usedPercent: 100,
  resetsAt: NOW + 2 * HOUR,
  ...overrides,
});

describe("exhaustedWindowOf —— 只认快照，不认厂商文案", () => {
  test("99.7% 命中（厂商会给小数，取 99 而不是 100）", () => {
    assert.equal(exhaustedWindowOf(snapshot([window({ usedPercent: 99.7 })]), NOW)?.id, "tokens_limit:3:5");
  });

  test("99% 整命中", () => {
    assert.notEqual(exhaustedWindowOf(snapshot([window({ usedPercent: 99 })]), NOW), null);
  });

  test("98% 不命中：还有余量，失败另有原因", () => {
    assert.equal(exhaustedWindowOf(snapshot([window({ usedPercent: 98 })]), NOW), null);
  });

  test("重置时刻已过去不命中：窗口本该续上了，报「N 后恢复」是假话", () => {
    assert.equal(exhaustedWindowOf(snapshot([window({ resetsAt: NOW - 1 })]), NOW), null);
    assert.equal(exhaustedWindowOf(snapshot([window({ resetsAt: NOW })]), NOW), null);
  });

  test("没有 resetsAt 不命中：不知道什么时候恢复，宁可不解释", () => {
    assert.equal(exhaustedWindowOf(snapshot([window({ resetsAt: undefined })]), NOW), null);
  });

  test("多窗口取第一个满的：周窗满而 5 小时窗没满", () => {
    const weekly = window({ id: "tokens_limit:6:1", label: "Weekly", kind: "weekly", usedPercent: 100 });
    const fiveHour = window({ id: "tokens_limit:3:5", usedPercent: 40 });
    assert.equal(exhaustedWindowOf(snapshot([fiveHour, weekly]), NOW)?.id, "tokens_limit:6:1");
  });

  test("空快照 / 只有余额：null", () => {
    assert.equal(exhaustedWindowOf(snapshot([]), NOW), null);
  });
});

describe("quotaHintOf —— 失败提示只认 5 分钟内的缓存", () => {
  test("刚取到的快照：给出 kind / label / resetsAt，不带任何拼好的句子", () => {
    assert.deepEqual(quotaHintOf(snapshot([window()]), NOW), {
      kind: "5h",
      label: "5-hour window",
      resetsAt: NOW + 2 * HOUR,
    });
  });

  test("缓存 5 分钟整仍可用；5 分零 1 毫秒过期（不为解释失败再发探测）", () => {
    assert.notEqual(quotaHintOf(snapshot([window()], NOW - QUOTA_HINT_FRESH_MS), NOW), null);
    assert.equal(quotaHintOf(snapshot([window()], NOW - QUOTA_HINT_FRESH_MS - 1), NOW), null);
  });

  test("没有缓存 / 窗口没满：null（照旧只显示厂商原文）", () => {
    assert.equal(quotaHintOf(null, NOW), null);
    assert.equal(quotaHintOf(snapshot([window({ usedPercent: 40 })]), NOW), null);
  });

  test("旧快照没有 kind：退 custom，名字留给厂商原文", () => {
    assert.deepEqual(quotaHintOf(snapshot([window({ kind: undefined })]), NOW), {
      kind: "custom",
      label: "5-hour window",
      resetsAt: NOW + 2 * HOUR,
    });
  });
});
