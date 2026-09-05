import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPOSER_MAX_ROWS,
  COMPOSER_MIN_ROWS,
  composerBoxHeight,
} from "./composer-height.ts";

// 实际 token：--line-height-input: 22px，textarea 竖向 padding 2px + 2px
const LINE = 22;
const PAD = 4;
const MIN = LINE * COMPOSER_MIN_ROWS + PAD; // 48
const MAX = LINE * COMPOSER_MAX_ROWS + PAD; // 268

describe("composerBoxHeight —— 输入框随内容长高", () => {
  test("空输入：塌到下限，不是一行", () => {
    assert.deepEqual(composerBoxHeight(LINE + PAD, LINE, PAD), {
      height: MIN,
      scrollable: false,
    });
  });

  test("一行字：仍是下限——首页的 slogan 比例靠它守着", () => {
    assert.equal(composerBoxHeight(26, LINE, PAD).height, MIN);
  });

  test("三行字：跟着长，不再是写死的两行", () => {
    const threeRows = LINE * 3 + PAD;
    assert.deepEqual(composerBoxHeight(threeRows, LINE, PAD), {
      height: threeRows,
      scrollable: false,
    });
  });

  test("撤回堆三条：三行都看得见（本功能的驱动场景）", () => {
    assert.equal(composerBoxHeight(LINE * 3 + PAD, LINE, PAD).height, LINE * 3 + PAD);
  });

  test("恰好顶到上限：到顶但不挂滚动轨", () => {
    assert.deepEqual(composerBoxHeight(MAX, LINE, PAD), { height: MAX, scrollable: false });
  });

  test("超过上限：封顶并转内部滚动，卡片不再长", () => {
    assert.deepEqual(composerBoxHeight(MAX + 100, LINE, PAD), {
      height: MAX,
      scrollable: true,
    });
  });

  test("行高来自实际样式：token 改了跟着变，不写死 22", () => {
    assert.equal(composerBoxHeight(0, 30, PAD).height, 30 * COMPOSER_MIN_ROWS + PAD);
  });

  test("量到 0（元素还没布局）也给下限，不塌成 0 高", () => {
    assert.equal(composerBoxHeight(0, LINE, PAD).height, MIN);
  });
});
