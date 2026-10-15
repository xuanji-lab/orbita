import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryBackfillStatus } from "../../../../shared/memory.ts";
import { backfillProgress, backfillView, tokenMagnitude } from "./memory-backfill.ts";

const status = (extra: Partial<MemoryBackfillStatus> = {}): MemoryBackfillStatus => ({
  state: "idle",
  range: null,
  totalSessions: 0,
  doneSessions: 0,
  totalTurns: 0,
  doneTurns: 0,
  newEntries: 0,
  replaced: 0,
  failedTurns: 0,
  startedAt: null,
  updatedAt: null,
  ...extra,
});

describe("backfillView", () => {
  test("在跑或暂停时总是进度条，不管卡片开没开", () => {
    assert.equal(backfillView(status({ state: "running" }), false, false), "progress");
    assert.equal(backfillView(status({ state: "paused" }), true, false), "progress");
  });

  test("没任务时：开卡 = setup，没开 = hidden", () => {
    assert.equal(backfillView(null, true, false), "setup");
    assert.equal(backfillView(status(), false, false), "hidden");
  });

  test("结束态显示结果，关掉后隐藏；再开卡优先 setup", () => {
    for (const state of ["done", "cancelled", "failed"] as const) {
      assert.equal(backfillView(status({ state }), false, false), "result");
      assert.equal(backfillView(status({ state }), false, true), "hidden");
      assert.equal(backfillView(status({ state }), true, false), "setup");
    }
  });
});

describe("backfillProgress", () => {
  test("按轮算，夹在 0..1，总数 0 时为 0", () => {
    assert.equal(backfillProgress(status({ totalTurns: 200, doneTurns: 50 })), 0.25);
    assert.equal(backfillProgress(status({ totalTurns: 10, doneTurns: 12 })), 1);
    assert.equal(backfillProgress(status()), 0);
  });
});

describe("tokenMagnitude", () => {
  test("中文按千 / 万 / 亿给量级", () => {
    assert.equal(tokenMagnitude(800, "zh"), "约 800");
    assert.equal(tokenMagnitude(8_200, "zh"), "约 8.2 千");
    assert.equal(tokenMagnitude(125_000, "zh"), "约 12.5 万");
    assert.equal(tokenMagnitude(3_400_000, "zh"), "约 340 万");
    assert.equal(tokenMagnitude(250_000_000, "zh"), "约 2.5 亿");
  });

  test("英文按 K / M", () => {
    assert.equal(tokenMagnitude(900, "en"), "~900");
    assert.equal(tokenMagnitude(125_000, "en"), "~125K");
    assert.equal(tokenMagnitude(3_400_000, "en"), "~3.4M");
  });
});
