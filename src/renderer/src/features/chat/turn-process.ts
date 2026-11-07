/**
 * 「一轮一行」过程显示的纯推导（2026-10-30，设置 › 过程显示 = turn）。
 *
 * 节奏来自真实链条（本仓库会话 JSONL 的统计）：相邻两步的间隔中位 1.6s、P90 9.5s、
 * P97 28s；工具耗时中位 1.0s、P90 8.5s，长的几乎都是 bash。由此：
 * - 现场块**每秒走表**——太安静像卡住；但只换数字不换行，块高固定——太吵像一直在走
 *   却不出结果。
 * - 没有工具在跑时写「在想 · Ns」；间隔超过 SLOW_GAP_MS（P97）才提示比平时久。
 * - 命令跑过 TAIL_AFTER_MS 才露输出尾巴（快命令不闪）。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { ProcessStep, ToolCallUnit, ToolResultIndex, TurnProcessUnit } from "./tool-results.ts";
import { rollupToolKey, thinkingPreview } from "./tool-results.ts";

/** 97% 的间隔在这之内；再长才算「比平时久」 */
export const SLOW_GAP_MS = 28_000;
/** 命令跑过这么久才露输出尾巴 */
export const TAIL_AFTER_MS = 5_000;
/** 现场块里最近完成的几步（再多就是在刷屏） */
export const TRAIL_KEEP = 3;
/** 章节里平铺几步，多的收成「还有 N 步」 */
export const CHAPTER_STEPS_SHOWN = 4;

/** 块里的全部工具调用（工具组摊开），按发生顺序 */
export function processCalls(steps: readonly ProcessStep[]): ToolCallUnit[] {
  const calls: ToolCallUnit[] = [];
  for (const step of steps) {
    if (step.kind === "toolCall") calls.push(step);
    else if (step.kind === "toolGroup") calls.push(...step.calls);
  }
  return calls;
}

export function callFailed(call: ToolCallUnit, results: ToolResultIndex): boolean {
  return results.get(call.toolCallId)?.status === "error";
}

/** 还没落定：没有结果帧，或结果帧还是 running；已判中断的不算 */
export function callRunning(
  call: ToolCallUnit,
  results: ToolResultIndex,
  interrupted: ReadonlySet<string> = new Set(),
): boolean {
  const result = results.get(call.toolCallId);
  if (result === undefined) return !interrupted.has(call.toolCallId);
  return result.status === "running";
}

export interface ProcessCounts {
  steps: number;
  /** 按统计词汇（rollupToolKey）计数，次数多的在前 */
  byTool: { key: string; count: number }[];
  failed: number;
  /** 写过 / 改过的文件（write / edit 的 path，去重） */
  files: string[];
}

export function processCounts(
  steps: readonly ProcessStep[],
  results: ToolResultIndex,
  skills: ReadonlyArray<{ slug: string; name: string }> = [],
): ProcessCounts {
  const calls = processCalls(steps);
  const by = new Map<string, number>();
  const files = new Set<string>();
  let failed = 0;
  for (const call of calls) {
    const key = rollupToolKey(call.toolName, call.input, skills);
    by.set(key, (by.get(key) ?? 0) + 1);
    if (callFailed(call, results)) failed += 1;
    if (call.toolName === "write" || call.toolName === "edit") {
      const path = (call.input as Record<string, unknown> | null)?.["path"];
      if (typeof path === "string" && !callFailed(call, results)) files.add(path);
    }
  }
  return {
    steps: calls.length,
    byTool: [...by].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    failed,
    files: [...files],
  };
}

/**
 * 章节：一轮按「agent 说的话」切开。标题优先级：说明性正文 > 这一章第一段思考的一行 >
 * 按工具归类（由视图层用文案拼，这里给 null）。只切在正文上，不切在思考上——
 * 有的模型每步都先想一句，按思考切会切成「一章一步」。
 */
export interface ProcessChapter {
  key: string;
  title: string | null;
  source: "say" | "think" | "tools";
  calls: ToolCallUnit[];
  /** 这一章的全部步（含思考与正文），展开成逐条时用 */
  steps: ProcessStep[];
}

