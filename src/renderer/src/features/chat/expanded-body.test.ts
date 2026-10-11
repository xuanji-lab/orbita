import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPANDED_FRAME, RAIL_X } from "./expanded-body.ts";

/**
 * 展开体「圆角虚线框」的几何口径（2026-10-12 用户裁决：折叠行下挂出来的内容
 * 统一这一个语义）。锚定的不变量：
 *
 * 1. 框必须是 **1px dashed**，色走 `--color-border-default`（深色下 subtle 与地面
 *    只差几阶，孤立的 1px 线会隐形——沿导轨竖线的旧理由）；回潮成 solid（旧顶线 /
 *    导轨形态）即违规；
 * 2. 圆角走 `--radius-md` token（设计系统：矩形停在 radius-md，pill 只给真圆），
 *    不许像素字面量；
 * 3. 左缩进 = RAIL_X（与折叠行行首 icon 左缘相切），右缘无 margin（钉在行右
 *    内边距的血线上）——两个方向都不许各自写死数字。
 */

test("框：1px dashed + border-default（不是 solid，不是 subtle）", () => {
  assert.equal(EXPANDED_FRAME.border, "1px dashed var(--color-border-default)");
});

test("圆角只走 --radius-md token，无像素字面量", () => {
  assert.equal(EXPANDED_FRAME.borderRadius, "var(--radius-md)");
  assert.equal(/^\d/.test(String(EXPANDED_FRAME.borderRadius)), false, "不许像素/数字圆角");
});

test("缩进：左缘 = RAIL_X（与行首 icon 左缘相切），右缘无 margin", () => {
  assert.equal(EXPANDED_FRAME.marginLeft, RAIL_X);
  assert.equal(RAIL_X, 10, "RAIL_X 是折叠行按钮内边距（icon 左缘），漂了就是对不齐");
  assert.equal("marginRight" in EXPANDED_FRAME, false, "右 margin 会破坏行尾血线");
});

test("颜色与几何只走 token：无裸 hex、无 rgba 字面量", () => {
  for (const value of Object.values(EXPANDED_FRAME)) {
    const s = String(value);
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(s), false, `不许裸 hex：${s}`);
    assert.equal(/rgba?\(/.test(s), false, `不许 rgba 字面量：${s}`);
  }
});
