/**
 * 右栏「这条任务 › 进度」的推导（2026-10-30）：头一行的状态与「做过的」（计划的版本线在 plan-timeline.ts）
 * （按轮列，轮下是章节——与对话里过程块展开后的章节同一份推导，turn-process.ts）。
 *
 * 全部从转录推，不另存：回退、分支、重开会话都跟着转录走。
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import type { PlanItemStatus } from "../../../../shared/plan.ts";
import type { PlanView } from "./plan-timeline.ts";
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

/** 头一行的状态：侧栏状态饼的四档，再加一个只说字、不画饼的「停下了」 */
export type TaskHeadState = "running" | "waiting" | "done" | "failed" | "stopped";

/**
 * 计划里一步在面板上怎么画：画成什么状态、要不要画「在做」的蓝饼。
 * - 蓝饼的前提是会话真的在跑 / 等你（working）；停下之后画空圈；
 * - **计划停下等你确认时（awaiting），计划里不出现在做的步**：agent 写计划时习惯把第一步标成 in_progress，
 *   可这一轮写完计划就停了、什么都还没开始做；头一行此时恰好是「等你」（working 为真），第 0 期因此把第一步
 *   画成了在做的蓝饼（2026-10-30 实测，plan 档停下的截图）。等确认时 in_progress 一律按待做画——
 *   不画饼、不加粗（加粗也是「在做」的信号）、不走计时；等你回答后它改计划 / 开工，那一步才变成在做。
 */
export function stepDisplay(status: PlanItemStatus, ctx: { working: boolean; awaiting: boolean }): { status: PlanItemStatus; active: boolean } {
  if (ctx.awaiting && status === "in_progress") return { status: "pending", active: false };
  return { status, active: status === "in_progress" && ctx.working };
}

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
 * 「在做」那步从几点开始计：它这一次变成「在做」的时刻（plan-timeline 的 stepActiveSince）。
 * 那是前几轮的事、这一轮模型没再更新（续聊）时从这一轮开始算——不然两轮之间闲着的时间都算进去，隔夜续聊就是十几个小时。
 */
export function stepClockFrom(since: number, turns: readonly TurnDigest[]): number {
  const last = turns.at(-1);
  return last === undefined ? since : Math.max(since, last.at);
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
  results: ToolResultIndex = toolIndexOf(records),
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

/**
 * 整个任务的「做过的」要对全量记录算，而面板每条流式事件都重算（实测 turnDigests 在 4.9k 条
 * 记录上约 2 ms、12.3k 条约 3.7 ms 一次）。拉来的更早那段是静的：切在它最后一条用户消息前——
 * 之前的轮都已收完（落定段），只在拉到新的一页时重算；其余（更早那段的最后一轮 + 尾窗）
 * 每条事件重算，量与对话自己算的同级。返回落定段的长度（0 = 没有落定段）。
 */
export function settledEnd(older: readonly TranscriptRecord[]): number {
  for (let i = older.length - 1; i >= 0; i--) {
    if (older[i]?.role === "user") return i;
  }
  return 0;
}

/**
 * 落定段之后要每次重算的那截：更早那段里落定段之后的记录 + 尾窗里不在更早那段的记录
 * （聊天面自己往上翻会把同一批装进尾窗，重叠可能伸进落定段，所以按整个更早那段的 id 去重）。
 * 落定段 + 这一截 = mergeHistory(older, current)。
 */
export function liveTail(
  older: readonly TranscriptRecord[],
  end: number,
  current: readonly TranscriptRecord[],
  olderIds: ReadonlySet<string>,
): TranscriptRecord[] {
  return [...older.slice(end), ...current.filter((record) => !olderIds.has(record.id))];
}

/** 记录里的工具帧索引（记录里混着界碑 / 轮尾账等，indexToolResults 只要 tool 帧） */
export function toolIndexOf(records: readonly TranscriptRecord[]): ToolResultIndex {
  return indexToolResults(
    records.filter((record) => record.role === "tool") as Parameters<typeof indexToolResults>[0],
  );
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