export function processChapters(steps: readonly ProcessStep[]): ProcessChapter[] {
  const chapters: ProcessChapter[] = [];
  let current: ProcessChapter | null = null;
  for (const step of steps) {
    if (step.kind === "text") {
      // 紧贴在这句话前面的思考（同一条消息里「想 → 说 → 做」）属于新的一章：
      // 它想的是接下来要做的事，不是上一章的尾巴
      const carried: ProcessStep[] = [];
      while (current !== null && current.steps.at(-1)?.kind === "thinking") {
        const moved = current.steps.pop();
        if (moved !== undefined) carried.unshift(moved);
      }
      if (current !== null && current.steps.length === 0) chapters.pop();
      current = { key: step.key, title: firstLine(step.text), source: "say", calls: [], steps: [...carried, step] };
      chapters.push(current);
      continue;
    }
    if (current === null) {
      current = { key: step.key, title: null, source: "tools", calls: [], steps: [] };
      chapters.push(current);
    }
    current.steps.push(step);
    if (step.kind === "toolCall") current.calls.push(step);
    else if (step.kind === "toolGroup") current.calls.push(...step.calls);
  }
  // 没有旁白的章：标题取这一章第一段有字的思考
  for (const chapter of chapters) {
    if (chapter.source === "say") continue;
    for (const step of chapter.steps) {
      if (step.kind !== "thinking") continue;
      const line = firstLine(step.text);
      if (line === null) continue;
      chapter.title = line;
      chapter.source = "think";
      break;
    }
  }
  return chapters;
}

/** 正文 / 思考的第一行有字的内容（markdown 的标题井号、列表符剥掉） */
export function firstLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").trim();
    if (line !== "") return line;
  }
  return null;
}

/** 现场块的「此刻」：在跑某个工具，或者在想（没有工具在跑） */
export type ProcessNow =
  | { kind: "tool"; call: ToolCallUnit; startedAt: number | null }
  | { kind: "think"; since: number | null; preview: string | null };

export interface ProcessLive {
  /** 最近完成的几步（旧 → 新），最多 TRAIL_KEEP 条 */
  trail: { call: ToolCallUnit; failed: boolean; ms: number | null }[];
  now: ProcessNow;
  /** 当前章节的标题：说的话，否则最近一段思考的那一行 */
  chapter: { title: string; source: "say" | "think" } | null;
}

/**
 * 现场块的快照。`startOf` 取工具的开跑时刻（现场计时表；记不到给 null），
 * `endOf` 取落定时刻（结果帧的时间戳）。
 */
export function processLive(
  unit: Pick<TurnProcessUnit, "steps">,
  results: ToolResultIndex,
  startOf: (call: ToolCallUnit) => number | null,
  interrupted: ReadonlySet<string> = new Set(),
): ProcessLive {
  const calls = processCalls(unit.steps);
  const running = calls.find((call) => callRunning(call, results, interrupted));
  const finished = calls.filter((call) => !callRunning(call, results, interrupted));
  const trail = finished.slice(-TRAIL_KEEP).map((call) => {
    const end = results.get(call.toolCallId)?.timestamp ?? null;
    const start = startOf(call) ?? call.timestamp;
    return { call, failed: callFailed(call, results), ms: end === null ? null : Math.max(0, end - start) };
  });
  // 章节：最后一章的标题；没有说的话就拿最近一段思考
  const chapters = processChapters(unit.steps);
  const lastChapter = chapters.at(-1);
  let chapter: ProcessLive["chapter"] = null;
  if (lastChapter !== undefined) {
    if (lastChapter.source === "say" && lastChapter.title !== null) chapter = { title: lastChapter.title, source: "say" };
    else {
      const thought = [...lastChapter.steps].reverse().find((step) => step.kind === "thinking");
      const line = thought?.kind === "thinking" ? lastLine(thought.text) : null;
      if (line !== null) chapter = { title: line, source: "think" };
      else if (lastChapter.title !== null) chapter = { title: lastChapter.title, source: lastChapter.source === "say" ? "say" : "think" };
    }
  }
  if (running !== undefined) return { trail, now: { kind: "tool", call: running, startedAt: startOf(running) }, chapter };
  // 在想：从最后一个事件（步的时间戳、工具落定）算起
  let since: number | null = null;
  for (const step of unit.steps) {
    const ts = step.kind === "toolGroup" ? (step.calls.at(-1)?.timestamp ?? null) : step.timestamp;
    if (ts !== null && (since === null || ts > since)) since = ts;
  }
  for (const call of finished) {
    const end = results.get(call.toolCallId)?.timestamp;
    if (end !== undefined && (since === null || end > since)) since = end;
  }
  const lastStep = unit.steps.at(-1);
  const preview = lastStep?.kind === "thinking" ? lastLine(lastStep.text) : null;
  return { trail, now: { kind: "think", since, preview }, chapter };
}

/** 流式思考的最新一行（thinkingPreview 同口径，空串记 null） */
function lastLine(text: string): string | null {
  const line = thinkingPreview(text).trim();
  return line === "" ? null : line;
}
