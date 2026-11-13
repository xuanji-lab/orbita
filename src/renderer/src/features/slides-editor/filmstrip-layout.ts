/** 缩略图宽度上限（px，高度按画布比例）；面板窄时按可用宽度缩小，见 thumbWidthFor */
export const THUMB_MAX = 148;
export const THUMB_MIN = 72;
/** 窄面板里至少要完整看到几张 */
export const THUMBS_VISIBLE = 3;
/** 一张缩略图在宽度上多占的（选中描边 2×2 + 页自己的 1px 边框 ×2）、间距、「+」按钮、列表内边距 */
export const THUMB_CHROME = 6;
export const STRIP_GAP = 8;
export const ADD_BUTTON = 32;
export const LIST_PADDING = 4;

/**
 * 缩略图宽度：列表可用宽度（px）够放下 THUMBS_VISIBLE 张加「+」就缩到刚好放下，宽面板顶到上限；
 * 再窄也不低于 THUMB_MIN（那时靠横向滚动）。没量到宽度（0）按上限。纯函数。
 */
export function thumbWidthFor(listWidth: number): number {
  if (listWidth <= 0) return THUMB_MAX;
  const fit = Math.floor((listWidth - LIST_PADDING - ADD_BUTTON - STRIP_GAP * THUMBS_VISIBLE) / THUMBS_VISIBLE) - THUMB_CHROME;
  return Math.max(THUMB_MIN, Math.min(THUMB_MAX, fit));
}
