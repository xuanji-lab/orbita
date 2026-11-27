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
  /** replaced：这条会话之前写过别的计划，这一块从第 1 版另起一张（计划时间线判的「新计划」） */
  | { kind: "fresh"; version: PlanVersion; replaced?: true }
  | { kind: "changed"; notice: PlanNotice; version: PlanVersion; base: PlanVersion }
  /** 只打勾：照样出卡，看得到这一轮把计划推进到哪（2026-11-22 用户：「根据你的执行再实时推进」） */
  | { kind: "progress"; version: PlanVersion; base: PlanVersion };

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
  // 这一块之前的那一版（同一张计划里，first.n > 1 时它就在 versions 里紧挨着 first）
  const base = timeline.versions[timeline.versions.indexOf(first) - 1];
  if (base === undefined) return null;
  if (notice === null) return { kind: "progress", version: last, base };
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

/**
 * 左右对照（2026-11-22 用户：「如果能变成左右 diff 的话，可能会更节省空间一些」）：没动的步占整行（只列一次），
 * 改动的地方成一段，左边是原来的（红）、右边是现在的（绿），一行对一行；一边没有的留空。
 */
export type PlanDiffRow = { kind: "same"; line: PlanDiffLine } | { kind: "change"; left: PlanDiffLine | null; right: PlanDiffLine | null };

export function planDiffRows(lines: readonly PlanDiffLine[]): PlanDiffRow[] {
  const rows: PlanDiffRow[] = [];
  let dels: PlanDiffLine[] = [];
  let adds: PlanDiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ kind: "change", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "same") {
      flush();
      rows.push({ kind: "same", line });
    } else if (line.kind === "del") dels.push(line);
    else adds.push(line);
  }
  flush();
  return rows;
}

/** 一次只打勾的调用推进了什么：做完了哪几步、开始了哪一步、哪一步卡在等（步骤按 id 对上一版） */
export interface PlanTick {
  kind: "done" | "start" | "wait";
  text: string;
}

export function planTicks(before: readonly PlanStep[], after: readonly PlanStep[]): PlanTick[] {
  const prev = new Map(before.map((step) => [step.id, step.status]));
  const ticks: PlanTick[] = [];
  for (const step of after) {
    const was = prev.get(step.id);
    if (was === undefined || was === step.status) continue;
    if (step.status === "done") ticks.push({ kind: "done", text: step.text });
    else if (step.status === "in_progress") ticks.push({ kind: "start", text: step.text });
    else if (step.status === "waiting") ticks.push({ kind: "wait", text: step.text });
  }
  return ticks;
}

/**
 * 过程里「改计划」那一步是什么（展开后的那一行 / 那一块用）：第一次定（fresh）、改了结构（changed，带上一版）、
 * 只打勾（ticks）。按调用 id 找版本；找不到 = null（照普通工具行画）。
 */
export type PlanCallView =
  | { kind: "fresh"; version: PlanVersion }
  | { kind: "changed"; version: PlanVersion; base: PlanVersion }
  | { kind: "ticks"; version: PlanVersion; ticks: PlanTick[] };

export function planCallView(timeline: PlanTimeline | null, toolCallId: string): PlanCallView | null {
  if (timeline === null) return null;
  const index = timeline.versions.findIndex((version) => version.toolCallId === toolCallId);
  const version = timeline.versions[index];
  if (version === undefined) return null;
  const base = version.n === 1 ? undefined : timeline.versions[index - 1];
  if (base === undefined) return { kind: "fresh", version };
  if (version.changes.length > 0 || version.waits.length > 0) return { kind: "changed", version, base };
  return { kind: "ticks", version, ticks: planTicks(base.items, version.items) };
}
