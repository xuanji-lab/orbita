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
 * 菜单开在锚点的哪一边。
 * - `below`（默认）：锚点下方，装不下翻上去。
 * - `right`：锚点**右侧**，左缘贴锚点右缘 + GAP、顶边与锚点顶边对齐。给侧栏会话行用——
 *   开在下方会盖住紧挨着的下一条会话，用户要看别的会话就得先关菜单（2026-09-22 wafo）。
 *   右侧装不下（窄窗）时回落到 `below`，不做「向左翻」的第三种形态：那等于又盖回列表。
 */
export type MenuPlacementSide = "below" | "right";

/**
 * 默认向下、下方装不下且上方装得下才翻上去；横向向 align 对齐后夹回窗口内
 * ——宁可不对齐，也不要有一半在屏幕外。
 */
export function placeMenu(
  anchor: MenuBox,
  menu: { width: number; height: number },
  align: "start" | "end" | undefined,
  viewport: { width: number; height: number },
  side: MenuPlacementSide = "below",
): MenuPlacement {
  if (anchor.bottom <= 0 || anchor.top >= viewport.height) {
    return { top: 0, left: 0, visible: false };
  }
  if (side === "right") {
    const left = anchor.right + MENU_GAP;
    // 右侧真的装得下才开在右侧；装不下就当没要求过，走下方那套
    if (left + menu.width + MENU_EDGE <= viewport.width) {
      // 纵向与行顶对齐，越界夹回视口内；上下都不够时保住顶边（宁可截尾，不截头）
      const top = Math.max(
        MENU_EDGE,
        Math.min(anchor.top, viewport.height - menu.height - MENU_EDGE),
      );
      return { top, left, visible: true };
    }
  }
  const below = anchor.bottom + MENU_GAP;
  const fitsBelow = below + menu.height + MENU_EDGE <= viewport.height;
  const fitsAbove = anchor.top - MENU_GAP - menu.height - MENU_EDGE >= 0;
  const top = fitsBelow || !fitsAbove ? below : anchor.top - MENU_GAP - menu.height;
  const wanted = align === "end" ? anchor.right - menu.width : anchor.left;
  const left = Math.min(Math.max(MENU_EDGE, wanted), viewport.width - menu.width - MENU_EDGE);
  return { top, left, visible: true };
}
