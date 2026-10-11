import { test } from "node:test";
import assert from "node:assert/strict";
import { noticeIconBoxStyle, noticeParagraphStyle, noticeTextStyle } from "./notice.ts";

/**
 * 提示行（Notice）的换行几何口径。锚定「长无空格片段撑出对话列」修复的不变量：
 *
 * 1. 文字 wrapper 必须 `minWidth: 0` + `overflowWrap: "anywhere"`——
 *    flex 子项默认 `min-width: auto`，最小内容宽度 = 最长无空格片段；`anywhere`
 *    让片段在 min-content 计算里也允许断开（`break-word` 不减小 min-content，无效）；
 * 2. `<p>` 本身作为外层 flex 子项同样默认 `min-width: auto`，必须显式放开，
 *    并用 `maxWidth: "100%"` 兜住可用宽度；
 * 3. 图标盒高度只由行高 token 构成（与首行行盒同高），不含像素常量——
 *    换行高 token 时图标对齐自动跟随，不会回到“钉死 22px”的老路。
 */

test("文字 wrapper：允许收缩 + 片段内断行（anywhere，不是 break-word）", () => {
  assert.equal(noticeTextStyle.minWidth, 0);
  assert.equal(noticeTextStyle.overflowWrap, "anywhere");
  // break-word 不减小 min-content，在 flex 布局里挡不住溢出——出现即是回潮
  assert.notEqual(noticeTextStyle.overflowWrap, "break-word");
});

test("提示行本体：minWidth 0 + maxWidth 100%，flex 子项能被压到可用宽度", () => {
  for (const bad of [true, false]) {
    const style = noticeParagraphStyle(bad);
    assert.equal(style.minWidth, 0);
    assert.equal(style.maxWidth, "100%");
    // 图标与首行对齐：整块居中会让三角悬在多行文字中间
    assert.equal(style.alignItems, "flex-start");
  }
});

test("图标盒：高度只由行高 token 构成，无像素常量", () => {
  const style = noticeIconBoxStyle;
  assert.equal(style.height, "var(--line-height-body)");
  for (const value of Object.values(style)) {
    assert.equal(/\d+px/.test(String(value)), false, `不许像素常量：${String(value)}`);
  }
});

test("颜色只走 token，无裸 hex（tone 两档都查）", () => {
  for (const bad of [true, false]) {
    const style = noticeParagraphStyle(bad);
    assert.equal(style.color, bad ? "var(--color-danger)" : "var(--color-text-secondary)");
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(String(style.color)), false);
  }
});
