import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADD_BUTTON,
  LIST_PADDING,
  STRIP_GAP,
  THUMBS_VISIBLE,
  THUMB_CHROME,
  THUMB_MAX,
  THUMB_MIN,
  thumbWidthFor,
} from "./filmstrip-layout.ts";

/** 这个宽度的列表里，THUMBS_VISIBLE 张缩略图（含描边）+ 间距 + 「+」按钮 + 内边距，一共占多宽 */
const needed = (thumb: number): number => THUMBS_VISIBLE * (thumb + THUMB_CHROME) + THUMBS_VISIBLE * STRIP_GAP + ADD_BUTTON + LIST_PADDING;

describe("缩略条的缩略图宽度", () => {
  it("窄面板（420 左右的文档面板，列表约 388）缩小到刚好放下 3 张，且至少完整看到 3 张", () => {
    const width = thumbWidthFor(388);
    assert.ok(width < THUMB_MAX && width >= THUMB_MIN, `宽度 ${width}`);
    assert.ok(needed(width) <= 388, "3 张 + 「+」不超出列表宽度");
  });

  it("宽面板顶到上限，没量到宽度按上限", () => {
    assert.equal(thumbWidthFor(900), THUMB_MAX);
    assert.equal(thumbWidthFor(0), THUMB_MAX);
  });

  it("极窄不低于下限（靠横向滚动）；宽度越大缩略图越不小", () => {
    assert.equal(thumbWidthFor(120), THUMB_MIN);
    let prev = 0;
    for (let w = 100; w <= 700; w += 20) {
      const value = thumbWidthFor(w);
      assert.ok(value >= prev);
      prev = value;
    }
  });
});
