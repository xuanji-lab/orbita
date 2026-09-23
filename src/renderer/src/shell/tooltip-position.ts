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

export interface PlaceTooltipOptions {
  /**
   * 优先摆在锚点哪一侧，另一侧放不下才翻过去。默认 `"above"`——IconButton 的
   * 既有行为：优先上方，上方距视口顶不足时翻转到下方。skill 行传 `"below"`：
   * 优先下方（不挡住上面可能紧挨着的过滤框），下方放不下才翻上去。两侧都放
   * 不下时，落在「翻转后」的那一侧——首选方向失败也失败在翻转后的位置上。
   */
  side?: "above" | "below";
  /**
   * 水平对齐。默认 `"center"`——水平居中对齐锚点（IconButton 的既有行为）。
   * `"start"` 贴锚点左缘，再加 `alignOffset`（skill 行：左缘 + 10px）。
   * 两种对齐算出来的位置都还要夹回视口 8px 边距。
   */
  align?: "center" | "start";
  /** `align: "start"` 时，锚点左缘到 tooltip 左缘的偏移量。默认 0。 */
  alignOffset?: number;
}

/**
 * tooltip 优先开在锚点某一侧（`side`，默认上方）；那一侧放不下时翻转到另一侧。
 * 两侧都放不下时落在翻转后的位置——首选方向失败也失败在翻转后的位置上。
 * 水平方向按 `align` 算出对齐位置后夹回视口 8px 边距：宁可不对齐，也不要有
 * 一半在屏幕外。
 */
export function placeTooltip(
  anchor: TooltipAnchorBox,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  options: PlaceTooltipOptions = {},
): TooltipPlacement {
  const side = options.side ?? "above";
  const align = options.align ?? "center";
  const alignOffset = options.alignOffset ?? 0;

  if (anchor.bottom <= 0 || anchor.top >= viewport.height) {
    return { top: 0, left: 0, visible: false };
  }

  const above = anchor.top - TOOLTIP_GAP - tooltip.height;
  const below = anchor.bottom + TOOLTIP_GAP;
  const fitsAbove = above >= TOOLTIP_EDGE;
  const fitsBelow = below + tooltip.height <= viewport.height - TOOLTIP_EDGE;
  const top =
    side === "below" ? (fitsBelow ? below : above) : fitsAbove ? above : below;

  const centered = anchor.left + (anchor.right - anchor.left - tooltip.width) / 2;
  const aligned = align === "start" ? anchor.left + alignOffset : centered;
  // 下界保护：tooltip 比视口还宽时，max 会算出负数——夹回 8px 而不是负值
  const maxLeft = Math.max(TOOLTIP_EDGE, viewport.width - tooltip.width - TOOLTIP_EDGE);
  const left = Math.min(Math.max(TOOLTIP_EDGE, aligned), maxLeft);
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
