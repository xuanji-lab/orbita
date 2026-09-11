/**
 * token 速度的口径。速度跟着**整轮回答**走：
 * adapter 在每条 assistant 消息的终态帧上挂 `genMs`（本条的纯生成时长，message_start
 * 到 message_end 的钟——工具执行在两条消息之间，天然不计入），随 transcript 落盘；
 * renderer 把一轮里所有消息的 `usage.output` 与 `genMs` 各自求和再相除，得到轮的真值。
 * 流式中的 Responding 行用估算给个活数。
 *
 * 为什么按整轮而不按单条：pi 每次 toolCall 都结束当前消息，「说一句 → 跑工具 → 再说一句」
 * 是两三条记录；末条常常只有十几个 token、几百毫秒，单条算既过不了噪音门也不代表这轮。
 * 一轮的输出与耗时加总才是用户感知的「这次回答多快」（2026-09-11 验收复现）。
 *
 * 为什么在 shared：真值规则被 adapter（agent 进程）与 renderer（估算共用同一道
 * 噪音门）两侧消费，规则漂移会让流式数字和落定数字对不上——争论的东西必须
 * 单源且可单测。纯模块：不 import electron / pi / React。
 */

/** 累计生成不足 500ms 不给速度——除以极小时间会出荒谬瞬时值。门槛作用于整轮的加总，不是单条。 */
export const SPEED_MIN_MS = 500;

/**
 * 真值速度：output ÷ 生成秒。输出 0、时长不足门控或不合法返回 null（调用方不显示）。
 * 参数是**已加总**的量：单条消息传它自己的，整轮传各条的和。
 */
export function messageSpeed(genMs: number, outputTokens: number): number | null {
  if (!(genMs >= SPEED_MIN_MS) || !(outputTokens > 0)) return null;
  return outputTokens / (genMs / 1000);
}

/**
 * 流式中的 in-flight token 估算：流出字符数 ÷ 4。**这是英文校准的粗估**——
 * 中文约 1 字 ≈ 1 token，会低估数倍；它只活在 Responding 行给个活数，
 * 落定即被轮的真值顶替，不落盘、不进任何账本。
 */
export function estimateStreamingTokens(chars: number): number {
  return Math.round(Math.max(0, chars) / 4);
}
