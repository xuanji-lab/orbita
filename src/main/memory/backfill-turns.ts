/**
 * 补蒸的轮收集（纯核）——从一条会话的记录里切出「待蒸的轮」。
 *
 * 口径对齐三条既有真相：
 * - **轮号**与 read_task / 实时蒸馏同口径：`numberRounds`（user 记录与通道标记
 *   都开轮，1 起）——账本按 (sessionId, turn) 记，口径错了补蒸与实时就对不上账。
 * - **只蒸正常结束的轮**（memory-distill.ts 的判定同款规则，搬到盘上记录的形状）：
 *   轮内最后一条 assistant 的 stopReason 不是 aborted / error、且有文本；轮内
 *   没有 assistant（还没回答就被打断 / 崩溃残留）同样不蒸——绝不拿上一轮的回答
 *   配这一轮的提问。
 * - **范围按轮发生的时间截**（用户消息时间戳）：一条长会话可能一半在范围里一半
 *   不在，只蒸范围内那一半。
 *
 * 通道标记轮（父会话收到子会话回报开的那轮）也算轮：实时蒸馏蒸它们（信封文本
 * 作为 userText 进蒸馏），补蒸同样要蒸——正文从通道账本取（比信封干净），
 * 取不到（账本坏了 / 从别的应用导入）就跳过这轮，不蒸也不算已蒸。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import type { MemoryBackfillRange, MemoryBackfillEstimate } from "../../shared/memory.ts";
import { isChannelMarkRecord, type SessionRecord } from "../../shared/session.ts";
import { numberRounds } from "../session/read-task.ts";

/** 范围下界（epoch ms；早于它的轮不进补蒸）。"all" 恒 0（全部历史）。 */
export function rangeStart(range: MemoryBackfillRange, now: number): number {
  if (range === "all") return 0;
  const days: Record<Exclude<MemoryBackfillRange, "all">, number> = { "1m": 30, "3m": 91, "6m": 182 };
  return now - days[range] * 24 * 60 * 60 * 1000;
}

/** 一条待蒸轮（发给 agent 进程的最小载荷，模型退路在编排层另配）。 */
export interface BackfillTurn {
  sessionId: string;
  turn: number;
  /** 轮发生时刻（用户消息 / 通道标记的时间戳）——蒸馏 prompt 的日期按它换算 */
  at: number;
  userText: string;
  assistantText: string;
  /** 会话归属（冲突候选按它挑作用域） */
  scope: { workspaceId: string | null; cwd: string };
  /** 两个文本的字符量（预估 token 用；收集时顺手记，免得二次遍历） */
  chars: number;
  /** 该会话自己的模型（choreModel 缺席时的退路；收集时从 meta 顺手带出） */
  model?: { providerId: string; modelId: string };
}

/** 一条会话的收集结果。 */
export interface SessionTurnCollection {
  pending: BackfillTurn[];
  /** 范围内已蒸过（账本里有）而跳过的轮数 */
  skippedTurns: number;
}

/** 拼一条消息记录里全部 text 块（think / toolCall / 图片块不算文本）。 */
function textBlocksOf(record: SessionRecord | undefined): string {
  if (
    record === undefined ||
    isChannelMarkRecord(record) ||
    record.role === "compacted" ||
    record.role === "file-turn" ||
    record.role === "revert" ||
    record.role === "undo" ||
    record.role === "tool"
  ) {
    return "";
  }
  const parts: string[] = [];
  for (const block of record.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/** 轮内最后一条 assistant 记录；没有返回 null。 */
function lastAssistantOf(records: readonly SessionRecord[], from: number, to: number): SessionRecord | null {
  for (let index = to - 1; index >= from; index -= 1) {
    const record = records[index];
    if (record !== undefined && record.role === "assistant") return record;
  }
  return null;
}

/**
 * 收集一条会话的待蒸轮。`channelTexts` 是通道标记 messageId → 正文（读不到的
 * 标记轮整个跳过）；`distilled` 是账本里该会话已蒸的轮号。
 */
export function collectSessionTurns(input: {
  sessionId: string;
  meta: { workspaceId: string | null; cwd: string };
  records: readonly SessionRecord[];
  channelTexts: ReadonlyMap<string, string> | null;
  distilled: ReadonlySet<number>;
  since: number;
  /** 该会话自己的模型（meta 的 providerId/modelId，退路用；缺席就没有） */
  model?: { providerId: string; modelId: string };
}): SessionTurnCollection {
  const scope = { workspaceId: input.meta.workspaceId, cwd: input.meta.cwd };
  const pending: BackfillTurn[] = [];
  let skippedTurns = 0;
  for (const round of numberRounds(input.records)) {
    const opener = input.records[round.startIndex];
    if (opener === undefined) continue;
    // 轮的用户文本与时刻：普通用户消息，或通道标记（正文在通道账本）
    let userText: string | null;
    let at: number;
    if (isChannelMarkRecord(opener)) {
      userText = input.channelTexts?.get(opener.messageId) ?? null;
      at = opener.timestamp;
    } else if (opener.role === "user") {
      userText = textBlocksOf(opener);
      at = opener.timestamp;
    } else {
      continue;
    }
    // 范围按轮发生的时间截（用户消息时间戳）
    if (at < input.since) continue;
    // 账本里已有：跳过（含实时蒸过与上次补蒸过的）
    if (input.distilled.has(round.number)) {
      skippedTurns += 1;
      continue;
    }
    // 通道正文取不到：跳过这轮（不蒸也不记账，下次账本修好再试）
    if (userText === null) continue;
    // 只蒸正常结束的轮（同 memory-distill.ts 的判定：最后一条 assistant 的
    // stopReason 不是 aborted / error、且有文本；没有 assistant 的轮不蒸）
    const last = lastAssistantOf(input.records, round.startIndex, round.endIndex);
    if (last === null || last.role !== "assistant") continue;
    // streaming 变体没有 stopReason（盘上不应存在，防御性读取）；aborted / error 不蒸
    const stopReason: string | undefined = (last as { stopReason?: string }).stopReason;
    if (stopReason === "aborted" || stopReason === "error") continue;
    const assistantText = textBlocksOf(last);
    // 实时蒸馏的判定同款：最后一条 assistant 有文本才蒸（纯工具轮、空回答不蒸）
    if (assistantText.trim() === "") continue;
    pending.push({
      sessionId: input.sessionId,
      turn: round.number,
      at,
      userText,
      assistantText,
      scope,
      chars: userText.length + assistantText.length,
      model: input.model,
    });
  }
  return { pending, skippedTurns };
}

/**
 * 粗估输入 token（量级即可，契约原话「按字符数折算」）：正文按中英混排折
 * 1 token ≈ 1.6 字符，再加每轮的固定开销（系统提示词 + 标签包装 ≈ 1200 字符）。
 */
export function estimateInputTokens(chars: number, turns: number): number {
  return Math.ceil((chars + turns * 1200) / 1.6);
}

/** 组装 MemoryBackfillEstimate（编排层收集完全部会话后调）。 */
export function backfillEstimateOf(input: {
  range: MemoryBackfillRange;
  sessions: number;
  turns: number;
  skippedTurns: number;
  chars: number;
  choreModel: { providerId: string; modelId: string } | null;
}): MemoryBackfillEstimate {
  return {
    range: input.range,
    sessions: input.sessions,
    turns: input.turns,
    skippedTurns: input.skippedTurns,
    estimatedInputTokens: estimateInputTokens(input.chars, input.turns),
    choreModel: input.choreModel,
  };
}
