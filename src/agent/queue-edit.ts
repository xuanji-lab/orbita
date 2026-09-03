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
 * edit 改写目标条目的文本，保持它原属的队列与顺位。
 */
export function planQueueEdit(
	steering: readonly string[],
	followUp: readonly string[],
	index: number,
	text: string,
	op: "cancel" | "edit",
	newText?: string,
): QueueEntryPlan[] {
	const merged = [...steering, ...followUp];
	const target = merged[index];
	const hits = target === text;
	const plans: QueueEntryPlan[] = [];
	for (const [i, entry] of merged.entries()) {
		const isTarget = hits && i === index;
		if (op === "cancel" && isTarget) continue;
		const replacement = op === "edit" && isTarget ? (newText ?? entry) : entry;
		// 原 steering 段保持插队
		const as = i < steering.length ? "steer" : "followUp";
		plans.push({ text: replacement, as });
	}
	return plans;
}
