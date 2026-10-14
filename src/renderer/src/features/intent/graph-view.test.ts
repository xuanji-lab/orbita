/**
 * 视图变换与语义缩放档位的纯函数测试：钳制范围、围绕指针缩放不漂、合成映射、
 * 滚轮倍数方向、档位阈值、截字。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_VIEW,
  ZOOM_MAX,
  ZOOM_MIN,
  baseMapping,
  clampZoom,
  clipText,
  composeMapping,
  labelTier,
  panBy,
  wheelFactor,
  zoomAround,
} from "./graph-view.ts";

test("clampZoom：钳到 [0.6, 4]，非法值回 1", () => {
  assert.equal(clampZoom(0.1), ZOOM_MIN);
  assert.equal(clampZoom(9), ZOOM_MAX);
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(Number.NaN), 1);
});

test("zoomAround：指针下的布局点在缩放前后不动；撞边界不漂", () => {
  const base = baseMapping({ w: 380, h: 340 }, { w: 380, h: 340 });
  const px = 120;
  const py = 200;
  const before = composeMapping(base, IDENTITY_VIEW);
  const layoutX = (px - before.ox) / before.k;
  const layoutY = (py - before.oy) / before.k;
  const view = zoomAround(IDENTITY_VIEW, 2, px, py);
  const after = composeMapping(base, view);
  assert.ok(Math.abs(after.ox + layoutX * after.k - px) < 1e-9);
  assert.ok(Math.abs(after.oy + layoutY * after.k - py) < 1e-9);
  // 连续放大到上限：倍数停在 4，指针点仍不动
  let v = IDENTITY_VIEW;
  for (let i = 0; i < 20; i += 1) v = zoomAround(v, 1.5, px, py);
  assert.equal(v.z, ZOOM_MAX);
  const m = composeMapping(base, v);
  assert.ok(Math.abs(m.ox + layoutX * m.k - px) < 1e-6);
  // 缩到下限
  for (let i = 0; i < 20; i += 1) v = zoomAround(v, 0.5, px, py);
  assert.equal(v.z, ZOOM_MIN);
});

test("composeMapping / panBy：平移只加在屏幕坐标上", () => {
  const base = { k: 0.8, ox: 10, oy: 20 };
  const m = composeMapping(base, panBy({ z: 2, tx: 5, ty: -5 }, 10, 10));
  assert.deepEqual(m, { k: 1.6, ox: 10 * 2 + 15, oy: 20 * 2 + 5 });
});

test("wheelFactor：向上滚放大、向下缩小；捏合更陡；超大 delta 被钳", () => {
  assert.ok(wheelFactor(-50, false) > 1);
  assert.ok(wheelFactor(50, false) < 1);
  assert.ok(wheelFactor(-10, true) > wheelFactor(-10, false));
  assert.equal(wheelFactor(-10000, false), wheelFactor(-100, false));
});

test("labelTier：1.5 / 2.5 分档，密集模式抬高到 1.7 / 2.8", () => {
  assert.equal(labelTier(1, false), 0);
  assert.equal(labelTier(1.5, false), 1);
  assert.equal(labelTier(2.49, false), 1);
  assert.equal(labelTier(2.5, false), 2);
  assert.equal(labelTier(1.6, true), 0);
  assert.equal(labelTier(1.7, true), 1);
  assert.equal(labelTier(2.8, true), 2);
});

test("clipText：按字符截断加省略号，折叠空白", () => {
  assert.equal(clipText("博士研究方向梳理与讨论", 12), "博士研究方向梳理与讨论");
  assert.equal(clipText("这条 QA 里用户正在为「LLM 城市规划偏见」论文搭建论证骨架", 24), "这条 QA 里用户正在为「LLM 城市规划偏见」…");
  assert.equal(clipText("  a\n\nb  ", 5), "a b");
});
