/**
 * 拖放落点换算 —— 纯函数，QueueStrip 的可测内核。
 *
 * 拖拽给出的是「落在哪一行的上半还是下半」，队列要的是「移除源条目之后插到第几位」。
 * 这中间差一格：源在目标前面时，先把它抽走会让后面所有下标前移一位。
 * 这一格就是拖拽排序最容易错的地方，单独抽出来钉住。
 */

/** 落在目标行的上半还是下半。 */
export type DropPlacement = "before" | "after";

/**
 * 把「拖到某行的上/下半」换算成 `move` 命令的 `toIndex`。
 *
 * @returns 目标下标；与源同位（等于没挪）时返回 null，调用方直接不发命令。
 */
export function resolveDropIndex(
  sourceIndex: number,
  targetIndex: number,
  placement: DropPlacement,
): number | null {
  const insertAt = placement === "before" ? targetIndex : targetIndex + 1;
  // 源在插入点前面：抽走它之后，插入点跟着前移一格
  const toIndex = sourceIndex < insertAt ? insertAt - 1 : insertAt;
  return toIndex === sourceIndex ? null : toIndex;
}

/** 鼠标在元素内的竖直位置 → 上半 / 下半。 */
export function placementFromOffset(offsetY: number, height: number): DropPlacement {
  return offsetY < height / 2 ? "before" : "after";
}
