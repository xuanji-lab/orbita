/**
 * 对话区右上角「状态」卡（原型，2026-11-22）的纯推导：子会话挂到哪一步、子会话此刻在跑什么、
 * 收着时计划露哪几步、走表多久跳一次、收起小钮说哪一种状态、产物的类型词。
 *
 * 用户的出发点（2026-11-22 17:21）：「我看进度为了知道进度到哪了。我看产物为了知道我产出了些什么。
 * 我看子会话只是想知道他们是否还在工作。」——这张卡跨轮常驻，所以有固定位置，不进对话流。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import type { ChannelStatus } from "@shared/channel";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";
import type { PlanStep, PlanTimeline } from "./plan-timeline.ts";
import type { TurnOutput } from "../chat/process-rows.ts";
import { sessionOutputs } from "../chat/child-outputs.ts";

// ───────────────────────── 子会话挂到哪一步 ─────────────────────────

/**
 * 子会话 → 计划步骤 id（不改契约的推导）：**派出它的那次 delegate 调用发生时，当前这张计划里在做的那一步**。
 * 按转录顺序走：遇到 update_plan 换「此刻在做的步」（只认当前这张计划的版本——旧计划的步 id 在当前计划里不存在），
 * 遇到 delegate 就把它的 childId 记到那一步。在做的步不存在（写计划之前、全是待做、全做完）= null（「没挂在计划上的」）；
 * 那一步后来被删掉了也 = null。
 *
 * 会错的情况（报告里列）：模型先派人、后改计划（同一批里 delegate 在 update_plan 之前）→ 挂到上一步；
 * 一步做完没打勾就派下一步的人 → 挂到上一步；子会话做的其实是另一步的活（模型没改计划）→ 挂错，只能靠步骤名短而准来暴露。
 */
export function delegationSteps(records: readonly TranscriptRecord[], timeline: PlanTimeline | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const versionByCall = new Map((timeline?.versions ?? []).map((version) => [version.toolCallId, version]));
  const alive = new Set((timeline?.current.items ?? []).map((item) => item.id));
  let active: string | null = null;
  for (const record of records) {
    if (record.role !== "tool") continue;
    if (record.toolName === PLAN_TOOL_NAME) {
      const version = versionByCall.get(record.toolCallId);
      // 旧计划（被一张新计划顶掉的）里的步，在当前计划里没有对应：那段时间派的人算「没挂上」
      active = version === undefined ? null : (version.items.find((item) => item.status === "in_progress")?.id ?? null);
      continue;
    }
    if (record.toolName !== "delegate") continue;
    const childId = delegateChildId(record.details);
    if (childId === null) continue;
    out.set(childId, active !== null && alive.has(active) ? active : null);
  }
  return out;
}

function delegateChildId(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["delegate"];
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["childId"];
  return typeof id === "string" && id !== "" ? id : null;
}

// ───────────────────────── 子会话此刻在跑什么 ─────────────────────────

export interface ChildActivity {
  toolName: string;
  input: unknown;
  /** 这次调用开始的时刻 */
  since: number;
}

/**
 * 子会话转录的尾巴 → 正在跑的那次工具调用（状态 running 的工具记录；或 assistant 发出了调用、结果还没来）。
 * 没有在跑的调用 = null（在想、在写回答、已停）。
 */
export function childActivityOf(records: readonly TranscriptRecord[]): ChildActivity | null {
  const resolved = new Set<string>();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (record.role === "tool") {
      if (record.status === "running") return { toolName: record.toolName, input: record.input, since: record.timestamp };
      resolved.add(record.toolCallId);
      continue;
    }
    if (record.role === "assistant") {
      for (const block of record.content) {
        if (block.type === "toolCall" && !resolved.has(block.toolCallId)) {
          return { toolName: block.toolName, input: block.input, since: record.timestamp };
        }
      }
      // 最后一条 assistant 的调用都有结果：此刻不在跑工具
      return null;
    }
    if (record.role === "user") return null;
  }
  return null;
}

