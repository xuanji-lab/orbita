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

/**
 * 轮末预先压缩的提前量：窗口的 5%，夹在 4096–16384 token。
 *
 * 内核（pi-durable generation.js 的 thresholdCompaction）在**下一次生成前**判：上一条回答的 usage + 其后消息的估算
 * > 窗口 − reserveTokens 就先阻塞压缩。轮末时「其后消息」还没有——下一句用户的话、新的系统段都要加上去，
 * 所以轮末的判据要比内核早一截：正好卡在线下的话，下一句一来又被挡。提前量取多大是取舍：
 * 太小挡不住稍长的下一句；太大会过早压缩（压缩有损，还多一次摘要调用）。一般的一句话 < 1k token、
 * 贴一段材料几 k，5% 在 64k 窗口是 4k（下限），200k 是 10k，1M 窗口封顶 16k。
 */
export function compactionLeadTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(16384, Math.max(4096, Math.round(contextWindow * 0.05)));
}

/**
 * 轮末要不要在后台把压缩先做掉：按这一轮最后的上下文占用，「再来一轮就会触发内核的阻塞压缩」时为真。
 * 判据与内核对齐（tokens > 窗口 − reserveTokens），再提前 compactionLeadTokens。
 * 自动压缩关着、窗口或占用未知（压缩之后还没有新回答）时一律不压。
 *
 * **派出去的活（有 parentId 的子会话）不预先压**（2026-11-17 主会话裁决）：子会话一轮结束多半就是交活了，
 * 不会再有下一轮，预先压一次是白花一次摘要的钱；真有下一轮（父会话回了话）照旧走内核的阻塞压缩，那时没人在等第一个字。
 * 只有用户直接面对的会话（主智能体、普通任务）轮末预先压。
 */
export function compactAheadDue(input: { enabled: boolean; delegated: boolean; contextTokens: number | null; contextWindow: number; reserveTokens: number }): boolean {
  const { enabled, delegated, contextTokens, contextWindow, reserveTokens } = input;
  if (delegated) return false;
  if (!enabled || contextTokens === null || !Number.isFinite(contextTokens) || contextTokens <= 0) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return contextTokens + compactionLeadTokens(contextWindow) > contextWindow - reserveTokens;
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

/**
 * pi 的两种「压不了」是预期拒绝而不是故障（见 compaction.js prepareCompaction 的守卫），
 * 直接透传英文会让人以为系统坏了；其余报错照原样走。
 */
export function compactionErrorText(raw: string): string {
  if (raw === "Already compacted") {
    return "Already compacted — nothing new since the last one. Continue the conversation, then compact again.";
  }
  if (raw === "Nothing to compact (session too small)") {
    return "This conversation is too short — not enough context worth compacting.";
  }
  return raw;
}
