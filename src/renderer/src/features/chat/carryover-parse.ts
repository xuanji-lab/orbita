/**
 * 收尾扫描在 renderer 这一侧的纯函数：取扫描回答、消息流里认出扫描回答、
 * 遗留事项的锚点。prompt 与严格解析在 shared/wrapup-scan.ts（与主进程共用）。
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { SubmitAgentInput } from "@shared/agent-ipc";
import type { WrapupPlan } from "@shared/wrapup";
import { buildClosingScanPrompt, parseWrapupBlock, soleFencedJson } from "../../../../shared/wrapup-scan.ts";

/**
 * 扫描轮落定后，从转录里取**解析输入**：基线之后最后一条已完成的 assistant
 * 消息的全部 text 块拼接。null = 这一轮根本没出现可用的回答。
 *
 * 三个口径各有来历：
 *   - **只取 text 块**：thinking 块常常排在前面，它不是回答；
 *   - **全部 text 块拼接**：围栏块可能被拆在多个 text 块里，只取最后一块会拿到半截围栏；
 *   - **跳过 streaming**：半截的流不是答案，宁可当没回答也不拿半截的去解。
 */
export function collectScanAnswer(
  transcript: readonly TranscriptItem[],
  baseline: number,
): string | null {
  let answer: string | null = null;
  for (const item of transcript.slice(baseline)) {
    if (item.role !== "assistant" || item.status === "streaming") continue;
    answer = item.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return answer;
}

/**
 * 扫描轮的 submit 载荷：**原样用会话自己的开工上下文**（buildTurn 的结果：会话的模型、档、权限、
 * 本子），只换正文。不换模型、不换档——上一版换成家务活模型，开轮推回的思考档（家务活模型 clamp
 * 后的档）被输入卡当成会话的档写上，下一轮真按它发了出去。测试守着「扫描轮的模型与档 = 会话的」。
 */
export function scanSubmitInput(
  sessionId: string,
  turn: Omit<SubmitAgentInput, "sessionId" | "text">,
  plan: Pick<WrapupPlan, "sinceTurn" | "lastTurn" | "turns" | "compactions">,
): SubmitAgentInput {
  return { ...turn, sessionId, text: buildClosingScanPrompt(plan) };
}

/** 消息流里的扫描回答（只读展示卡吃它） */
export interface ScanMessage {
  /** v2 才有「做完的事」；v1 的旧回答为 null */
  done: { title: string; turns: [number, number] | null }[] | null;
  left: { title: string; detail: string }[];
}

/**
 * 整条消息是否**恰好是**一个扫描回答（v2：done + carryovers；v1：只有 carryovers）。是 → 返回
 * 展示用的内容，否则 null 走普通 markdown 渲染。判定严格：卡片整条替换原文，多吞一个字都是丢内容。
 * 轮号只看形状不看范围（展示用，历史消息的计划早已不在手边）。
 */
export function matchScanMessage(text: string): ScanMessage | null {
  const block = soleFencedJson(text);
  if (block === null) return null;
  const v2 = parseWrapupBlock(block, { sinceTurn: 1, lastTurn: Number.MAX_SAFE_INTEGER });
  if (v2 !== null) {
    return {
      done: v2.done.map((entry) => ({ title: entry.title, turns: entry.turns })),
      left: v2.left.map((entry) => ({ title: entry.title, detail: entry.detail })),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Array.isArray(root["carryovers"])) return null;
  const left: { title: string; detail: string }[] = [];
  for (const entry of root["carryovers"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record["title"] !== "string" || record["title"].trim() === "") return null;
    if (typeof record["detail"] !== "string") return null;
    left.push({ title: record["title"], detail: record["detail"] });
  }
  return { done: null, left };
}

/**
 * 在 transcript 里给一条遗留事项找锚点（sourceMessageRange 的「尽力而为」）：
 * detail 是模型从对话里摘的原句/概括，拿它的开头在 user/assistant 消息文本里搜，
 * 第一条命中的序号就是锚（区间收成 [i, i]——粒度到消息，够「跳回原文」用）。
 * 摘录是概括时搜不到，返回 null——锚点缺省是设计内的常态，不阻塞落盘。
 */
export function locateMessageRange(
  transcript: readonly TranscriptItem[],
  detail: string,
): [number, number] | null {
  const probe = detail.trim().slice(0, 48);
  if (probe === "") return null;
  for (let i = 0; i < transcript.length; i += 1) {
    const item = transcript[i];
    if (item === undefined) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      if (block.text.includes(probe)) return [i, i];
    }
  }
  return null;
}
