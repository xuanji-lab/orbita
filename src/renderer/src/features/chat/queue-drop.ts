/**
 * 排队卡拖拽的落点语义。纯函数：不 import React，可被 `node --test` 直接加载。
 *
 * **落到谁身上就占谁的位置**——与 Providers 设置面的厂商排序同一套语义
 * （`providers-view-model.ts` 的 reorderIds）：源抽走，插到目标当前所在的下标。
 * 悬停反馈是整行描边，不是行间的插入线。
 *
 * 为什么不用「上半 / 下半 → 前 / 后」的缝语义：排队卡通常只有两到五条，
 * 「插到两行之间」的表达力用不上，而半行判定带来的死区（落进源自己的缝等于不动）
 * 与一条 1px 的线，对用户都不如「整行亮起、松手就占它的位」来得直观
 * （2026-09-11 验收后用户裁决：与 Providers 拖拽统一）。
 *
 * 返回 moveQueued 需要的 before / after：源在上方 → 插到目标后面（目标前移一格，
 * 源正好落到目标原来的下标）；源在下方 → 插到目标前面。同一行 null。
 */
export type DropPlacement = "before" | "after";

export function dropPlacement(sourceIndex: number, targetIndex: number): DropPlacement | null {
  if (sourceIndex === targetIndex) return null;
  return sourceIndex < targetIndex ? "after" : "before";
}
