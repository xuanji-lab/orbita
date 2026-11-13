/**
 * 控件与图标的台阶（设计系统 readme *Controls stand on steps*）——纯函数，node:test 直接测。
 *
 * 2026-10-29 全应用审计：按钮高度 14 种（18–48px）、图标按钮 8 种、图标字形 10 种（10–22px）。
 * 每处单看都「差不多」，放在一起就是毛边。台阶在组件里落地，调用方传什么都被吸到最近的
 * 上一档：调用点照旧写数字，不用逐个改；新写的也越不过台阶。
 *
 * - 图标按钮外框：24（行内 / 列表里）· 28（胶囊、面板头、右栏）· 32（大号）；更大的
 *   （灯箱的 36）不是控件条上的键，原样放行。
 * - 图标字形：12（行内注脚、芯片）· 14（列表行）· 16（工具栏、面板头）；10px 以下是
 *   装饰性的点（文件树的状态点），20 以上是插图 / 头像，都原样放行。
 */

/** 图标按钮外框的台阶 */
export const CONTROL_STEPS = [24, 28, 32] as const;

/** 图标字形的台阶 */
export const ICON_STEPS = [12, 14, 16] as const;

/** 外框吸到最近的上一档；超过最大档的原样返回（非控件条上的大按钮） */
export function controlBox(size: number): number {
  for (const step of CONTROL_STEPS) if (size <= step) return step;
  return size;
}

/** 字形吸到最近的上一档；< 10 的装饰点与 > 16 的插图原样返回 */
export function iconSize(size: number): number {
  if (size < 10 || size > 16) return size;
  for (const step of ICON_STEPS) if (size <= step) return step;
  return size;
}
