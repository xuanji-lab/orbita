/**
 * 菜单的定位口径——`Menu` 开着时的滚动跟随与首帧定位共用这一份算式。
 *
 * 为什么要独立成纯模块：定位规则会被争论（「下方装不下翻上去」「横向宁可不对齐
 * 也不出屏」「锚点滚出视口该关门还是跟出去」），争论的东西必须能单测——
 * `Menu.tsx` import React，进不了 `node --test`。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 */

/** 菜单离触发点、离窗口边的余量 */
export const MENU_GAP = 6;
export const MENU_EDGE = 8;

/** 定位需要的锚点与菜单几何（getBoundingClientRect 的形状子集） */
export interface MenuBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /**
   * false = 锚点已整个滚出视口。追过去是把菜单挂在天上——调用方该关门，
   * 而不是把一个看不见锚点的浮层留在屏幕上。
   */
  visible: boolean;
}

/**
 * 默认向下、下方装不下且上方装得下才翻上去；横向向 align 对齐后夹回窗口内
 * ——宁可不对齐，也不要有一半在屏幕外。
 */
export function placeMenu(
  anchor: MenuBox,
  menu: { width: number; height: number },
  align: "start" | "end" | undefined,
  viewport: { width: number; height: number },
): MenuPlacement {
  if (anchor.bottom <= 0 || anchor.top >= viewport.height) {
    return { top: 0, left: 0, visible: false };
  }
  const below = anchor.bottom + MENU_GAP;
  const fitsBelow = below + menu.height + MENU_EDGE <= viewport.height;
  const fitsAbove = anchor.top - MENU_GAP - menu.height - MENU_EDGE >= 0;
  const top = fitsBelow || !fitsAbove ? below : anchor.top - MENU_GAP - menu.height;
  const wanted = align === "end" ? anchor.right - menu.width : anchor.left;
  const left = Math.min(Math.max(MENU_EDGE, wanted), viewport.width - menu.width - MENU_EDGE);
  return { top, left, visible: true };
}
