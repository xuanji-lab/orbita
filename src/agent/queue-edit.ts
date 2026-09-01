/**
 * 排队编辑的重放规划 —— 纯函数，runtime 的可测内核。
 *
 * pi 没有单条删除 / 挪队的 API（只有 clearQueue 全清），「立即插队」「取消」
 * 都要靠 clearQueue + 把剩余条目按新顺序重放回去。本模块只算「重放序列」，
 * 不碰 session——runtime 先 clearQueue 拿到真值，喂进来，再按返回序列逐条入队。
 */

/** 一条排队消息的去向：steer = 插队（工具边界注入），followUp = 等本轮结束。 */
export interface QueueEntryPlan {
	text: string;
	as: "steer" | "followUp";
}

/**
 * 规划一次队列编辑的重放序列。
 *
 * index / text 与队列现状不符时（投递或并发编辑刚发生）返回「原样重放」——
 * 队列已被调用方清空，不重放就等于把别人的排队消息丢了。调用方无法区分
 * 「操作落空」与「正常重放」，也不需要：queue 事件会把 UI 校准到真相。
 *
 * promote 对 steering 段的项是 no-op（已在插队），按原样重放。
 */
export function planQueueEdit(
	steering: readonly string[],
	followUp: readonly string[],
	index: number,
	text: string,
	op: "promote" | "cancel",
): QueueEntryPlan[] {
	const merged = [...steering, ...followUp];
	const target = merged[index];
	const hits = target === text;
	const plans: QueueEntryPlan[] = [];
	for (const [i, entry] of merged.entries()) {
		if (op === "cancel" && hits && i === index) continue;
		// 原 steering 段保持插队；promote 命中的那条从 followUp 提到 steer
		const as = i < steering.length || (op === "promote" && hits && i === index) ? "steer" : "followUp";
		plans.push({ text: entry, as });
	}
	return plans;
}
