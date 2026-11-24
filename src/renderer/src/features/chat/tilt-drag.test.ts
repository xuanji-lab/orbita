import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GALAXY_TILT, parseSettings } from "../../../../shared/settings.ts";
import { anglesForSave, anglesLabel, clampTilt, dragAngles, isDragMove, keyAngles, raisedTo, TILT_DRAG, VIEW_DEFAULT, wrapAzimuth } from "./tilt-drag.ts";

const START = { tilt: 40, azimuth: 0 };

describe("星系转台手势（锁 z 轴、无极）", () => {
  test("位移阈值：4px 以内（含 4px、斜向）是点击，超过才是拖", () => {
    assert.equal(isDragMove(0, 0), false);
    assert.equal(isDragMove(0, 4), false);
    assert.equal(isDragMove(-4, 0), false);
    assert.equal(isDragMove(2.8, 2.8), false);
    assert.equal(isDragMove(0, 4.1), true);
    assert.equal(isDragMove(3, 3), true);
    assert.equal(TILT_DRAG.thresholdPx, 4);
  });

  test("角度连续、没有分档：每像素 0.3°，1px 也有变化，往下拖俯角变大、往右拖方位角变大", () => {
    assert.equal(TILT_DRAG.degPerPx, 0.3);
    let prev = dragAngles(START, 0, 0, true);
    for (let dy = 1; dy <= 60; dy++) {
      const next = dragAngles(START, 0, dy, true);
      assert.ok(Math.abs(next.tilt - prev.tilt - 0.3) < 1e-9, `dy=${dy}：${prev.tilt} → ${next.tilt}`);
      prev = next;
    }
    assert.ok(Math.abs(dragAngles(START, 0, -10, true).tilt - 37) < 1e-9);
    assert.ok(Math.abs(dragAngles(START, 1, 0, true).azimuth - 0.3) < 1e-9);
    assert.ok(Math.abs(dragAngles(START, 7, 0, true).azimuth - 2.1) < 1e-9);
    // 非整数位移也连续（指针事件的坐标可以是小数）
    assert.ok(Math.abs(dragAngles(START, 0, 0.5, true).tilt - 40.15) < 1e-9);
  });

  test("俯角夹在 10°–60°；方位角取模 360（左拖过 0 回到 359 附近）", () => {
    assert.equal(dragAngles(START, 0, 10_000, true).tilt, GALAXY_TILT.max);
    assert.equal(dragAngles(START, 0, -10_000, true).tilt, GALAXY_TILT.min);
    assert.equal(clampTilt(Number.NaN), GALAXY_TILT.default);
    assert.ok(Math.abs(dragAngles(START, -10, 0, true).azimuth - 357) < 1e-9);
    assert.ok(Math.abs(dragAngles({ tilt: 40, azimuth: 350 }, 100, 0, true).azimuth - 20) < 1e-9);
    for (let dx = -5000; dx <= 5000; dx += 37) {
      const a = dragAngles(START, dx, 0, true).azimuth;
      assert.ok(a >= 0 && a < 360, `dx=${dx} → ${a}`);
    }
    assert.equal(wrapAzimuth(-0.0001) < 360, true);
    assert.equal(wrapAzimuth(720), 0);
  });

  test("转台关着：左右拖不改方位角，上下照旧", () => {
    const next = dragAngles({ tilt: 40, azimuth: 120 }, 300, 20, false);
    assert.equal(next.azimuth, 120);
    assert.ok(Math.abs(next.tilt - 46) < 1e-9);
  });

  test("存盘按 1° 取整；359.6° 存成 0°；写进设置读得回来（与设置页滑块同一字段）", () => {
    assert.deepEqual(anglesForSave({ tilt: 37.4, azimuth: 123.6 }), { tilt: 37, azimuth: 124 });
    assert.deepEqual(anglesForSave({ tilt: 60.2, azimuth: 359.6 }), { tilt: 60, azimuth: 0 });
    for (const [dx, dy] of [[-300, -45], [0, 0], [33, 17], [1234, 300]] as const) {
      const saved = anglesForSave(dragAngles(START, dx, dy, true));
      const parsed = parseSettings({ galaxyTilt: saved.tilt, galaxyAzimuth: saved.azimuth });
      assert.equal(parsed.galaxyTilt, saved.tilt);
      assert.equal(parsed.galaxyAzimuth, saved.azimuth);
    }
  });

  test("键盘：↓ ↑ 改俯角、→ ← 改方位，每次 5°，到边不越界；转台关着时左右键不管", () => {
    assert.deepEqual(keyAngles(START, "ArrowDown", true), { tilt: 45, azimuth: 0 });
    assert.deepEqual(keyAngles(START, "ArrowUp", true), { tilt: 35, azimuth: 0 });
    assert.deepEqual(keyAngles(START, "ArrowRight", true), { tilt: 40, azimuth: 5 });
    assert.deepEqual(keyAngles(START, "ArrowLeft", true), { tilt: 40, azimuth: 355 });
    assert.deepEqual(keyAngles({ tilt: 60, azimuth: 0 }, "ArrowDown", true), { tilt: 60, azimuth: 0 });
    assert.equal(keyAngles(START, "ArrowLeft", false), null);
    assert.equal(keyAngles(START, "Enter", true), null);
  });

  test("角落提示与复位", () => {
    assert.equal(anglesLabel({ tilt: 40.2, azimuth: 119.7 }), "40° · 120°");
    assert.deepEqual(VIEW_DEFAULT, { tilt: 40, azimuth: 0 });
    assert.equal(raisedTo(15, 18), 18);
    assert.equal(raisedTo(15, 15.4), null);
    assert.equal(raisedTo(40, null), null);
  });
});
