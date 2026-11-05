/**
 * 全局周看板的数据（`board:week`）：一周 7 天，每天
 * - `items`：已经跑过的自动化运行（按运行时刻），带那次会话里 show_plugin_board 的卡快照；
 * - `planned`：还没到的排期（按 schedule 推算），只算 active 的——暂停 / 完成 / 失败的不算。
 *
 * **纯核 + 注入**：自动化列表、时钟、按会话读快照都是注入的，可被 `node --test` 直测（改 TZ 测本地时区）。
 * 天的边界一律按本地日历加减（`localDayStart`），不 ±86400000——夏令时那天是 23 / 25 小时。
 *
 * 快照**不复制**进 automations.json：运行记录只记 toolCallId（`boardSnapshotIds`），这里按 id 回会话记录里找
 * 工具结果的 details。读会话用按行粗筛（jsonl-scan）：只有 show_plugin_board 的工具行才整行解码。
 */
import { headStringField, scanJsonlLines } from "../jsonl-scan.ts";
import { isNotFound } from "../fs-errors.ts";
import {
  AUTOMATION_MAX_RUNS_PER_DAY,
  automationWorkspaceId,
  intervalMinutes,
  nextRunAfter,
  type Automation,
} from "../../shared/automation.ts";
import {
  localDayStart,
  localWeekStart,
  parsePluginBoardDetails,
  type BoardCardSnapshot,
  type BoardPlannedRun,
  type BoardWeekDay,
  type BoardWeekItem,
  type BoardWeekResponse,
  type PluginBoardResult,
} from "../../shared/plugin-board.ts";
import { PLUGIN_BOARD_TOOL } from "../../shared/permission.ts";

/** 一条自动化推算排期时最多走这么多步（hourly 往后翻两年多才撞上；防止坏数据死循环） */
const MAX_STEPS = 20_000;

/**
 * 一条自动化在 [from, to) 里排好的运行时刻（升序）。从它真实的 `nextRunAt` 起，按 `nextRunAfter` 一步步推：
 * - 只算 active；`nextRunAt` 为 null（once 已触发、等着送达……）没有排期；
 * - 早于 `now` 的不算（过了点还没跑的那一次马上就会变成 items）；
 * - 尊重终点：越过 `until` 停；`maxRuns` 剩几次只排几次（过了点的那一次也占一次）；
 * - 每个本地日最多 24 次（运行护栏：滚动 24 小时 ≤ 24 次，按日历日近似）；
 * - interval 起点远早于 from 时直接跳格，不逐步走。
 */
export function plannedTimes(automation: Automation, from: number, to: number, now: number): number[] {
  if (automation.status !== "active" || automation.nextRunAt === null) return [];
  let t: number | null = automation.nextRunAt;
  let remaining = automation.maxRuns === undefined ? Number.POSITIVE_INFINITY : automation.maxRuns - automation.runCount;
  const lower = Math.max(from, now);
  if (automation.schedule.kind === "interval" && t < lower) {
    const step = intervalMinutes(automation.schedule) * 60_000;
    const skip = Math.floor((lower - t) / step);
    t += skip * step;
    remaining -= skip;
  }
  const out: number[] = [];
  const perDay = new Map<number, number>();
  for (let steps = 0; t !== null && t < to && remaining > 0 && steps < MAX_STEPS; steps += 1) {
    if (automation.until !== undefined && t > automation.until) break;
    if (t >= lower) {
      const day = startOfLocalDay(t);
      const count = perDay.get(day) ?? 0;
      if (count < AUTOMATION_MAX_RUNS_PER_DAY) {
        out.push(t);
        perDay.set(day, count + 1);
      }
    }
    remaining -= 1;
    t = nextRunAfter(automation.schedule, t);
  }
  return out;
}

function startOfLocalDay(t: number): number {
  const date = new Date(t);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 读一条会话里指定 toolCallId 的 show_plugin_board 结果。读不了的会话回空表（会话被删了很正常）。 */
export async function readBoardSnapshots(recordPath: string, toolCallIds: ReadonlySet<string>): Promise<Map<string, PluginBoardResult>> {
  const found = new Map<string, PluginBoardResult>();
  if (toolCallIds.size === 0) return found;
  try {
    await scanJsonlLines(
      recordPath,
      (head) => {
        // 键序是 JSON.stringify 写出的 id / role / toolCallId / toolName；读不出来就保守地留下整行
        const role = headStringField(head, "role");
        if (role !== undefined && role !== "tool") return false;
        const toolName = headStringField(head, "toolName");
        if (toolName !== undefined && toolName !== PLUGIN_BOARD_TOOL) return false;
        const callId = headStringField(head, "toolCallId");
        return callId === undefined || toolCallIds.has(callId);
      },
      (line) => {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof record !== "object" || record === null) return;
        const item = record as Record<string, unknown>;
        if (item["role"] !== "tool" || item["toolName"] !== PLUGIN_BOARD_TOOL || item["isError"] === true) return;
        const callId = item["toolCallId"];
        if (typeof callId !== "string" || !toolCallIds.has(callId)) return;
        const board = parsePluginBoardDetails(item["details"]);
        if (board !== null) found.set(callId, board);
      },
    );
  } catch (error) {
    if (!isNotFound(error)) console.error(`[board] 读会话里的看板快照失败：${recordPath}`, error);
  }
  return found;
}

