import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_SHOT_FRESH_MS, BOARD_SHOT_LIMIT, boardShotFits, boardShotKey, boardShots, type BoardShot } from "./board-shot-cache.ts";

const base = { cssWidth: 752, cssHeight: 400, ratio: 2, theme: "light", capturedAt: 1_000 };
const current = { width: 752, height: 400, ratio: 2, theme: "light", now: 2_000 };

test("缓存键同时含会话与工具调用，撞 toolCallId 也不互贴", () => {
  assert.notEqual(boardShotKey("session-a", "call-1"), boardShotKey("session-b", "call-1"));
  assert.notEqual(boardShotKey("session-a", "call-1"), boardShotKey("session-a", "call-2"));
  assert.equal(boardShotKey("session-a", "call-1"), "session-a:call-1");
});

test("位图只在宽高、DPR、主题与新鲜度都对得上时可用", () => {
  assert.equal(boardShotFits(base, current), true);
  assert.equal(boardShotFits(base, { ...current, width: 753.99 }), true);
  assert.equal(boardShotFits(base, { ...current, width: 754 }), false);
  assert.equal(boardShotFits(base, { ...current, height: 402 }), false);
  assert.equal(boardShotFits(base, { ...current, ratio: 1 }), false);
  assert.equal(boardShotFits(base, { ...current, theme: "black" }), false);
});

test("超过一分钟或时钟倒走的位图不贴", () => {
  assert.equal(boardShotFits(base, { ...current, now: base.capturedAt + BOARD_SHOT_FRESH_MS - 1 }), true);
  assert.equal(boardShotFits(base, { ...current, now: base.capturedAt + BOARD_SHOT_FRESH_MS }), false);
  assert.equal(boardShotFits(base, { ...current, now: base.capturedAt - 1 }), false);
});

test("LRU 只留最近 8 张，最久没用的先淘汰", () => {
  const keys: string[] = [];
  for (let i = 0; i < BOARD_SHOT_LIMIT + 1; i += 1) {
    const key = boardShotKey(`shot-test-${i}`, "call");
    keys.push(key);
    boardShots.set(key, { ...base, bitmap: {} as ImageBitmap } satisfies BoardShot);
  }
  assert.equal(boardShots.size, BOARD_SHOT_LIMIT);
  assert.equal(boardShots.get(keys[0] ?? ""), undefined);
  assert.ok(boardShots.get(keys.at(-1) ?? "") !== undefined);
  for (const key of keys) boardShots.delete(key);
});
