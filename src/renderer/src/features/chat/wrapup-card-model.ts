/**
 * 收尾确认卡的本地编辑 —— 纯函数，node --test 直接加载（只做 type import 与 .ts 相对 import）。
 *
 * 卡片上的一切改动（行内改标题、删一件、加一项、两组间挪动、反馈改写与撤回）都落在一份
 * WrapupDraft 上；确认时整份交给主进程。两组同形（WrapupEntry），挪动时字段原样带走——从做完挪到
 * 留下的事保留轮次，挪回来轮次还在。
 */
import type { WrapupDraft, WrapupEntry } from "../../../../shared/wrapup.ts";
import { wrapupItemTotals, wrapupTokenTotal, type WrapupItemTotals } from "../../../../shared/wrapup-scan.ts";
import type { WrapupTurn } from "../../../../shared/wrapup.ts";

export type WrapupGroup = "done" | "left";

const other = (group: WrapupGroup): WrapupGroup => (group === "done" ? "left" : "done");

function withGroup(draft: WrapupDraft, group: WrapupGroup, entries: WrapupEntry[]): WrapupDraft {
  return group === "done" ? { ...draft, done: entries } : { ...draft, left: entries };
}

/** 改一行的标题；空标题不收（回车一个空串等于放弃） */
export function editTitle(draft: WrapupDraft, group: WrapupGroup, index: number, title: string): WrapupDraft {
  const trimmed = title.trim();
  const entries = draft[group];
  const entry = entries[index];
  if (entry === undefined || trimmed === "" || trimmed === entry.title) return draft;
  return withGroup(draft, group, entries.map((e, i) => (i === index ? { ...e, title: trimmed } : e)));
}

export function removeEntry(draft: WrapupDraft, group: WrapupGroup, index: number): WrapupDraft {
  return withGroup(draft, group, draft[group].filter((_, i) => i !== index));
}

/** 加一项：用户自己加的没有轮次（做完的事因此不记花费，价格图不收它） */
export function addEntry(draft: WrapupDraft, group: WrapupGroup, title: string): WrapupDraft {
  const trimmed = title.trim();
  if (trimmed === "") return draft;
  return withGroup(draft, group, [...draft[group], { title: trimmed, detail: "", turns: null }]);
}

/** 挪到另一组的末尾；反馈挂上的标签挪动时去掉（那是上一次改写的说明，不是这一次） */
export function moveEntry(draft: WrapupDraft, group: WrapupGroup, index: number): WrapupDraft {
  const entry = draft[group][index];
  if (entry === undefined) return draft;
  const { change: _change, ...rest } = entry;
  const target = other(group);
  return withGroup(withGroup(draft, group, draft[group].filter((_, i) => i !== index)), target, [
    ...draft[target],
    rest,
  ]);
}

/** 确认键上的数：空标题不算 */
export function confirmCounts(draft: WrapupDraft): { done: number; left: number } {
  return {
    done: draft.done.filter((e) => e.title.trim() !== "").length,
    left: draft.left.filter((e) => e.title.trim() !== "").length,
  };
}

/** 一件做完的事在卡片上显示的账：没有轮次或那几轮没有用量时 null（不显示型号与花费） */
export function entryTotals(turns: readonly WrapupTurn[], entry: WrapupEntry): WrapupItemTotals | null {
  if (entry.turns === null) return null;
  const totals = wrapupItemTotals(turns, entry.turns);
  return totals.modelId === null || wrapupTokenTotal(totals.tokens) === 0 ? null : totals;
}
