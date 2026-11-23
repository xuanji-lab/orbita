import assert from "node:assert/strict";
import { test } from "node:test";
import { PDF_SHOT_FRESH_MS, shotFits, shotFresh, shotMatches } from "./pdf-shot-cache.ts";

test("框宽与设备像素比都对得上才能直接贴", () => {
  const shot = { cssWidth: 340, ratio: 2 };
  assert.equal(shotFits(shot, 340, 2), true);
  assert.equal(shotFits(shot, 341, 2), true);
  assert.equal(shotFits(shot, 345, 2), false);
  assert.equal(shotFits(shot, 340, 1), false);
});

test("一分钟内验过算新鲜", () => {
  assert.equal(shotFresh({ checkedAt: 1000 }, 1000 + PDF_SHOT_FRESH_MS - 1), true);
  assert.equal(shotFresh({ checkedAt: 1000 }, 1000 + PDF_SHOT_FRESH_MS), false);
});

test("字节数没变才算同一份", () => {
  assert.equal(shotMatches({ stamp: 4442431 }, new Uint8Array(4442431)), true);
  assert.equal(shotMatches({ stamp: 4442431 }, new Uint8Array(10)), false);
});
