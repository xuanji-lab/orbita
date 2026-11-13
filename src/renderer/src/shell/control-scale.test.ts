import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_STEPS, controlBox, ICON_STEPS, iconSize } from "./control-scale.ts";

test("图标按钮外框只落在 24 / 28 / 32，更大的原样", () => {
  assert.deepEqual([18, 20, 22, 24].map(controlBox), [24, 24, 24, 24]);
  assert.deepEqual([26, 28].map(controlBox), [28, 28]);
  assert.deepEqual([30, 32].map(controlBox), [32, 32]);
  assert.equal(controlBox(36), 36);
  for (let n = 1; n <= 32; n++) assert.ok((CONTROL_STEPS as readonly number[]).includes(controlBox(n)));
});

test("图标字形只落在 12 / 14 / 16，装饰点与插图原样", () => {
  assert.deepEqual([10, 11, 12].map(iconSize), [12, 12, 12]);
  assert.deepEqual([13, 14].map(iconSize), [14, 14]);
  assert.deepEqual([15, 16].map(iconSize), [16, 16]);
  assert.deepEqual([8, 9, 20, 28].map(iconSize), [8, 9, 20, 28]);
  for (let n = 10; n <= 16; n++) assert.ok((ICON_STEPS as readonly number[]).includes(iconSize(n)));
});
