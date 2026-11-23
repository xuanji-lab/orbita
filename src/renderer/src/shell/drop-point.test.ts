import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chipDropEdge, clampIndex, snapDropIndex } from "./drop-point.ts";

describe("snapDropIndex", () => {
  const chips = [{ start: 4, end: 10 }];
  test("落在胶囊中间 → 吸到最近的一边", () => {
    assert.equal(snapDropIndex(chips, 5), 4);
    assert.equal(snapDropIndex(chips, 9), 10);
  });
  test("胶囊两端与胶囊外原样", () => {
    for (const index of [0, 3, 4, 10, 12]) assert.equal(snapDropIndex(chips, index), index);
  });
  test("没有胶囊原样", () => {
    assert.equal(snapDropIndex([], 7), 7);
  });
  test("相邻两颗胶囊：落在中间那条缝上不动", () => {
    assert.equal(snapDropIndex([{ start: 0, end: 5 }, { start: 5, end: 9 }], 5), 5);
  });
});

describe("chipDropEdge / clampIndex", () => {
  test("左半头、右半尾", () => {
    assert.equal(chipDropEdge(100, 200, 120), "start");
    assert.equal(chipDropEdge(100, 200, 180), "end");
  });
  test("夹进范围", () => {
    assert.equal(clampIndex(9, 8), 8);
    assert.equal(clampIndex(-1, 8), 0);
  });
});