/** 一次工具调用的一行字：「bash bun run typecheck」「read TaskProgress.tsx」——工具名 + 最能认出它的那个参数 */
export function toolCallLine(toolName: string, input: unknown): string {
  const value = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const raw = value[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim().split("\n")[0] ?? null : null;
  };
  const tail = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const arg =
    pick("command") ??
    (pick("path") !== null ? tail(pick("path") ?? "") : null) ??
    pick("query") ??
    pick("pattern") ??
    (pick("url") !== null ? hostOf(pick("url") ?? "") : null) ??
    pick("terminalId");
  return arg === null ? toolName : `${toolName} ${arg}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 同一个工具调用跑了这么久就算「卡得异常久」（P97 的空档是 28 秒；一条命令十分钟没动静，人该看一眼） */
export const STUCK_MS = 10 * 60_000;

/** 状态卡里一个子会话的状态：在子会话面板那七档之上，多一档 stuck（在跑，但同一个调用跑太久了） */
export type ChildState = "running" | "stuck" | "waiting" | "approval" | "done" | "failed" | "stopped" | "idle";

/**
 * 一个子会话此刻的状态。running 的来源有二：引擎说它在跑（真跑着的）；或通道没关、转录尾巴有一次在跑的调用
 * （原型的合成数据没有真跑着的子会话，靠这一条；真实现里由引擎的 phase 说话，转录尾巴只给「在跑什么」）。
 */
export function childStateOf(input: {
  channelStatus: ChannelStatus | undefined;
  needsApproval: boolean;
  enginePhaseRunning: boolean;
  activity: ChildActivity | null;
  now: number;
}): ChildState {
  if (input.channelStatus === "waiting") return "waiting";
  if (input.channelStatus === "stopped") return "stopped";
  if (input.needsApproval) return "approval";
  const open = input.channelStatus === undefined || input.channelStatus === "running";
  const running = input.enginePhaseRunning || (open && input.activity !== null);
  if (running) return input.activity !== null && input.now - input.activity.since > STUCK_MS ? "stuck" : "running";
  if (input.channelStatus === "done") return "done";
  if (input.channelStatus === "failed") return "failed";
  return "idle";
}

/** 「在干活」的：步骤行尾画机器人头像的那些 */
export function isWorking(state: ChildState): boolean {
  return state === "running" || state === "stuck" || state === "waiting" || state === "approval";
}

/** 一步下面的子会话怎么排：要你的（在问 / 待批 / 卡住 / 失败）在前，其次在跑，已交回的最后 */
const CHILD_ORDER: Record<ChildState, number> = { waiting: 0, approval: 0, stuck: 1, failed: 2, running: 3, idle: 4, stopped: 5, done: 6 };

export function sortChildren<T extends { state: ChildState; since: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => CHILD_ORDER[a.state] - CHILD_ORDER[b.state] || a.since - b.since);
}

// ───────────────────────── 计划收着时露哪几步 ─────────────────────────

export type PlanWindowRow = { kind: "step"; index: number } | { kind: "fold"; count: number; where: "before" | "between" | "after" };

/**
 * 收着的计划：露「正在发生的」步——在做的、在等的、挂着在干活的子会话的——加上它们前面最近做完的一步、
 * 后面紧跟的一步待做；其余折成「N 个更早的步骤」/「N 步」/「还有 N 步」。四步以内全露（折了反而更长）。
 * 没有正在发生的步：露最后做完的一步和下一步。
 */
export function planWindow(items: readonly Pick<PlanStep, "id" | "status">[], live: ReadonlySet<string>): PlanWindowRow[] {
  if (items.length <= 4) return items.map((_, index) => ({ kind: "step", index }));
  const isLive = (index: number): boolean => {
    const item = items[index];
    return item !== undefined && (item.status === "in_progress" || item.status === "waiting" || live.has(item.id));
  };
  const liveIdx = items.map((_, index) => index).filter(isLive);
  const shown = new Set(liveIdx);
  const first = liveIdx[0];
  const lastLive = liveIdx.at(-1);
  const lastDoneBefore = (limit: number): number => {
    for (let index = limit - 1; index >= 0; index -= 1) if (items[index]?.status === "done") return index;
    return -1;
  };
  if (first === undefined || lastLive === undefined) {
    const done = lastDoneBefore(items.length);
    if (done >= 0) shown.add(done);
    if (done + 1 < items.length) shown.add(done + 1);
  } else {
    const done = lastDoneBefore(first);
    if (done >= 0) shown.add(done);
    if (lastLive + 1 < items.length) shown.add(lastLive + 1);
  }
  const rows: PlanWindowRow[] = [];
  let gap = 0;
  let seen = false;
  items.forEach((_, index) => {
    if (!shown.has(index)) {
      gap += 1;
      return;
    }
    if (gap > 0) rows.push({ kind: "fold", count: gap, where: seen ? "between" : "before" });
    gap = 0;
    seen = true;
    rows.push({ kind: "step", index });
  });
  if (gap > 0) rows.push({ kind: "fold", count: gap, where: "after" });
  return rows;
}

// ───────────────────────── 走表 ─────────────────────────

/**
 * 下一次要重画的时间（毫秒后）：只有在跑项才走（since 列表为空 = null，不走表）；显示精度是「秒」的（不到一分钟）
 * 每秒跳，否则按分钟跳——对齐到最早一个「下一分钟」的边界，四十个计时也只醒一次。
 */
export function nextTickIn(sinces: readonly number[], now: number): number | null {
  if (sinces.length === 0) return null;
  let wait = 60_000;
  for (const since of sinces) {
    const elapsed = Math.max(0, now - since);
    if (elapsed < 60_000) return 1000 - (elapsed % 1000);
    wait = Math.min(wait, 60_000 - (elapsed % 60_000));
  }
  return Math.max(250, wait);
}

/** 跑了多久的字：不到一分钟写秒，不到一小时写分，再长写时 + 分（分钟级，不写秒——秒在跳只会吸走眼睛） */
export function elapsedParts(ms: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

// ───────────────────────── 收起小钮说哪一种 ─────────────────────────

export type PillSignal = { kind: "waiting" | "failed" | "stuck" | "running"; count: number } | null;

/**
 * 收起后的小钮只说一件事，按「要不要你」排：在问你 / 待批 > 失败（还没看）> 卡住 > 在跑（Codex 宠物同一个思路：
 * 一个指示器同时有几种动静时，按优先级只露一种）。都没有 = null，小钮安静。
 */
export function pillSignal(states: readonly ChildState[], extraRunning: number): PillSignal {
  const count = (pick: (state: ChildState) => boolean) => states.filter(pick).length;
  const waiting = count((state) => state === "waiting" || state === "approval");
  if (waiting > 0) return { kind: "waiting", count: waiting };
  const failed = count((state) => state === "failed");
  if (failed > 0) return { kind: "failed", count: failed };
  const stuck = count((state) => state === "stuck");
  if (stuck > 0) return { kind: "stuck", count: stuck };
  const running = count((state) => state === "running") + extraRunning;
  return running > 0 ? { kind: "running", count: running } : null;
}

// ───────────────────────── 产物 ─────────────────────────

/** 状态卡里的一份产物：结尾产物卡那套口径（allOutputs）+ 看板 + 按扩展名认出的视频 / 图片 / 画布 */
export type StatusOutputKind = "slides" | "doc" | "web" | "pdf" | "word" | "pptx" | "sheet" | "board" | "canvas" | "video" | "image" | "file";

export interface StatusOutput {
  kind: StatusOutputKind;
  path: string;
  title: string;
  /** 演示文稿页数等补充（量不到 null） */
  pages: number | null;
  /** 子会话做的：它的标题；主会话自己的 = null */
  by: string | null;
  at: number;
}

const EXT_KIND: Readonly<Record<string, StatusOutputKind>> = {
  pdf: "pdf",
  docx: "word",
  doc: "word",
  pptx: "pptx",
  xlsx: "sheet",
  csv: "sheet",
  mp4: "video",
  mov: "video",
  webm: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  svg: "image",
  gif: "image",
  webp: "image",
  canvas: "canvas",
};

/** 结尾产物卡认的 → 状态卡的类型词 */
export function statusKindOf(output: TurnOutput): StatusOutputKind {
  if (output.kind === "slides") return "slides";
  if (output.kind === "doc") return "doc";
  if (output.kind === "web") return "web";
  return EXT_KIND[extOf(output.path)] ?? "file";
}

/** 文件账里写出的、结尾产物卡不收的东西里，哪些也算交给你的产物（视频、图片、画布、表格） */
export function mediaKindOf(path: string): StatusOutputKind | null {
  const kind = EXT_KIND[extOf(path)];
  return kind === "video" || kind === "image" || kind === "canvas" || kind === "sheet" ? kind : null;
}

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 插件看板结果里的看板名（details.pluginBoard.title / plugin）；没有 = null */
export function boardTitleOf(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const board = (details as Record<string, unknown>)["pluginBoard"];
  if (typeof board !== "object" || board === null) return null;
  const record = board as Record<string, unknown>;
  const title = record["title"] ?? record["plugin"];
  return typeof title === "string" && title !== "" ? title : null;
}

/**
 * 一条会话做出来的全部产物（新的在前）：结尾产物卡同一套口径（sessionOutputs）+ 插件看板 + 文件账里写出的
 * 视频 / 图片 / 画布 / 表格。by = 子会话标题（主会话自己的 null）。
 */
export function statusOutputs(records: readonly TranscriptRecord[], by: string | null): StatusOutput[] {
  const { outputs, edited } = sessionOutputs(records);
  const at = records.at(-1)?.timestamp ?? 0;
  const list: StatusOutput[] = outputs.map((output) => ({ kind: statusKindOf(output), path: output.path, title: output.title, pages: output.pages, by, at }));
  for (const path of edited) {
    const kind = mediaKindOf(path);
    if (kind !== null) list.push({ kind, path, title: path.split(/[\\/]/).pop() ?? path, pages: null, by, at });
  }
  for (const record of records) {
    if (record.role !== "tool" || record.toolName !== "show_plugin_board" || record.status !== "complete") continue;
    const title = boardTitleOf(record.details);
    if (title !== null && !list.some((item) => item.path === `board:${title}`)) {
      list.push({ kind: "board", path: `board:${title}`, title, pages: null, by, at: record.timestamp });
    }
  }
  return list.reverse();
}
