/**
 * token 速度的口径（usage-speed-X）。速度跟着回答走：
 * 落定帧上由 adapter 算好挂上（真值），随 transcript 落盘、重开即回；
 * 流式中的 Responding 行用估算给个活数。
 *
 * 为什么在 shared：真值规则被 adapter（agent 进程）与 renderer（估算共用同一道
 * 噪音门）两-side 消费，规则漂移会让流式数字和落定数字对不上——争论的东西必须
 * 单源且可单测。纯模块：不 import electron / pi / React。
 */

/** 生成不足 500ms 的消息不给速度——除以极小时间会出荒谬瞬时值（Reasonix 验证过的噪音线） */
export const SPEED_MIN_MS = 500;

/**
 * 真值速度：output ÷ 生成秒。输出 0、时长不足门控或不合法返回 null
 * （调用方沿用上一条的值或不显示）。
 */
export function messageSpeed(startTs: number, endTs: number, outputTokens: number): number | null {
  const ms = endTs - startTs;
  if (!(ms >= SPEED_MIN_MS) || !(outputTokens > 0)) return null;
  return outputTokens / (ms / 1000);
}

/**
 * 流式中的 in-flight token 估算：流出字符数 ÷ 4（Reasonix 同款）。
 * **这是英文校准的粗估**——中文约 1 字 ≈ 1 token，会低估数倍；它只活在
 * Responding 行给个活数，落定即被帧上的真值顶替，不落盘、不进任何账本。
 */
export function estimateStreamingTokens(chars: number): number {
  return Math.round(Math.max(0, chars) / 4);
}
