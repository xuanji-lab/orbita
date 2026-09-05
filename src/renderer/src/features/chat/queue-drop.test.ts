import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { placementFromOffset, resolveDropIndex } from "./queue-drop.ts";

describe("resolveDropIndex —— 拖放落点换算", () => {
  test("往下拖到某行的下半：落在它后面", () => {
    // [甲,乙,丙] 把甲拖到乙的下半 → [乙,甲,丙]
    assert.equal(resolveDropIndex(0, 1, "after"), 1);
  });

  test("往下拖到某行的上半：落在它前面", () => {
    // [甲,乙,丙] 把甲拖到丙的上半 → [乙,甲,丙]
    assert.equal(resolveDropIndex(0, 2, "before"), 1);
  });

  test("往上拖到某行的上半：直接占它的位置", () => {
    // [甲,乙,丙] 把丙拖到甲的上半 → [丙,甲,乙]
    assert.equal(resolveDropIndex(2, 0, "before"), 0);
  });

  test("往上拖到某行的下半", () => {
    // [甲,乙,丙] 把丙拖到甲的下半 → [甲,丙,乙]
    assert.equal(resolveDropIndex(2, 0, "after"), 1);
  });

  test("向下拖差的那一格：源在插入点前，抽走后插入点前移", () => {
    // 不减这一格就会多挪一位——拖拽排序最经典的错法
    assert.equal(resolveDropIndex(0, 3, "after"), 3);
    assert.equal(resolveDropIndex(3, 0, "after"), 1);
  });

  test("拖回原位：返回 null，不发命令", () => {
    assert.equal(resolveDropIndex(1, 1, "before"), null);
    assert.equal(resolveDropIndex(1, 1, "after"), null);
    // 拖到前一行的下半 = 原位
    assert.equal(resolveDropIndex(1, 0, "after"), null);
    // 拖到后一行的上半 = 原位
    assert.equal(resolveDropIndex(1, 2, "before"), null);
  });

  test("拖到队尾", () => {
    assert.equal(resolveDropIndex(0, 2, "after"), 2);
  });
});

describe("placementFromOffset", () => {
  test("上半算 before", () => {
    assert.equal(placementFromOffset(4, 22), "before");
  });

  test("下半算 after", () => {
    assert.equal(placementFromOffset(18, 22), "after");
  });

  test("正中间算 after（边界归一侧，不留歧义）", () => {
    assert.equal(placementFromOffset(11, 22), "after");
  });
});
