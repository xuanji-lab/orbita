/**
 * 这一轮开头那张计划卡（PlanTurnCard.tsx）出不出、出哪种、点开画什么：纯推导，可被 node --test 直接加载。
 *
 * 2026-11-22 用户：「创建了计划是一种……在已有计划上做修改，我觉得可以用红绿的那种 diff 来显示改动……
 * 用红绿的 diff 可以 cover 所有的可能性」。所以只分两种卡：
 * - 定了计划：整张清单，每步带状态（勾 / 在做 / 等你 / 空圈），不用删除线——删除线读起来像「被删掉了」；
 * - 改了计划：上一版 → 这一版的红绿 diff。加、去、改说法（红旧绿新）、挪位置（旧位置红、新位置绿）、拆、合，
 *   都落成同一种 + / − 行；没动的步照样列出、带状态，读得出改动落在哪。
 * 只打勾不出卡（勾在过程里是一行「改计划」，全貌在右栏「进度」）。
 */
import type { PlanItemStatus } from "../../../../shared/plan.ts";
import type { PlanNotice, PlanStep, PlanTimeline, PlanVersion } from "../context/plan-timeline.ts";

export type PlanTurnState =
  /** replaced：上一张计划整张换掉了（一步都没留下）——那是定了一张新计划，不是改，不画满屏的红绿 */
  | { kind: "fresh"; version: PlanVersion; replaced?: true }
  | { kind: "changed"; notice: PlanNotice; version: PlanVersion; base: PlanVersion };

/** 这一块里的 update_plan 调用让计划发生了什么：第一次定下 / 改了结构 / 只打勾（null） */
export function planTurnState(timeline: PlanTimeline | null, notice: PlanNotice | null, toolCallIds: readonly string[]): PlanTurnState | null {
  if (timeline === null || toolCallIds.length === 0) return null;
  const wanted = new Set(toolCallIds);
  const mine = timeline.versions.filter((version) => wanted.has(version.toolCallId));
  const first = mine[0];
  const last = mine.at(-1);
  if (first === undefined || last === undefined) return null;
  const fresh = mine.find((version) => version.n === 1);
  if (fresh !== undefined) {
    // 前面还有别的计划（这条会话之前写过）：这是换了一张新计划
    return timeline.versions.indexOf(fresh) > 0 ? { kind: "fresh", version: last, replaced: true } : { kind: "fresh", version: last };
  }
  if (notice === null) return null;
  // 这一块之前的那一版（同一张计划里，first.n > 1 时它就在 versions 里紧挨着 first）
  const base = timeline.versions[timeline.versions.indexOf(first) - 1];
  if (base === undefined) return null;
  // 一步都没留下（上一件事做完、这一轮换了一件新事，模型把清单整张重写）：算定了新计划
  if (planDiffLines(base.items, last.items).every((line) => line.kind !== "same")) return { kind: "fresh", version: last, replaced: true };
  return { kind: "changed", notice, version: last, base };
}

/** diff 的一行：没动（same）/ 加的（add）/ 去掉的（del）。状态取这一行所在那一版的 */
export interface PlanDiffLine {
  kind: "same" | "add" | "del";
  text: string;
  status: PlanItemStatus;
  waitingFor?: string;
}

/**
 * 上一版 → 这一版的逐步 diff（按步骤文字做最长公共子序列）。同一处的「去掉」排在「加上」前面（统一 diff 的读法）：
 * 改说法 = 一红一绿；挪位置 = 旧位置一红、新位置一绿；状态变了（打勾）不算改动，那一步是 same、带新状态。
 */
export function planDiffLines(before: readonly PlanStep[], after: readonly PlanStep[]): PlanDiffLine[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i]!.text === after[j]!.text ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const line = (kind: PlanDiffLine["kind"], step: PlanStep): PlanDiffLine => ({
    kind,
    text: step.text,
    status: step.status,
    ...(step.waitingFor === undefined ? {} : { waitingFor: step.waitingFor }),
  });
  const out: PlanDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i]!.text === after[j]!.text) {
      out.push(line("same", after[j]!));
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push(line("del", before[i]!));
      i += 1;
    } else {
      out.push(line("add", after[j]!));
      j += 1;
    }
  }
  return out;
}

/** 卡头上的「+2 −1」 */
export function planDiffStats(lines: readonly PlanDiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "del").length,
  };
}
