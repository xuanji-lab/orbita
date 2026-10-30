/**
 * 计划的版本线（2026-10-30）：从转录里的 update_plan 调用推出「这张计划改过几次、每次改了什么、
 * 为什么」，以及每一步用了几步工具、挂着哪几章。全部从转录推，不另存——回退、分支、重开会话
 * 都跟着转录走。
 *
 * - 一张计划 = 一串版本（每次有效的 update_plan 是一个版本）。新写的一版与上一版一步都对不上，
 *   就是一张新计划，上一张进历史（只保留当前这一串）；
 * - 步骤 id 由系统按文字对齐得出（shared/plan-diff.ts），模型不写；
 * - 归属：一次工具调用属于「它那一刻最近一版计划里在做的那一步」（同批规则：update_plan 与下一步的
 *   第一个动作同批，所以这一批的调用都算新的那步）；写计划之前的调用归「开工前」，没有在做的步
 *   时（全是待做或全勾完）归「计划外」。一章跟它第一个干活的调用走。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import {
  parsePlanCall,
  parsePlanNotes,
  PLAN_STATUSES,
  PLAN_TOOL_NAME,
  type PlanItem,
  type PlanLater,
  type PlanToolDetails,
} from "../../../../shared/plan.ts";
import { assignStepIds, diffPlans, type PlanChange } from "../../../../shared/plan-diff.ts";
import type { ProcessChapter } from "../chat/turn-process.ts";

/** 一步的出处：它是这张计划写下之后才出现的（加 / 改说法 / 拆出），面板在行下写一句 */
export interface StepNote {
  kind: "added" | "reworded" | "split";
  /** 那一版写的理由；没写 = null */
  why: string | null;
  /** 原文字（改说法 / 拆出时）；加了 = null */
  from: string | null;
  /** 第几版出现的 */
  version: number;
}

export interface PlanStep extends PlanItem {
  id: string;
  note: StepNote | null;
}

export interface PlanVersion {
  /** 这一串里的第几版（1 起） */
  n: number;
  recordId: string;
  toolCallId: string;
  at: number;
  items: PlanStep[];
  why: string | null;
  later: PlanLater[];
  /** 相对上一版的改动；只打勾 / 第一版 = 空 */
  changes: PlanChange[];
  /** 这一版去掉的步（含 id）与原位置（排在新清单第几步之后，-1 = 最前） */
  removed: { id: string; text: string; afterNext: number }[];
  /** 模型带的问题（confirm）；空 = 没有 */
  confirm: string[];
  /** 这一次调用让这一轮停下来等确认（工具结果 details.awaiting；还在跑的版本没有） */
  awaiting: boolean;
}

export interface PlanTimeline {
  /** 当前这张计划的全部版本，旧 → 新 */
  versions: PlanVersion[];
  current: PlanVersion;
  /** 改动过的版本数（不含第一版、不含只打勾的） */
  edits: number;
}

/** 写计划之前的调用 / 没有在做的步时的调用 */
export const BEFORE_PLAN = "before-plan";
export const OUTSIDE_PLAN = "outside-plan";

interface RawVersion {
  record: Extract<TranscriptRecord, { role: "tool" }>;
  items: PlanItem[];
  why: string | null;
  later: PlanLater[];
  confirm: string[];
}

/** 一条 update_plan 记录里的计划：被拒的不算；还在跑的过工具同一套校验；执行完的宽松读 */
function rawVersion(record: TranscriptRecord): RawVersion | null {
  if (record.role !== "tool" || record.toolName !== PLAN_TOOL_NAME || record.status === "error") return null;
  if (record.status === "complete") {
    const items = looseItems(record.input);
    if (items.length === 0) return null;
    return { record, items, ...parsePlanNotes(record.input) };
  }
  try {
    const call = parsePlanCall(record.input);
    return { record, items: call.items, why: call.why, later: call.later, confirm: call.confirm };
  } catch {
    return null;
  }
}

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

function awaitingOf(record: Extract<TranscriptRecord, { role: "tool" }>): boolean {
  const details = record.details as Partial<PlanToolDetails> | undefined;
  return details?.awaiting === true;
}

