/**
 * 输入框随内容长高 —— 纯函数，Composer 的可测内核。
 *
 * 下限 2 行：首页的视觉重心是 slogan + 输入框，空输入框塌成一行会破坏那个比例。
 * 上限 12 行：composer 浮在窗口底部，再高就开始吃对话区。设计系统没规定这个数，
 * 取「粘一段中等长度的文字能一眼看全，又不吃掉半屏」的折中（2026-09-06 定）。
 * 到顶之后转成内部滚动，卡片本身不再长。
 */

export const COMPOSER_MIN_ROWS = 2;
export const COMPOSER_MAX_ROWS = 12;

/**
 * 按内容算输入框的目标高度。
 *
 * `scrollHeight` 要在 `height: auto` 之下读，否则量到的是上一次设定的高度、只涨不落。
 * 行高与竖向 padding 都从实际样式来——token 改了这里自动跟随，不写死 22px。
 */
export function composerBoxHeight(
  scrollHeight: number,
  lineHeight: number,
  verticalPadding: number,
  minRows: number = COMPOSER_MIN_ROWS,
  maxRows: number = COMPOSER_MAX_ROWS,
): { height: number; scrollable: boolean } {
  const min = lineHeight * minRows + verticalPadding;
  const max = lineHeight * maxRows + verticalPadding;
  return {
    height: Math.min(Math.max(scrollHeight, min), max),
    // 恰好顶到上限不算溢出：多挂一条滚动轨只是噪音
    scrollable: scrollHeight > max,
  };
}
