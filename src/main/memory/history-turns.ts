/**
 * 从历史生成的轮收集（纯核）——从一条会话的**生效视图**转录（sessions.load 已折叠回退，
 * 被「回到这里」撤掉的轮不在里面）切出可以喂给记忆服务的轮。
 *
 * 口径与实时路径（turn-tracker.ts）逐条对齐，否则去重对不上账、提取的输入也不一样：
 * - **轮号** = 该 user 记录在转录 user 记录里的位置（turnNumberOf 同口径，1 起）；
 *   通道标记不是 user 记录，不占轮号，但它开的那一轮（子会话回报）是轮边界——
 *   它之后的回答不能算到前一轮用户话头上；
 * - **谁的话**：memoryBuildEligible（根会话、不是通道信封、不是收尾扫描、非空）；
 * - **回答** = 轮内最后一条 assistant 记录，且它正常说完（complete 且不是 toolUse），
 *   取它全部 text 块（实时取的是最后一个 item_finished 终态帧，同一条记录）；最后一帧出错 /
 *   被打断 / 停在工具调用 / 没文字的轮不进；
 * - **截断** = memoryTurnSnapshot（用户话取头、回答取尾）；
 * - **时间** = user 记录的时间戳（实时取回显时间，就是这条记录的 timestamp）。
 *
 * 纯模块（不 import electron），可被 `node --test` 直接测。
 */
import type { MemoryEpisodeTurn } from "../../shared/memory.ts";
import { memoryTurnSnapshot } from "../../shared/memory.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { memoryBuildEligible } from "./turn-tracker.ts";

interface OpenTurn {
  turn: number;
  at: number;
  text: string;
  /** 轮内最后一条 assistant 记录（null = 还没有） */
  last: Extract<SessionRecord, { role: "assistant" }> | null;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/** 一轮结束：回答正常说完、有文字才交出快照。 */
function finish(open: OpenTurn | null, out: MemoryEpisodeTurn[]): void {
  if (open === null) return;
  const { last } = open;
  if (last === null || last.status !== "complete" || last.stopReason === "toolUse") return;
  const answer = textOf(last.content);
  if (answer.trim() === "") return;
  out.push(memoryTurnSnapshot({ turn: open.turn, at: open.at, userText: open.text, assistantText: answer }));
}

/**
 * 一条会话里能喂给记忆服务的轮（时间正序）。meta 只看 parentId：子会话一轮都不出
 * （读记忆不写，与实时同一道门）。
 */
export function historyTurnsOf(
  meta: { parentId?: string },
  transcript: readonly SessionRecord[],
): MemoryEpisodeTurn[] {
  if (meta.parentId !== undefined) return [];
  const out: MemoryEpisodeTurn[] = [];
  let users = 0;
  let open: OpenTurn | null = null;
  for (const record of transcript) {
    if (record.role === "user") {
      finish(open, out);
      users += 1;
      const text = textOf(record.content);
      open = memoryBuildEligible(meta, text) ? { turn: users, at: record.timestamp, text, last: null } : null;
      continue;
    }
    if (record.role === "channel-mark") {
      // 子会话回报开的轮：不是用户的话，它的回答也不归前一轮
      finish(open, out);
      open = null;
      continue;
    }
    if (record.role === "assistant" && open !== null) open.last = record;
  }
  finish(open, out);
  return out;
}

/**
 * 预估一组轮（同一会话、时间正序）要几次家务活调用：间隔 ≥ gapMs 处必然切段（不问模型），
 * 其余相邻轮各一次切段判断；每段三次提取。切段判断还会再切出段，所以这是下限附近的估计。
 */
export function estimateCalls(turns: readonly { at: number }[], gapMs: number): number {
  let episodes = 0;
  let classify = 0;
  let previous: number | null = null;
  for (const turn of turns) {
    if (previous === null || turn.at - previous >= gapMs) episodes += 1;
    else classify += 1;
    previous = turn.at;
  }
  return classify + episodes * 3;
}
