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
  fitPadding,
  fitView,
  labelTier,
  panBy,
  wheelFactor,
  zoomAround,
} from "./graph-view.ts";

test("clampZoom：钳到 [ZOOM_MIN, ZOOM_MAX]，非法值回 1", () => {
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

test("fitView：外接框整张进面板并居中、只缩不放、倍数在下限之上", () => {
  const base = { k: 1, ox: 0, oy: 0 };
  const viewport = { w: 400, h: 300 };
  // 大图（1200×900）：缩到能放下（扣掉四周 24px）
  const big = fitView({ x0: -400, y0: -300, x1: 800, y1: 600 }, base, viewport, 24);
  const m = composeMapping(base, big);
  const sx = (x: number) => m.ox + x * m.k;
  const sy = (y: number) => m.oy + y * m.k;
  assert.ok(sx(-400) >= 24 - 1e-6 && sx(800) <= 376 + 1e-6, "左右在边距内");
  assert.ok(sy(-300) >= 24 - 1e-6 && sy(600) <= 276 + 1e-6, "上下在边距内");
  assert.ok(Math.abs((sx(-400) + sx(800)) / 2 - 200) < 1e-6, "水平居中");
  // 小图：不放大，只居中
  const small = fitView({ x0: 100, y0: 100, x1: 140, y1: 120 }, base, viewport, 24);
  assert.equal(small.z, 1);
  const s2 = composeMapping(base, small);
  assert.ok(Math.abs(s2.ox + 120 * s2.k - 200) < 1e-6 && Math.abs(s2.oy + 110 * s2.k - 150) < 1e-6);
  // 极端大：钳在下限
  assert.equal(fitView({ x0: 0, y0: 0, x1: 1e6, y1: 1e6 }, base, viewport, 24).z, ZOOM_MIN);
  // 单点：按 1 居中
  assert.equal(fitView({ x0: 5, y0: 5, x1: 5, y1: 5 }, base, viewport, 24).z, 1);
});

test("fitPadding：短边 8%，至少 24px", () => {
  assert.equal(fitPadding({ w: 200, h: 200 }), 24);
  assert.equal(fitPadding({ w: 1000, h: 600 }), 48);
});

test("fitView：让开浮层控件——图落在扣掉顶部摘要与底部图例之后的区域里", () => {
  const base = { k: 1, ox: 0, oy: 0 };
  const viewport = { w: 400, h: 400 };
  const insets = { top: 60, right: 0, bottom: 90, left: 0 };
  const view = fitView({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, base, viewport, 20, insets);
  const m = composeMapping(base, view);
  assert.ok(m.oy + 0 * m.k >= 80 - 1e-6, "顶不压摘要");
  assert.ok(m.oy + 1000 * m.k <= 400 - 110 + 1e-6, "底不压图例");
});

test("labelTier：缩小到总览档", () => {
  assert.equal(labelTier(0.4, true), -1);
  assert.equal(labelTier(0.4, false), -1);
  assert.equal(labelTier(1, true), 0);
});
