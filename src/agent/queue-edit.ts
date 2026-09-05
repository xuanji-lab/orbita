import { locateQueued } from "./queue-locate.ts";

/**
 * 排队队列改动的重放规划 —— 纯函数，runtime 的可测内核。
 *
 * pi 没有单条删除 / 挪队的 API（只有 clearQueue 全清），「撤回」「调顺序」
 * 都要靠 clearQueue + 把剩余条目按新顺序重放回去。本模块只算「重放序列」，
 * 不碰 session——runtime 先 clearQueue 拿到真值，喂进来，再按返回序列逐条入队。
 */

/** 一条排队消息的去向：steer = 插队（工具边界注入），followUp = 等本轮结束。 */
export interface QueueEntryPlan {
  text: string;
  as: "steer" | "followUp";
}

/**
 * 规划一次队列改动的重放序列。
 *
 * 目标用 `locateQueued` 找：下标只是提示，文本才是用户意图的载体——
 * 队列一变下标就过期，而它变得很频繁。真的找不到（已投递）则「原样重放」：
 * 队列已被调用方清空，不重放就等于把别人的排队消息丢了。调用方无法区分
 * 「操作落空」与「正常重放」，也不需要：queue 事件会把 UI 校准到真相。
 *
 * `as`（steer / followUp）**按重放后的位置重新判定**，不跟着条目走：
 * 把一条挪进前面的 steering 段，它就该变成插队——位置就是投递时机，
 * 这正是用户拖它过去的目的。
 */
export function planQueueEdit(
  steering: readonly string[],
  followUp: readonly string[],
  index: number,
  text: string,
  op: "cancel" | "move",
  toIndex?: number,
): QueueEntryPlan[] {
  const merged = [...steering, ...followUp];
  const at = locateQueued(merged, index, text);
  const ordered = [...merged];
  if (at !== null) {
    if (op === "cancel") {
      ordered.splice(at, 1);
    } else if (toIndex !== undefined && toIndex >= 0 && toIndex < merged.length) {
      const [moved] = ordered.splice(at, 1);
      if (moved !== undefined) ordered.splice(toIndex, 0, moved);
    }
  }
  // steering 段长度：move 不增删所以不变；cancel 掉段内一条则跟着收一格——
  // 否则后面那条会被白白「提升」成插队，用户没请求过这件事
  const cancelledFromSteering = at !== null && op === "cancel" && at < steering.length;
  const steerCount = Math.min(
    steering.length - (cancelledFromSteering ? 1 : 0),
    ordered.length,
  );
  return ordered.map((entry, i) => ({
    text: entry,
    as: i < steerCount ? "steer" : "followUp",
  }));
}
