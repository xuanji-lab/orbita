/**
 * 打断的调用序 —— 纯编排，runtime 的可测内核。
 *
 * 「立即发送 = 打断」（wafo 2026-09-03 裁决）：pi 的 steering 只在两次 LLM 响应
 * 之间消化，走插队永远打断不了正在跑的工具。所以出队 → abort → 它自己成为新一轮。
 *
 * 空闲时它也成立：没有「当前轮」可打断，语义退化成「直接发这条」——
 * 对用户是同一件事：别等了，现在就办。此时跳过 abort（空转还会弄出一个
 * aborted 终态）。
 *
 * 这里唯一要守住的是**顺序**，四步各有各的理由，错一步就是一个真 bug：
 *
 * 1. `clearQueue` 必须在 `abort` 之前——否则 post-run 看到还有排队就会自动续轮，
 *    打断变成换人。
 * 2. 其余排队项回队必须在 `prompt` **之前**。`prompt()` 会 await 完整一轮
 *    （`_runAgentPrompt` 连 post-run 续轮一起等），排它后面意味着这些消息
 *    消失一整轮，而且错过 agent loop 在 `agent_end` 前的 drain——回来时只能
 *    干等用户下次发送，「等这一轮结束再投递」根本没发生。
 * 3. 目标用 `locateQueued` 找：下标只是提示，文本才是用户意图的载体。
 *    连续点两条时，第一条的 clearQueue 已经把后面的下标全前移了。
 *    真的找不到（已投递）才整单放弃，宁可不发也不切错人。
 * 4. 原 steering / followUp 之分在打断语境下不再有意义，一律 followUp 回队。
 */

import { locateQueued } from "./queue-locate.ts";

/** 打断要用到的会话能力。只列这几件事，方便测试塞假实现。 */
export interface InterruptOps {
  /** 端走整个队列并拿到真值（pi 没有单条删的 API） */
  clearQueue: () => { steering: readonly string[]; followUp: readonly string[] };
  /** 正在跑一轮吗。空闲时无需 abort，直接发就是 */
  isStreaming: () => boolean;
  abort: () => Promise<void>;
  /** 回队一条（只入队，不触发投递） */
  followUp: (text: string) => Promise<void>;
  /** 本地回显用户消息：pi 随后的 message_start 是它的回声 */
  echoUserPrompt: (text: string) => void;
  /** 开新一轮。**会 await 完整一轮**，所以它必须是最后一步 */
  prompt: (text: string) => Promise<void>;
}

/**
 * 打断当前轮，让队列里第 index 条成为新一轮。
 *
 * @returns 是否执行。false = 对账不中，队列已原样放回，什么都没发生。
 */
export async function interruptWithQueued(
  ops: InterruptOps,
  index: number,
  text: string,
): Promise<boolean> {
  const { steering, followUp } = ops.clearQueue();
  const combined = [...steering, ...followUp];
  const at = locateQueued(combined, index, text);
  if (at === null) {
    // 队列已被端走，不放回就等于把别人的排队消息丢了
    for (const rest of combined) await ops.followUp(rest);
    return false;
  }
  combined.splice(at, 1);
  // 空闲时不打断：没有在跑的一轮，abort 只会多制造一个 aborted 终态
  if (ops.isStreaming()) await ops.abort();
  // 先回队再开新轮——见上面第 2 条
  for (const rest of combined) await ops.followUp(rest);
  ops.echoUserPrompt(text);
  await ops.prompt(text);
  return true;
}
