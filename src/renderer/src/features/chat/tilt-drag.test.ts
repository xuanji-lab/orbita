import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GALAXY_TILT, isGalaxyTilt, parseSettings } from "../../../../shared/settings.ts";
import { dragTilt, isDragMove, keyTilt, raisedTo, snapTilt, TILT_DRAG } from "./tilt-drag.ts";

describe("星系空白处拖动改俯角", () => {
  test("位移阈值：4px 以内（含 4px、斜向）是点击，超过才是拖", () => {
    assert.equal(isDragMove(0, 0), false);
    assert.equal(isDragMove(0, 4), false);
    assert.equal(isDragMove(-4, 0), false);
    assert.equal(isDragMove(2.8, 2.8), false);
    assert.equal(isDragMove(0, 4.1), true);
    assert.equal(isDragMove(3, 3), true);
    assert.equal(TILT_DRAG.thresholdPx, 4);
  });

  test("往下拖变大、往上拖变小；每 20px 一档 5°，落在设置网格上", () => {
    assert.equal(dragTilt(40, 0), 40);
    assert.equal(dragTilt(40, 20), 45);
    assert.equal(dragTilt(40, -20), 35);
    assert.equal(dragTilt(40, 9), 40);
    assert.equal(dragTilt(40, 11), 45);
    for (let dy = -400; dy <= 400; dy += 7) assert.ok(isGalaxyTilt(dragTilt(40, dy)), `dy=${dy} → ${dragTilt(40, dy)}`);
  });

  test("角度夹在 10°–60°：拖多远都不越界", () => {
    assert.equal(dragTilt(40, 10_000), GALAXY_TILT.max);
    assert.equal(dragTilt(40, -10_000), GALAXY_TILT.min);
    assert.equal(dragTilt(60, 40), 60);
    assert.equal(dragTilt(10, -40), 10);
    assert.equal(snapTilt(7), 10);
    assert.equal(snapTilt(99), 60);
    assert.equal(snapTilt(Number.NaN), GALAXY_TILT.default);
  });

  test("键盘：↓ +5°、↑ −5°，到边不越界；别的键不管", () => {
    assert.equal(keyTilt(40, "ArrowDown"), 45);
    assert.equal(keyTilt(40, "ArrowUp"), 35);
    assert.equal(keyTilt(60, "ArrowDown"), 60);
    assert.equal(keyTilt(10, "ArrowUp"), 10);
    assert.equal(keyTilt(40, "ArrowLeft"), null);
    assert.equal(keyTilt(40, "Enter"), null);
  });

  test("拖出来的值写进设置后读得回来（与设置 › 外观的滑块同一个字段、同一套校验）", () => {
    for (const dy of [-300, -45, 0, 33, 300]) {
      const value = dragTilt(40, dy);
      assert.equal(parseSettings({ galaxyTilt: value }).galaxyTilt, value);
    }
  });

  test("自动抬高的提示：实际画的俯角比设置高才写，半度以内当没抬", () => {
    assert.equal(raisedTo(15, 18), 18);
    assert.equal(raisedTo(15, 15.4), null);
    assert.equal(raisedTo(40, 40), null);
    assert.equal(raisedTo(40, null), null);
  });
});