/**
 * 一次运行的卡：按调用顺序合并它所有 show_plugin_board 的快照，同一张卡（id + index）后一次覆盖前一次——
 * 模型重试 / 分批显示时，留下的是它最后给用户看的样子。
 */
export function mergeRunCards(boards: readonly PluginBoardResult[]): BoardCardSnapshot[] {
  const byKey = new Map<string, BoardCardSnapshot>();
  for (const board of boards) for (const card of board.cards) byKey.set(`${card.id}:${card.index}`, card);
  return [...byKey.values()];
}

export interface BoardWeekDeps {
  automations: () => Promise<Automation[]>;
  /** 会话记录文件路径（会话 id 不合规时抛，调用方当没有） */
  recordPath: (sessionId: string) => string;
  now: () => number;
  /** 默认 readBoardSnapshots；测试注入 */
  readSnapshots?: (recordPath: string, ids: ReadonlySet<string>) => Promise<Map<string, PluginBoardResult>>;
}

/** `board:week` 的装配。入参不可信：非有限数回 null，其余规整到所在那一周的周一 00:00。 */
export async function assembleBoardWeek(deps: BoardWeekDeps, rawWeekStart: unknown): Promise<BoardWeekResponse | null> {
  if (typeof rawWeekStart !== "number" || !Number.isFinite(rawWeekStart)) return null;
  const weekStart = localWeekStart(rawWeekStart);
  const now = deps.now();
  const bounds = Array.from({ length: 8 }, (_, i) => localDayStart(weekStart, i));
  const weekEnd = bounds[7] ?? weekStart;
  const days: BoardWeekDay[] = Array.from({ length: 7 }, (_, i) => ({ start: bounds[i] ?? 0, end: bounds[i + 1] ?? 0, items: [], planned: [] }));
  const dayOf = (t: number): BoardWeekDay | undefined => days.find((day) => t >= day.start && t < day.end);

  const automations = await deps.automations();
  const read = deps.readSnapshots ?? readBoardSnapshots;

  // 这一周的运行，按会话归拢 toolCallId：一条会话只读一遍
  const runs: { automation: Automation; run: Automation["runs"][number] }[] = [];
  const idsBySession = new Map<string, Set<string>>();
  for (const automation of automations) {
    for (const run of automation.runs) {
      if (run.status === "skipped" || run.runAt < weekStart || run.runAt >= weekEnd) continue;
      runs.push({ automation, run });
      if (run.sessionId === null || run.boardSnapshotIds === undefined) continue;
      const set = idsBySession.get(run.sessionId) ?? new Set<string>();
      for (const id of run.boardSnapshotIds) set.add(id);
      idsBySession.set(run.sessionId, set);
    }
  }
  const snapshots = new Map<string, Map<string, PluginBoardResult>>();
  for (const [sessionId, ids] of idsBySession) {
    let path: string;
    try {
      path = deps.recordPath(sessionId);
    } catch {
      continue;
    }
    snapshots.set(sessionId, await read(path, ids));
  }

  for (const { automation, run } of runs) {
    const found = run.sessionId === null ? undefined : snapshots.get(run.sessionId);
    const boards = (run.boardSnapshotIds ?? []).map((id) => found?.get(id)).filter((board): board is PluginBoardResult => board !== undefined);
    const last = boards.at(-1);
    const item: BoardWeekItem = {
      at: run.runAt,
      automationId: automation.id,
      automationTitle: automation.title,
      plugin: automation.plugin?.name ?? last?.plugin ?? null,
      pluginTitle: last?.displayName ?? automation.plugin?.name ?? null,
      sessionId: run.sessionId,
      cards: mergeRunCards(boards),
      runId: run.id,
      status: run.status === "running" ? "running" : run.status === "success" ? "success" : "error",
      workspaceId: automationWorkspaceId(automation),
    };
    dayOf(run.runAt)?.items.push(item);
  }

  for (const automation of automations) {
    for (const at of plannedTimes(automation, weekStart, weekEnd, now)) {
      const planned: BoardPlannedRun = {
        at,
        automationId: automation.id,
        title: automation.title,
        plugin: automation.plugin?.name ?? null,
        workspaceId: automationWorkspaceId(automation),
      };
      dayOf(at)?.planned.push(planned);
    }
  }
  for (const day of days) {
    day.items.sort((a, b) => a.at - b.at);
    day.planned.sort((a, b) => a.at - b.at);
  }
  return { weekStart, now, days };
}
