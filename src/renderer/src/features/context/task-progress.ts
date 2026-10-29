/**
 * 右栏「这条任务 › 进度」的推导（2026-10-30）：计划（update_plan 的最后一次入参）与「做过的」
 * （按轮列，轮下是章节——与对话里过程块展开后的章节同一份推导，turn-process.ts）。
 *
 * 全部从转录推，不另存：回退、分支、重开会话都跟着转录走。
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { parsePlan, PLAN_STATUSES, PLAN_TOOL_NAME, type PlanItem } from "../../../../shared/plan.ts";
import {
  flattenRenderUnits,
  groupToolUnits,
  groupTurnsByTurn,
  indexToolResults,
  type ToolResultIndex,
  type TurnProcessUnit,
} from "../chat/tool-results.ts";
import { processChapters, processCounts, type ProcessChapter } from "../chat/turn-process.ts";

/** 让对话滚到某个过程块（ChatView 的 TranscriptColumn 监听）：面板与对话不共享状态，走一次性事件 */
export const REVEAL_ENTRY_EVENT = "orbita:reveal-entry";

export interface PlanView {
  items: PlanItem[];
  /** 这张计划写下的时刻（update_plan 开跑帧的时间戳）：「在做」那步的计时从这里起 */
  at: number;
  done: number;
}

/**
 * 最后一张计划 = 最后一次没被拒的 update_plan 的入参。
 *
 * - 被拒的（error：入参坏了）不算——模型会改了重调；
 * - **还在跑的算**：它的入参在开跑帧（tool_execution_start）里就是定稿，执行只是校验 + 回执。
 *   pi 的并行批次先让同批每个调用依次过审批闸门、全部过完才统一执行（agent-loop 的
 *   executeToolCallsParallel），手动档下 update_plan 会和同批等你批准的 read / bash 一起挂着——
 *   只认执行完的，面板在你批准之前一直是上一张计划，而对话里那一行已经是新计划（2026-10-30 实测）。
 *   还没执行就没经过工具的校验，所以用工具同一个 parsePlan 判，过不了的跳过（工具会拒）；
 * - 执行完的入参宽松解析：坏条目跳过，不让一条坏数据把整张计划弄没（工具端已经校验过，
 *   这里只防旧数据 / 手改）。
 */
export function latestPlan(records: readonly TranscriptRecord[]): PlanView | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record === undefined || record.role !== "tool" || record.toolName !== PLAN_TOOL_NAME) continue;
    if (record.status === "error") continue;
    const items = record.status === "complete" ? looseItems(record.input) : strictItems(record.input);
    if (items.length === 0) continue;
    return { items, at: record.timestamp, done: items.filter((item) => item.status === "done").length };
  }
  return null;
}

/** 头一行的状态：侧栏状态饼的四档，再加一个只说字、不画饼的「停下了」 */
export type TaskHeadState = "running" | "waiting" | "done" | "failed" | "stopped";

/**
 * 头一行说什么。
 *
 * - 在跑 / 等你：取会话运行态（App 传入 runStateOf 的结果——与侧栏状态饼同一个推导，
 *   含子会话：子会话等你批准时侧栏亮橙，这里也得说「等你」）。未读标记（跑完 / 出错）
 *   不在这里用：落定之后的状态由下面自己判；
 * - 这一轮以错误收场（重试耗尽，槽的 turnError）→ 出错了。侧栏红饼用的也是它；以前这里判
 *   「这一轮每一步都失败」，工具失败不等于这一轮出错（模型照样收尾了），而真正的回合失败反倒不亮；
 * - 计划还有没做完的步 → 停下了：用户点了停止、模型停下来问你、或忘了勾——哪种都不该说
 *   「做完了」配绿饼（2026-10-30 实测：停止后头上「做完了」、下面计划 0/5）；
 * - 否则做完了。一轮都没有 → null（不说状态）。
 */
export function taskHeadState(input: {
  run: SessionRunState;
  turnError: boolean;
  turns: number;
  plan: PlanView | null;
}): TaskHeadState | null {
  if (input.run === "running" || input.run === "waiting") return input.run;
  if (input.turns === 0) return null;
  if (input.turnError) return "failed";
  if (input.plan !== null && input.plan.done < input.plan.items.length) return "stopped";
  return "done";
}

