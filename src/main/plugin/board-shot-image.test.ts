import assert from "node:assert/strict";
import test from "node:test";
import { luminanceDeviation, boardShotViewport } from "./board-shot-image.ts";

function solid(red: number, green: number, blue: number): Uint8Array {
  const data = new Uint8Array(4 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = blue;
    data[i + 1] = green;
    data[i + 2] = red;
    data[i + 3] = 255;
  }
  return data;
}

test("全黑 / 全白的空白候选标准差都是 0", () => {
  assert.equal(luminanceDeviation(solid(0, 0, 0)), 0);
  assert.equal(luminanceDeviation(solid(255, 255, 255)), 0);
  assert.equal(luminanceDeviation(new Uint8Array()), 0);
});

test("明暗两块的图有内容，不能被空白阈值误杀", () => {
  const data = solid(0, 0, 0);
  for (let i = 0; i < data.length / 2; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
  }
  assert.ok(luminanceDeviation(data) > 100);
});

test("CDP 视口只接受有限的正宽高；形状不对、零值、负值都拒绝", () => {
  assert.deepEqual(boardShotViewport({ clientWidth: 1440, clientHeight: 900 }), { width: 1440, height: 900 });
  for (const raw of [null, undefined, "x", [], {}, { clientWidth: 0, clientHeight: 900 }, { clientWidth: 1440, clientHeight: -1 }, { clientWidth: Number.NaN, clientHeight: 900 }, { clientWidth: "1440", clientHeight: 900 }]) {
    assert.equal(boardShotViewport(raw), null);
  }
});