/**
 * 转录 → 当前这张计划的版本线。没写过计划 = null。
 * 只看 update_plan 记录；传整段转录或只传其中的 update_plan 记录结果一样。
 */
export function planTimeline(records: readonly TranscriptRecord[]): PlanTimeline | null {
  let versions: PlanVersion[] = [];
  let prevItems: PlanItem[] | null = null;
  let ids: string[] | null = null;
  let counter = 0;
  const mint = (): string => `s${++counter}`;
  for (const record of records) {
    const raw = rawVersion(record);
    if (raw === null) continue;
    const diff = diffPlans(prevItems, raw.items);
    // 一张新计划：上一张进历史，id 与版本号从头来
    if (diff.fresh) {
      versions = [];
      ids = null;
    }
    const prev = versions.at(-1);
    const stepIds = assignStepIds(ids, diff, mint);
    const n = versions.length + 1;
    const items: PlanStep[] = raw.items.map((item, i) => {
      const origin = diff.origins.get(i);
      const pairedPrev = diff.pairs[i];
      let note: StepNote | null = null;
      if (origin !== undefined && !diff.fresh) {
        note = { kind: origin.kind, why: raw.why, from: origin.from, version: n };
      } else if (pairedPrev !== null && pairedPrev !== undefined && prev !== undefined) {
        // 配上的步沿用上一版的出处
        note = prev.items[pairedPrev]?.note ?? null;
      } else if (prev !== undefined && !diff.fresh && pairedPrev === null) {
        note = { kind: "added", why: raw.why, from: null, version: n };
      }
      return { id: stepIds[i] ?? mint(), text: item.text, status: item.status, note };
    });
    const removed = diff.fresh
      ? []
      : diff.removed.map((entry) => {
          const index = prevItems?.findIndex((old) => old.text === entry.text) ?? -1;
          return { id: (index >= 0 ? ids?.[index] : undefined) ?? "", text: entry.text, afterNext: entry.afterNext };
        });
    versions.push({
      n,
      recordId: raw.record.id,
      toolCallId: raw.record.toolCallId,
      at: raw.record.timestamp,
      items,
      why: raw.why,
      later: raw.later,
      changes: diff.fresh ? [] : diff.changes,
      removed,
      confirm: raw.confirm,
      awaiting: awaitingOf(raw.record),
    });
    prevItems = raw.items;
    ids = stepIds;
  }
  const current = versions.at(-1);
  if (current === undefined) return null;
  return { versions, current, edits: versions.filter((version) => version.changes.length > 0).length };
}

/** 进度面板头一行与计时用的最小形状（taskHeadState / stepClockFrom 只认这几个字段） */
export interface PlanView {
  items: PlanItem[];
  /** 这张计划最近一版写下的时刻：「在做」那步的计时从这里起 */
  at: number;
  done: number;
}

export function planView(timeline: PlanTimeline | null): PlanView | null {
  if (timeline === null) return null;
  const { current } = timeline;
  return { items: current.items, at: current.at, done: current.items.filter((item) => item.status === "done").length };
}

/** 某一版里在做的那步的 id；没有在做的 = null */
function activeStepId(version: PlanVersion): string | null {
  return version.items.find((item) => item.status === "in_progress")?.id ?? null;
}

/** 时刻 t 那一刻的调用归哪里：最近一版（at ≤ t）里在做的步；没有版本 = 开工前；没有在做的步 = 计划外 */
export function bucketAt(timeline: PlanTimeline | null, t: number): string {
  if (timeline === null) return BEFORE_PLAN;
  let found: PlanVersion | undefined;
  for (const version of timeline.versions) {
    if (version.at <= t) found = version;
    else break;
  }
  if (found === undefined) return BEFORE_PLAN;
  return activeStepId(found) ?? OUTSIDE_PLAN;
}

/**
 * 这一步这一次变成「在做」是几点：往回数最近一段连续在做的版本，取最早那一版的写下时刻。
 * 中途让位给新加的步、回来再做，钟重新计（用户 2026-10-30：「在做那步的钟从它这一次变成在做算起」）。
 * 这一步当前不在做 = null。
 */
