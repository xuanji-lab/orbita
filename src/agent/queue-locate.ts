/**
 * 在排队队列里定位用户点的那一条 —— 纯函数，interrupt 与 queueEdit 共用。
 *
 * UI 传来的 `index` 是**快照下标**，队列一变就过期，而队列变得很频繁：
 * 每次投递、每次撤回、每次「立即发送」的 clearQueue 都会重排下标。
 * 只要用户在 UI 收到新 queue 事件之前按了第二下（连续操作时几乎必然），
 * 下标就对不上了。
 *
 * 真实事故（wafo 2026-09-06）：排 [甲,乙,丙]，先点乙的「立即发送」，
 * 紧接着点丙——丙的下标已从 2 变成 1，精确对账落空，命令被静默丢弃。
 * 用户看到的是「点了没反应」，然后乙跑完时 pi 的 post-run 把甲丙一起投递，
 * 像是「卡了一下然后突然都发出去了」。
 *
 * 所以：**文本才是用户意图的载体，下标只是提示。** 先信下标（正常情况零成本、
 * 且能正确区分重复文本），不中就按文本找第一条。都找不到才是真的没了
 * （那条确实已经投递），此时放弃是对的。
 */

/**
 * @param merged `[...steering, ...followUp]` 拼接视图
 * @returns 目标下标；队列里已经没有这条时返回 null
 */
export function locateQueued(
  merged: readonly string[],
  index: number,
  text: string,
): number | null {
  if (merged[index] === text) return index;
  const found = merged.indexOf(text);
  return found === -1 ? null : found;
}
