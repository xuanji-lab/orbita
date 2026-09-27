import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fitWithin, regionClip, shotSize, toCssPoint, type ShotGeometry } from "./screenshot-geometry.ts";

describe("截图几何", () => {
  test("shotSize：窗口不大时截图像素就是 CSS 像素（坐标原样可点）；宽超 1280 等比缩；高不超 2000", () => {
    assert.deepEqual(shotSize(1100, 722), { width: 1100, height: 722 });
    assert.deepEqual(shotSize(2560, 1300), { width: 1280, height: 650 });
    assert.deepEqual(shotSize(800, 4000), { width: 400, height: 2000 });
  });

  test("fitWithin 不放大，至少 1 像素", () => {
    assert.deepEqual(fitWithin(300, 200, 1280, 2000), { width: 300, height: 200 });
    assert.deepEqual(fitWithin(10000, 1, 1280, 2000), { width: 1280, height: 1 });
  });

  test("toCssPoint：按图与视口的比例换算；出图回 null", () => {
    const same: ShotGeometry = { width: 1100, height: 722, cssWidth: 1100, cssHeight: 722 };
    assert.deepEqual(toCssPoint(same, 100, 50), { x: 100, y: 50 });
    const scaled: ShotGeometry = { width: 1280, height: 650, cssWidth: 2560, cssHeight: 1300 };
    assert.deepEqual(toCssPoint(scaled, 640, 325), { x: 1280, y: 650 });
    // 贴右下边缘的点收进视口内
    assert.deepEqual(toCssPoint(same, 1100, 722), { x: 1099, y: 721 });
    assert.equal(toCssPoint(same, 1200, 10), null);
    assert.equal(toCssPoint(same, -1, 10), null);
    assert.equal(toCssPoint(same, Number.NaN, 10), null);
  });

  test("regionClip：换成 CSS 像素并加滚动偏移；裁进图内；放大到上限且不超过 4 倍", () => {
    const shot: ShotGeometry = { width: 1280, height: 650, cssWidth: 2560, cssHeight: 1300 };
    const clip = regionClip(shot, { x: 100, y: 100, width: 200, height: 100 }, { pageX: 0, pageY: 3000 });
    assert.deepEqual(clip, { x: 200, y: 3200, width: 400, height: 200, scale: 3.2 });
    const tiny = regionClip(
      { width: 1000, height: 700, cssWidth: 1000, cssHeight: 700 },
      { x: 0, y: 0, width: 50, height: 50 },
      { pageX: 0, pageY: 0 },
    );
    assert.equal(tiny?.scale, 4);
    // 超出图的部分裁掉
    const edge = regionClip(
      { width: 1000, height: 700, cssWidth: 1000, cssHeight: 700 },
      { x: 900, y: 600, width: 500, height: 500 },
      { pageX: 0, pageY: 0 },
    );
    assert.deepEqual([edge?.width, edge?.height], [100, 100]);
  });

  test("regionClip：完全在图外或小于 8px 回 null", () => {
    const shot: ShotGeometry = { width: 1000, height: 700, cssWidth: 1000, cssHeight: 700 };
    assert.equal(regionClip(shot, { x: 2000, y: 0, width: 100, height: 100 }, { pageX: 0, pageY: 0 }), null);
    assert.equal(regionClip(shot, { x: 10, y: 10, width: 5, height: 100 }, { pageX: 0, pageY: 0 }), null);
  });
});
