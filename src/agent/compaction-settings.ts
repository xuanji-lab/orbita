/**
 * 用户压缩偏好 → pi 压缩参数的换算层（A-1）。**纯模块**：不 import electron，
 * 可被 `node --test` 直接加载。
 *
 * 契约（src/shared/settings.ts）给的是「剩余百分比 + 开关」；pi 认的是
 * `reserveTokens / keepRecentTokens` 绝对值。换算发生在 runtime 开轮时、
 * 按本轮模型的窗口算（agent-session 的压缩判定也是拿当前模型的窗口比）。
 */

import { COMPACTION_DEFAULT, COMPACTION_PERCENT } from "../shared/settings.ts";

/** pi 出厂的 reserveTokens。仅当窗口未知（0/非数）时退它——不知道窗口就不乱调。 */
const PI_DEFAULT_RESERVE_TOKENS = 16384;

/**
 * 保留量（pi 的 keepRecentTokens）：压缩时**原样保留**的最近对话量，不暴露给用户——
 * 它与剩余百分比耦合（两个旋钮互相牵制），内部按窗口钳制：min(2 万, 窗口的 25%)。
 * pi 出厂 2 万对 ≤16k 窗口的模型大于整个窗口（保留量吞掉全部上下文），必须钳。
 */
export function compactionKeepRecentTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 20000;
  return Math.min(20000, Math.floor(contextWindow * 0.25));
}

/**
 * 剩余百分比 → pi 的 reserveTokens。越界与非数一律按出厂 20% 处理——
 * 与 parseSettings 的钳制同一语义（正常输入已被它归一化，这里对齐是兜手改直灌）。
 */
export function compactionReserveTokens(reservePercent: number, contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return PI_DEFAULT_RESERVE_TOKENS;
  const percent =
    Number.isFinite(reservePercent) &&
    reservePercent >= COMPACTION_PERCENT.min &&
    reservePercent <= COMPACTION_PERCENT.max
      ? reservePercent
      : COMPACTION_DEFAULT.reservePercent;
  return Math.round((contextWindow * percent) / 100);
}

/** 本轮的时间语义：回显时间戳 + 这轮出没出过 assistant 产物。runtime 开轮时创建。 */
export interface TurnTiming {
  /**
   * 用户消息回显落盘的时间戳（submit / interrupt 的 echo 头一帧）。手动压缩轮
   * 没有 echo，恒为 null。
   */
  echoedAt: number | null;
  /** 这轮出过 assistant 消息没有——预检压缩（prompt 前那一次）发生在它之前。 */
  sawAssistant: boolean;
}

/**
 * 压缩界碑的时间戳（A-1 的界碑顺序修复）。
 *
 * **预检压缩**（pi 在 `prompt()` 里先 `_checkCompaction` 再追加用户消息，
 * agent-session.js:864-868）发生时，我们的回显已经落盘——界碑若盖当下时间，
 * 会画在刚发那句**之后**，而摘要不含那句。解法：盖**回显的时间戳**；
 * mergeCompactions 的排序在同毫秒平局时界碑排前（session-states.ts），
 * 界碑于是落到那句之前——渲染层零改动，磁盘上的界碑与 pi 本子的先后一致。
 *
 * 轮内压缩（threshold/overflow，跑在 assistant 消息之间）照旧用当下时间：
 * 按时间戳自然插进消息流，位置本来就是对的一半。
 */
export function compactionBoundaryTimestamp(turn: TurnTiming, now: number): number {
  return !turn.sawAssistant && turn.echoedAt !== null ? turn.echoedAt : now;
}
