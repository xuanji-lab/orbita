import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compactMark } from "./compact-viz.ts";

describe("compactMark", () => {
  test("剩 20% 折叠：折叠点在条的 80% 处，标签居中", () => {
    assert.deepEqual(compactMark(20), { at: 80, labelAlign: "center" });
  });

  test("贴近右端（剩 10% / 5%）：标签改右对齐，不伸出条外", () => {
    assert.equal(compactMark(10).labelAlign, "end");
    assert.equal(compactMark(5).labelAlign, "end");
    assert.equal(compactMark(15).labelAlign, "center");
  });

  test("越界夹紧到 [5,50]：小于下界按 5% 算，大于上界按 50% 算", () => {
    assert.equal(compactMark(0).at, 95);
    assert.equal(compactMark(100).at, 50);
  });
});
