/**
 * 收尾确认卡的「留下的事」预填（2026-10-30，future work 与遗留事项合并后）：
 * 做的过程中已经当场记下了「以后再做」、计划里也写明了哪几步没做完——收尾时只需要**确认**，
 * 不再让模型回看整段对话去收割（量大、没人处理）。
 *
 * - 这条任务写过计划，或有还开着的「以后再做」：留下的事 = 开着的以后再做 + 计划里没做完的步（按文字去重），
 *   完全替换扫描模型给的那一组（扫描仍要给出「做完的事」做价格图记账，那部分不变）；
 * - 两样都没有（老会话 / 没写计划的快问快答）：沿用扫描模型回看出来的那一组。
 *
 * 确认时（reconcileLeft）：卡上留下的、本来就是开着的以后再做——不再新记（已经在清单里）；
 * 开着的以后再做在卡上被删掉了——标「丢掉」（用户明说不要它了）；其余（计划没做完的步、
 * 用户自己加的、扫描模型给的）新记进清单。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { Carryover, CarryoverDraft } from "@shared/session";
import type { WrapupEntry } from "@shared/wrapup";

const same = (a: string, b: string): boolean => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

export function prefillLeft(input: {
  /** 扫描模型给的留下的事 */
  modelLeft: readonly WrapupEntry[];
  /** 这条任务有没有写过计划；计划里没做完的步（没写过 = null） */
  unfinishedSteps: readonly string[] | null;
  /** 这条任务里还开着的以后再做 */
  noticed: readonly Carryover[];
}): WrapupEntry[] {
  if (input.unfinishedSteps === null && input.noticed.length === 0) return [...input.modelLeft];
  const out: WrapupEntry[] = [];
  const add = (title: string, detail: string): void => {
    if (title.trim() === "" || out.some((entry) => same(entry.title, title))) return;
    out.push({ title, detail, turns: null });
  };
  for (const item of input.noticed) add(item.title, item.detail);
  for (const step of input.unfinishedSteps ?? []) add(step, "");
  return out;
}

/** 确认时怎么落：新记哪些、哪些开着的以后再做要标丢掉 */
export function reconcileLeft(input: {
  /** 用户确认的留下的事（卡上最后的样子） */
  left: readonly { title: string; detail: string }[];
  /** 确认那一刻这条任务里还开着的以后再做 */
  noticed: readonly Carryover[];
  locate: (detail: string) => [number, number] | null;
}): { drafts: CarryoverDraft[]; dismissIds: string[] } {
  const drafts: CarryoverDraft[] = [];
  for (const entry of input.left) {
    if (entry.title.trim() === "") continue;
    if (input.noticed.some((item) => same(item.title, entry.title))) continue; // 本来就在清单里
    drafts.push({ title: entry.title, detail: entry.detail, sourceMessageRange: input.locate(entry.detail) });
  }
  const dismissIds = input.noticed
    .filter((item) => !input.left.some((entry) => same(entry.title, item.title)))
    .map((item) => item.id);
  return { drafts, dismissIds };
}
