/**
 * 终端面板的 tab 状态机（纯函数，可测）。面板只维护「哪些 tab 可见、当前看哪个」，
 * PTY 与快照缓冲都在主进程——这两个判断因此可以被穷尽测试，组件只负责接线。
 */
import type { TerminalInfo } from "@shared/terminal";

/**
 * 当前该看哪个 tab：点过的那个还在就留着；不在（刚被关掉、或**还没被面板收养**）
 * 就落最后一个。
 *
 * 「落最后一个」是既有行为（关掉当前 tab 后自然落到余下最后一个）。但它同时会**掩盖**
 * 一种故障：agent 开了一个面板还不知道的终端，activateId 传进来时列表里没有它，
 * 于是静默落到旧 tab 上——那个新终端没有视图 → 没有 ack → runtime 的输出背压把它
 * 永久卡在第 1 批。所以调用方必须先收养（TerminalPanel 的 agent-open effect），
 * 不能只靠这里的兜底。
 */
export function activeTerminalId(ids: readonly string[], activeId: string | null): string | null {
  if (activeId !== null && ids.includes(activeId)) return activeId;
  return ids[ids.length - 1] ?? null;
}

/**
 * 把新终端并进面板的 tabs。**只做加法**：已在的不重复，没有的一律追加在末尾
 * （tab 顺序 = 创建顺序）。
 *
 * 只做加法是有意的：调用方给的是「刚刚建成的这一个终端」（agent-open 事件带的全文），
 * 不是一份可能过期的清单。若改成按清单整体替换，一条在关 tab 之前就发出去的
 * list 会把用户刚杀掉的 tab 复活。
 */
export function mergeTerminals(current: readonly TerminalInfo[], incoming: readonly TerminalInfo[]): TerminalInfo[] {
  const merged = [...current];
  for (const info of incoming) {
    if (!merged.some((tab) => tab.terminalId === info.terminalId)) merged.push(info);
  }
  return merged;
}
