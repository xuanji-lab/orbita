/**
 * 排队卡拖拽的落点语义。纯函数：不 import React，可被 `node --test` 直接加载。
 *
 * 语义与 Proma 同源（`AgentMessageQueue.tsx` 的 resolvePlacement）：鼠标落在目标行的
 * **上半 = 放到它前面，下半 = 放到它后面**——插入线跟着鼠标走，N 条队列有 N+1 条缝，
 * 想插哪条缝就悬到哪条缝。
 *
 * 多做的一件事：**落点是源自己的缝时返回 null**——源的上缝（悬在它上一行的下半）和
 * 下缝（悬在它下一行的上半）落进去等于不动。旧写法照样画线，用户松手后什么都没发生，
 * 感知为「弹回去了」，越相邻越容易撞上（2026-09-11 验收复现）。现在这两条缝不画线，
 * 用户拖到那儿看不到线就知道松手不会动；线一出现，松手必然动。
 */
export type DropPlacement = "before" | "after";

/**
 * 源行下标、目标行下标、鼠标在目标行的哪一半 → 落点语义；null = 落进去等于不动
 * （拖到自己身上，或落进源自己的上/下缝）。
 */
export function dropPlacement(
  sourceIndex: number,
  targetIndex: number,
  half: DropPlacement,
): DropPlacement | null {
  if (sourceIndex === targetIndex) return null;
  // 源的上缝：上一行的下半；源的下缝：下一行的上半
  if (half === "after" && targetIndex === sourceIndex - 1) return null;
  if (half === "before" && targetIndex === sourceIndex + 1) return null;
  return half;
}
