/**
 * IconButton 自绘 tooltip 的定位口径——首帧定位共用这一份算式。
 *
 * 为什么要独立成纯模块：定位规则会被争论（「上方放不放得下」「夹不夹回视口」），
 * 争论的东西必须能单测——`IconButton.tsx` import React，进不了 `node --test`
 * （同 `menu-position.ts` 的理由）。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 */

/** tooltip 离锚点按钮的间距、离视口边的最小边距 */
export const TOOLTIP_GAP = 6;
export const TOOLTIP_EDGE = 8;

/** 定位需要的锚点几何（getBoundingClientRect 的形状子集） */
export interface TooltipAnchorBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TooltipPlacement {
  top: number;
  left: number;
  /**
   * false = 按钮已整个滚出视口。追出去是把 tooltip 挂在天上——
   * 调用方该直接不显示，而不是浮一个看不见锚点的牌子。
   */
  visible: boolean;
}

/**
 * tooltip 优先开在锚点**上方**（水平居中对齐按钮）；上方距视口顶不足（顶缘会
 * 压过 8px 边距）时翻转到**下方**。两边都放不下时走下方——上方是首选方向，
 * 但下方是「翻转」的落点，失败也失败在翻转后的位置上。水平方向居中后夹回
 * 视口 8px 边距：宁可不对齐，也不要有一半在屏幕外。
 */
export function placeTooltip(
  anchor: TooltipAnchorBox,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
): TooltipPlacement {
  if (anchor.bottom <= 0 || anchor.top >= viewport.height) {
    return { top: 0, left: 0, visible: false };
  }
  const fitsAbove = anchor.top - TOOLTIP_GAP - tooltip.height >= TOOLTIP_EDGE;
  const top = fitsAbove
    ? anchor.top - TOOLTIP_GAP - tooltip.height
    : anchor.bottom + TOOLTIP_GAP;
  const centered = anchor.left + (anchor.right - anchor.left - tooltip.width) / 2;
  // 下界保护：tooltip 比视口还宽时，max 会算出负数——夹回 8px 而不是负值
  const maxLeft = Math.max(TOOLTIP_EDGE, viewport.width - tooltip.width - TOOLTIP_EDGE);
  const left = Math.min(Math.max(TOOLTIP_EDGE, centered), maxLeft);
  return { top, left, visible: true };
}

/**
 * tooltip 打开期间，指针是否已经离开触发它的按钮——用于兜住 `mouseleave` 收不到
 * 的场景（指针从按钮直接滑进 `-webkit-app-region: drag` 区，或快速甩出窗口）。
 * 边界算「在框内」（`<=`/`>=`），不是「严格小于」：指针停在按钮边缘像素上不该
 * 被判成已经离开。
 */
export function isPointerOutsideAnchor(
  point: { x: number; y: number },
  anchor: TooltipAnchorBox,
): boolean {
  return (
    point.x < anchor.left || point.x > anchor.right || point.y < anchor.top || point.y > anchor.bottom
  );
}
