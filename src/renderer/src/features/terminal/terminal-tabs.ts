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

/** 焦点判定只需要的那几项（DOM 元素的子集，测试里直接造对象） */
export interface FocusTarget {
  tagName: string;
  isContentEditable: boolean;
  /** input 的 type（button / checkbox 这类不是在打字） */
  type?: string;
  readOnly?: boolean;
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"]);

/**
 * 终端画完快照后要不要抢焦点。**用户正在终端外的输入处打字时不抢**：agent 用
 * terminal_open / terminal_execute 开出的新 tab 也会挂载这个视图，原先挂载即
 * focus()，把 composer 里正在打的字截进终端（2026-10-19 用户：「光标会把我打字的
 * 光标给抢走，有些字出现在 terminal 里面」）。
 *
 * 不抢 = 焦点此刻在终端外的可编辑处（textarea / 文本类 input / contenteditable）。
 * 其余情形照旧给终端焦点：用户点「+」或点 tab（焦点在按钮上）、焦点在 body、
 * 或焦点本来就在这个终端里。
 */
export function shouldTerminalTakeFocus(active: FocusTarget | null, activeIsInsideTerminal: boolean): boolean {
  if (active === null || activeIsInsideTerminal) return true;
  if (active.isContentEditable) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === "textarea") return active.readOnly === true;
  if (tag === "input") return active.readOnly === true || NON_TEXT_INPUT_TYPES.has((active.type ?? "text").toLowerCase());
  return true;
}
