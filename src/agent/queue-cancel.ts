/**
 * 排队项取消的重放规划 —— 纯函数，runtime 的可测内核。
 *
 * pi 没有单条删除的 API（只有 clearQueue 全清），「取消排队」要靠
 * clearQueue + 把剩余条目按原队列原顺序重放回去。本模块只算「重放序列」，
 * 不碰 session——runtime 先 clearQueue 拿到真值，喂进来，再按返回序列逐条入队。
 * （改写排队内容不走这里：UI 把该条收回输入框，用户改完重新发送即再入队。）
 */

/** 一条排队消息的去向：steer = 插队（工具边界注入），followUp = 等本轮结束。 */
export interface QueueEntryPlan {
  text: string;
  as: "steer" | "followUp";
}

/**
 * 规划一次取消的重放序列。
 *
 * index / text 与队列现状不符时（投递或并发操作刚发生）返回「原样重放」——
 * 队列已被调用方清空，不重放就等于把别人的排队消息丢了。调用方无法区分
 * 「操作落空」与「正常重放」，也不需要：queue 事件会把 UI 校准到真相。
 */
export function planQueueCancel(
  steering: readonly string[],
  followUp: readonly string[],
  index: number,
  text: string,
): QueueEntryPlan[] {
  const merged = [...steering, ...followUp];
  const skip = merged[index] === text ? index : -1;
  const plans: QueueEntryPlan[] = [];
  for (const [i, entry] of merged.entries()) {
    if (i === skip) continue;
    // 原 steering 段保持插队
    const as = i < steering.length ? "steer" : "followUp";
    plans.push({ text: entry, as });
  }
  return plans;
}
