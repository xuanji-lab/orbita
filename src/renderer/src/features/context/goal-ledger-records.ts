/**
 * 转录记录 → 目标与计划改动账的事件（shared/goal-ledger.ts 的输入）。账不另存，每次从转录推；
 * 界面一侧的适配器只有这一处（agent 进程那边读 pi 本子，见 src/agent/goal-compaction.ts）。
 *
 * 纯模块：可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import { GOAL_TOOL_NAME } from "../../../../shared/goal.ts";
import type { LedgerEvent } from "../../../../shared/goal-ledger.ts";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";

/** 账本要读的记录：用户消息（来源）与 update_goal / update_plan 的调用 */
export function isLedgerRecord(record: TranscriptRecord): boolean {
  return record.role === "user" || (record.role === "tool" && (record.toolName === GOAL_TOOL_NAME || record.toolName === PLAN_TOOL_NAME));
}

/** 转录记录 → 账本事件（其余记录忽略）。用户消息只取文字块 */
export function ledgerEventsOf(records: readonly TranscriptRecord[]): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const record of records) {
    if (record.role === "user") {
      const text = record.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      events.push({ kind: "user", id: record.id, at: record.timestamp, text });
    } else if (record.role === "tool" && (record.toolName === GOAL_TOOL_NAME || record.toolName === PLAN_TOOL_NAME)) {
      events.push({
        kind: "call",
        id: record.toolCallId,
        at: record.timestamp,
        tool: record.toolName,
        input: record.input,
        failed: record.status === "error",
      });
    }
  }
  return events;
}

/** 签名：记录 id + 工具状态。同签名 = 账不会变 */
export function ledgerSignature(records: readonly TranscriptRecord[]): string {
  return records.map((record) => (record.role === "tool" ? `${record.id}:${record.status}` : record.id)).join("|");
}