/**
 * 「在做」那步从几点开始计：计划写下的时刻。计划是前几轮写的、这一轮模型没再更新（续聊）时
 * 从这一轮开始算——不然两轮之间闲着的时间都算进去，隔夜续聊就是十几个小时。
 */
export function stepClockFrom(plan: PlanView, turns: readonly TurnDigest[]): number {
  const last = turns.at(-1);
  return last === undefined ? plan.at : Math.max(plan.at, last.at);
}

/** 还没执行的入参：过工具同一套校验，过不了 = 空（这张不算） */
function strictItems(input: unknown): PlanItem[] {
  try {
    return parsePlan(input);
  } catch {
    return [];
  }
}

/** 执行完的入参：坏条目跳过 */
function looseItems(input: unknown): PlanItem[] {
  const raw = (input as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const text = typeof value["text"] === "string" ? value["text"].trim() : "";
    const status = value["status"];
    if (text === "" || typeof status !== "string" || !(PLAN_STATUSES as readonly string[]).includes(status)) return [];
    return [{ text, status: status as PlanItem["status"] }];
  });
}

/** 一轮的摘要：用户那句话 + 这轮的过程块（章节、步数、写过的文件、失败、用时） */
export interface TurnDigest {
  key: string;
  /** 用户那句话的第一行 */
  ask: string;
  at: number;
  /** 这轮的过程块 key（点一行跳到对话里的那一块） */
  processKeys: string[];
  chapters: ProcessChapter[];
  steps: number;
  files: number;
  failed: number;
  durationMs: number | null;
  live: boolean;
}

/**
 * 转录 → 每轮一条摘要（旧 → 新）。切轮跟对话同一个口径（groupTurnsByTurn：user 开新段）；
 * 一轮里可能有几个过程块（被通道工具切开），步数与章节合起来算。
 */
export function turnDigests(
  records: readonly TranscriptRecord[],
  turnActive: boolean,
  results: ToolResultIndex = indexToolResults(
    records.filter((record) => record.role === "tool") as Parameters<typeof indexToolResults>[0],
  ),
): TurnDigest[] {
  const view = groupTurnsByTurn(groupToolUnits(flattenRenderUnits(records)), turnActive, results);
  const turns: TurnDigest[] = [];
  let current: TurnDigest | null = null;
  const units: TurnProcessUnit[][] = [];
  for (const entry of view) {
    if (entry.kind === "user") {
      const text = entry.item.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      current = {
        key: entry.key,
        ask: askLine(text),
        at: entry.item.timestamp,
        processKeys: [],
        chapters: [],
        steps: 0,
        files: 0,
        failed: 0,
        durationMs: null,
        live: false,
      };
      turns.push(current);
      units.push([]);
      continue;
    }
    if (entry.kind !== "turnProcess" || current === null) continue;
    units[units.length - 1]?.push(entry);
    current.processKeys.push(entry.key);
    current.live = current.live || entry.live;
  }
  turns.forEach((turn, index) => {
    const own = units[index] ?? [];
    const steps = own.flatMap((unit) => unit.steps);
    const counts = processCounts(steps, results);
    turn.chapters = processChapters(steps);
    turn.steps = counts.steps;
    turn.files = counts.files.length;
    turn.failed = counts.failed;
    // 在跑的那一轮不给用时：已落定各步的跨度在两步之间是冻住的（面板上「14.7 秒」不动，
    // 头一行的钟已经走到 0:18），头一行那个每秒走的钟就是它的用时
    const spans = own.map((unit) => unit.durationMs).filter((ms): ms is number => ms !== null);
    turn.durationMs = turn.live || spans.length === 0 ? null : spans.reduce((sum, ms) => sum + ms, 0);
  });
  return turns;
}

/** 只有代码围栏的一行：``` / ~~~（可带语言名），含贴进来时被转义成 \`\`\` 的 */
const FENCE_LINE = /^(?:(?:\\?`){3,}|~{3,})[\w+-]*$/;

/**
 * 用户那句话在面板上的一行：第一行有字的内容，只有围栏的行跳过——以代码块开头的提问
 * （贴一段日志 / 选项再说「继续」）原来在「做过的」里只剩一行 ```。
 */
function askLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line !== "" && !FENCE_LINE.test(line)) return line;
  }
  return "";
}
