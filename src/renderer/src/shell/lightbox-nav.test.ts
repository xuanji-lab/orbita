import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lightboxKey } from "./lightbox-nav.ts";

describe("lightboxKey", () => {
  test("Esc 关闭，不论第几张", () => {
    assert.deepEqual(lightboxKey("Escape", 0, 1), { kind: "close" });
    assert.deepEqual(lightboxKey("Escape", 2, 3), { kind: "close" });
  });

  test("左右键在范围内翻页", () => {
    assert.deepEqual(lightboxKey("ArrowRight", 0, 3), { kind: "show", index: 1 });
    assert.deepEqual(lightboxKey("ArrowLeft", 2, 3), { kind: "show", index: 1 });
  });

  test("到头不回绕", () => {
    assert.equal(lightboxKey("ArrowLeft", 0, 3), null);
    assert.equal(lightboxKey("ArrowRight", 2, 3), null);
    assert.equal(lightboxKey("ArrowRight", 0, 1), null);
  });

  test("别的键不管", () => {
    assert.equal(lightboxKey("Enter", 0, 3), null);
  });
});
