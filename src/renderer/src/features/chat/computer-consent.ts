/**
 * 电脑使用授权（2026-11-27）在对话流里的**纯派生层**。
 *
 * 两张 UI 都从这一层要答案，渲染组件只负责画：
 *   · 甲：确认行挂在「正在跑的那条电脑工具调用」下面；回答后同一位置退成记录行——
 *     记录行挂在**本会话第一处电脑工具调用**下面（授权就是那一刻发生的，跟着时间轴走）。
 *   · 乙：输入框上方的状态行只看会话的授权状态（allowed 才出现），它不读转录。
 *
 * 为什么记录行挂在“第一处调用”而不是另存一条转录记录：授权是会话元数据上的一条持久记录
 * （meta.computerUseConsent），对话流里没有第二条真相。第一处电脑工具调用是这条记录
 * **发生的时刻**，按它定位既不需要新记录类型，也不会在重开 / 刷新后丢掉位置。
 *
 * 纯函数、只吃转录与状态：node --test 直接加载（同 tool-results.ts 的纪律）。
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { ComputerUseConsent } from "@shared/computer-use";

/** 电脑使用两组工具的名字前缀：`computer_*`（像素 / UIA）与 `sandbox_*`（沙箱内浏览器） */
const COMPUTER_TOOL_PREFIXES = ["computer_", "sandbox_"] as const;

export function isComputerUseToolName(toolName: string): boolean {
  return COMPUTER_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

interface ComputerUseCall {
  toolCallId: string;
  toolName: string;
}

/**
 * 转录里的电脑工具调用，按发生顺序。转录里的 tool 记录是**结果**（有 toolCallId），
 * 调用本体在 assistant 的 toolCall 块里——两者都要看，所以先收调用再对结果。
 */
export function computerUseCalls(transcript: readonly TranscriptItem[]): ComputerUseCall[] {
  const calls: ComputerUseCall[] = [];
  for (const record of transcript) {
    if (record.role !== "assistant") continue;
    for (const block of record.content) {
      if (block.type !== "toolCall") continue;
      if (!isComputerUseToolName(block.toolName)) continue;
      calls.push({ toolCallId: block.toolCallId, toolName: block.toolName });
    }
  }
  return calls;
}

/** 已落定的工具结果 id（status 不是 running 的都算落定） */
function settledResults(transcript: readonly TranscriptItem[]): Set<string> {
  const settled = new Set<string>();
  for (const record of transcript) {
    if (record.role !== "tool") continue;
    if (record.status === "running") continue;
    settled.add(record.toolCallId);
  }
  return settled;
}

/**
 * 本会话第一处电脑工具调用（授权记录行的挂点）。null = 还没有过电脑操作。
 * 只看已加载窗口：很早以前的调用翻出窗口之后不画那条记录——它已经不是「此刻的授权」，
 * 最新的授权状态由乙的状态行负责。
 */
export function firstComputerUseToolCallId(transcript: readonly TranscriptItem[]): string | null {
  return computerUseCalls(transcript)[0]?.toolCallId ?? null;
}

/**
 * 正在等授权的那条电脑工具调用（确认行的挂点）：最后一条还没有结果 / 还在跑的那条。
 * null = 没有跑着的电脑工具——此时确认行回落到输入框上方的 footer，不能让用户答不了。
 */
export function runningComputerUseToolCallId(transcript: readonly TranscriptItem[]): string | null {
  const settled = settledResults(transcript);
  const calls = computerUseCalls(transcript).filter((call) => !settled.has(call.toolCallId));
  return calls.at(-1)?.toolCallId ?? null;
}

/**
 * 记录行该不该画、画哪一种。只有「本会话第一处电脑工具调用」那一行下面画，
 * 且授权状态不是 unset（撤销之后整行消失，下一次电脑操作会重新问）。
 */
export function consentRecordKind(
  consent: ComputerUseConsent,
  toolCallId: string,
  triggerToolCallId: string | null,
): "allowed" | "denied" | null {
  if (consent === "unset") return null;
  if (triggerToolCallId === null || toolCallId !== triggerToolCallId) return null;
  return consent;
}

/**
 * 乙的状态行：只有 allowed 才出现（未授权那一条由甲的确认行负责，不两处同时喊）。
 * denied 也不画——拒绝过了就是拒绝过了，撤销入口在甲那条记录行上，不必常驻打扰。
 */
export function showsConsentStatusLine(consent: ComputerUseConsent): boolean {
  return consent === "allowed";
}
