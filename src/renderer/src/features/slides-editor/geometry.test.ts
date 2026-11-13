import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boxFromPoints, constrainAngle, fitScale, intersects, lineFromEnds, resizeBox, snapMove, unionBox } from "./geometry.ts";

const box = { x: 100, y: 100, w: 200, h: 100 };

describe("resizeBox", () => {
  it("右下角拖出去：左上不动，宽高增加", () => {
    assert.deepEqual(resizeBox(box, "se", 50, 20, false), { x: 100, y: 100, w: 250, h: 120 });
  });
  it("左上角拖：右下不动", () => {
    assert.deepEqual(resizeBox(box, "nw", -30, -10, false), { x: 70, y: 90, w: 230, h: 110 });
  });
  it("边手柄只动一维", () => {
    assert.deepEqual(resizeBox(box, "e", 40, 999, false), { x: 100, y: 100, w: 240, h: 100 });
    assert.deepEqual(resizeBox(box, "n", 999, -20, false), { x: 100, y: 80, w: 200, h: 120 });
  });
  it("拖过对边：夹到最小尺寸，对边不动", () => {
    const out = resizeBox(box, "e", -500, 0, false);
    assert.equal(out.w, 8);
    assert.equal(out.x, 100);
    const west = resizeBox(box, "w", 500, 0, false);
    assert.equal(west.w, 8);
    assert.equal(west.x + west.w, 300);
  });
  it("Shift 等比：保持 2:1，角手柄取变化大的方向", () => {
    const out = resizeBox(box, "se", 100, 5, true);
    assert.ok(Math.abs(out.w / out.h - 2) < 1e-9);
    assert.equal(out.x, 100);
    assert.equal(out.y, 100);
    assert.equal(out.w, 300);
  });
  it("等比 + 左上角：右下锚定", () => {
    const out = resizeBox(box, "nw", -40, -40, true);
    assert.ok(Math.abs(out.w / out.h - 2) < 1e-9);
    assert.ok(Math.abs(out.x + out.w - 300) < 1e-9 && Math.abs(out.y + out.h - 200) < 1e-9);
  });
  it("等比 + 边手柄：另一维以中心为轴", () => {
    const out = resizeBox(box, "e", 100, 0, true);
    assert.equal(out.w, 300);
    assert.equal(out.h, 150);
    assert.equal(out.y, 75);
  });
});

describe("snapMove", () => {
  const canvas = { w: 1280, h: 720 };
  it("中心吸到画布中心并给出对齐线", () => {
    const { box: out, guides } = snapMove({ x: 538, y: 100, w: 200, h: 50 }, [], canvas, 6);
    assert.equal(out.x + out.w / 2, 640);
    assert.deepEqual(guides.vertical, [640]);
    assert.deepEqual(guides.horizontal, []);
  });
  it("吸到其它元素的边", () => {
    const { box: out, guides } = snapMove({ x: 403, y: 300, w: 100, h: 100 }, [{ x: 400, y: 10, w: 50, h: 50 }], canvas, 6);
    assert.equal(out.x, 400);
    assert.deepEqual(guides.vertical, [400]);
  });
  it("超出阈值不动", () => {
    const { box: out, guides } = snapMove({ x: 300, y: 300, w: 100, h: 100 }, [], canvas, 6);
    assert.deepEqual(out, { x: 300, y: 300, w: 100, h: 100 });
    assert.deepEqual(guides, { vertical: [], horizontal: [] });
  });
});

describe("其它几何", () => {
  it("unionBox / intersects / boxFromPoints", () => {
    assert.deepEqual(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }]), { x: 0, y: 0, w: 30, h: 15 });
    assert.equal(unionBox([]), null);
    assert.equal(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), false);
    assert.equal(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 }), true);
    assert.deepEqual(boxFromPoints(50, 40, 10, 20), { x: 10, y: 20, w: 40, h: 20 });
  });
  it("lineFromEnds：端点相对框、至少 1px 厚", () => {
    const out = lineFromEnds([100, 300], [500, 300]);
    assert.deepEqual([out.x, out.y, out.w, out.h], [100, 300, 400, 1]);
    assert.deepEqual(out.points, [[0, 0], [400, 0]]);
    const up = lineFromEnds([100, 300], [200, 200]);
    assert.deepEqual(up.points, [[0, 100], [100, 0]]);
  });
  it("constrainAngle：接近水平吸成水平", () => {
    const [x, y] = constrainAngle([0, 0], [100, 10]);
    assert.ok(Math.abs(y) < 1e-9 && x > 99);
  });
  it("fitScale：放得下整页，不超过 maxScale", () => {
    assert.ok(Math.abs(fitScale({ w: 724, h: 500 }, { w: 1280, h: 720 }, 24) - 676 / 1280) < 1e-9);
    assert.equal(fitScale({ w: 5000, h: 5000 }, { w: 1280, h: 720 }), 2);
  });
});
