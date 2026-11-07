/**
 * 右栏「这条任务 › 进度」的推导（2026-10-30）：计划（update_plan 的最后一次入参）与「做过的」
 * （按轮列，轮下是章节——与对话里过程块展开后的章节同一份推导，turn-process.ts）。
 *
 * 全部从转录推，不另存：回退、分支、重开会话都跟着转录走。
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
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

export type PlanItemStatus = "pending" | "in_progress" | "done";

export interface PlanView {
  items: { text: string; status: PlanItemStatus }[];
  /** 这张计划写下的时刻（update_plan 结果帧的时间戳）：「在做」那步的计时从这里起 */
  at: number;
  done: number;
}

const STATUSES: readonly string[] = ["pending", "in_progress", "done"];

/**
 * 最后一次成功的 update_plan。失败的调用（入参坏了被拒）不算——模型会改了重调；
 * 还在跑的（结果帧没到）也不算，等它落定。入参宽松解析：坏条目跳过，不让一条坏数据
 * 把整张计划弄没（工具端已经校验过一遍，这里只防旧数据 / 手改）。
 */
export function latestPlan(records: readonly TranscriptRecord[]): PlanView | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record === undefined || record.role !== "tool" || record.toolName !== "update_plan") continue;
    if (record.status !== "complete") continue;
    const raw = (record.input as { items?: unknown } | null)?.items;
    if (!Array.isArray(raw)) continue;
    const items = raw.flatMap((item) => {
      const value = (item ?? {}) as Record<string, unknown>;
      const text = typeof value["text"] === "string" ? value["text"].trim() : "";
      const status = value["status"];
      if (text === "" || typeof status !== "string" || !STATUSES.includes(status)) return [];
      return [{ text, status: status as PlanItemStatus }];
    });
    if (items.length === 0) continue;
    return { items, at: record.timestamp, done: items.filter((item) => item.status === "done").length };
  }
  return null;
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
        ask: text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "",
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
    const spans = own.map((unit) => unit.durationMs).filter((ms): ms is number => ms !== null);
    turn.durationMs = spans.length === 0 ? null : spans.reduce((sum, ms) => sum + ms, 0);
  });
  return turns;
}