export function stepActiveSince(timeline: PlanTimeline, stepId: string): number | null {
  let since: number | null = null;
  for (let i = timeline.versions.length - 1; i >= 0; i--) {
    const version = timeline.versions[i];
    if (version?.items.find((item) => item.id === stepId)?.status !== "in_progress") break;
    since = version.at;
  }
  return since;
}

export interface StepChapter {
  chapter: ProcessChapter;
  turnKey: string;
  /** 点一章让对话滚到哪一块（这一轮的第一个过程块） */
  processKey: string | undefined;
  live: boolean;
}

export interface StepActivity {
  /** 干活的工具调用数（不含 update_plan） */
  calls: number;
  /** 写过 / 改过的文件（去重） */
  files: string[];
  failed: number;
  chapters: StepChapter[];
  /** 这一步的最后一次调用在转录里还在跑 */
  running: boolean;
}

interface DigestLike {
  key: string;
  processKeys: string[];
  chapters: ProcessChapter[];
  live: boolean;
}

/**
 * 把各轮的章节与调用按计划步归拢：返回 bucket（步 id / BEFORE_PLAN / OUTSIDE_PLAN）→ 活动。
 * `statusOf` 取工具调用的结果状态（失败计数用）。
 */
export function groupBySteps(
  timeline: PlanTimeline | null,
  turns: readonly DigestLike[],
  statusOf: (toolCallId: string) => string | undefined,
): Map<string, StepActivity> {
  const out = new Map<string, StepActivity>();
  const of = (bucket: string): StepActivity => {
    let activity = out.get(bucket);
    if (activity === undefined) {
      activity = { calls: 0, files: [], failed: 0, chapters: [], running: false };
      out.set(bucket, activity);
    }
    return activity;
  };
  for (const turn of turns) {
    turn.chapters.forEach((chapter, index) => {
      const work = chapter.calls.filter((call) => call.toolName !== PLAN_TOOL_NAME);
      let chapterBucket: string | null = null;
      for (const call of work) {
        const bucket = bucketAt(timeline, call.timestamp);
        chapterBucket ??= bucket;
        const activity = of(bucket);
        activity.calls += 1;
        const status = statusOf(call.toolCallId);
        if (status === "error") activity.failed += 1;
        if (status === "running" || status === undefined) activity.running = true;
        if (call.toolName === "write" || call.toolName === "edit") {
          const path = (call.input as Record<string, unknown> | null)?.["path"];
          if (typeof path === "string" && status !== "error" && !activity.files.includes(path)) activity.files.push(path);
        }
      }
      // 只有 update_plan 的章（纯记账）不挂；没有干活调用的旁白章按第一步的时刻归属
      if (work.length === 0 && chapter.calls.length > 0) return;
      const first = chapter.steps[0];
      const t = first === undefined ? 0 : first.kind === "toolGroup" ? (first.calls[0]?.timestamp ?? 0) : first.timestamp;
      chapterBucket ??= bucketAt(timeline, t);
      of(chapterBucket).chapters.push({
        chapter,
        turnKey: turn.key,
        processKey: turn.processKeys[0],
        live: turn.live && index === turn.chapters.length - 1,
      });
    });
  }
  return out;
}

/** 一个过程块里发生的计划改动（对话里「计划改了：…」那一行的素材）；没有改动 = null */
export interface PlanNotice {
  changes: PlanChange[];
  /** 最后一条带理由的版本的 why；都没写 = null */
  why: string | null;
}

/**
 * 这个过程块里的 update_plan 调用（toolCallId）造成的改动，合成一条。每个过程块最多一条：
 * 只打勾的版本没有 changes，不出；同一块里改了好几次，changes 合并，理由取最后一个写了的。
 */
export function planNoticeOf(timeline: PlanTimeline | null, toolCallIds: readonly string[]): PlanNotice | null {
  if (timeline === null || toolCallIds.length === 0) return null;
  const wanted = new Set(toolCallIds);
  const changes: PlanChange[] = [];
  let why: string | null = null;
  for (const version of timeline.versions) {
    if (!wanted.has(version.toolCallId) || version.changes.length === 0) continue;
    changes.push(...version.changes);
    if (version.why !== null) why = version.why;
  }
  return changes.length === 0 ? null : { changes, why };
}
