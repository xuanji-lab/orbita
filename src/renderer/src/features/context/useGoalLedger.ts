/**
 * 目标与计划的改动账（shared/goal-ledger.ts）在界面一侧的 hook：面板与对话每条流式事件都会换
 * 记录数组的引用，而账只跟「用户消息、update_goal / update_plan 的调用及其状态」有关——
 * 按这几样的签名记忆，流式吐字时不重算。记录 → 事件的适配在 goal-ledger-records.ts（纯函数）。
 */
import { useRef } from "react";
import type { TranscriptRecord } from "@shared/session";
import { buildGoalLedger, type GoalLedger } from "../../../../shared/goal-ledger.ts";
import { isLedgerRecord, ledgerEventsOf, ledgerSignature } from "./goal-ledger-records.ts";

/**
 * 当前这段转录的账。传整段记录即可，函数自己挑出相关的几条。
 * 渲染期写 ref 是幂等的（同签名不重算），不依赖副作用顺序。
 */
export function useGoalLedger(records: readonly TranscriptRecord[]): GoalLedger {
  const relevant = records.filter(isLedgerRecord);
  const key = ledgerSignature(relevant);
  const memo = useRef<{ key: string; ledger: GoalLedger } | null>(null);
  if (memo.current === null || memo.current.key !== key) {
    memo.current = { key, ledger: buildGoalLedger(ledgerEventsOf(relevant)) };
  }
  return memo.current.ledger;
}
