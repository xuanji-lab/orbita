import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compactPosition } from "./compact-viz.ts";

describe("compactPosition", () => {
  test("两端：50%（上界，最早压缩）落左端 0，5%（下界，最晚压缩）落右端 1", () => {
    assert.equal(compactPosition(50), 0);
    assert.equal(compactPosition(5), 1);
  });

  test("中间一档：20% 落在 30/45", () => {
    assert.equal(compactPosition(20), 30 / 45);
  });

  test("越界夹紧：小于下界按下界算，大于上界按上界算", () => {
    assert.equal(compactPosition(0), 1);
    assert.equal(compactPosition(100), 0);
  });
});
