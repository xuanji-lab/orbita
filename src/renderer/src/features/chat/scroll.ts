/** 距底多少像素内仍算「在底部」：流式渲染的亚像素抖动不该把用户踢出跟随态 */
export const BOTTOM_THRESHOLD_PX = 40;

/**
 * 是否贴着底部。视口在底（scrollTop + viewportHeight 不小于 scrollHeight - threshold）
 * 即真——内容不足一屏时恒为真（无处可滚，等价于在底部）。
 */
export function isAtBottom(
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  threshold: number = BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollTop + viewportHeight >= scrollHeight - threshold;
}
