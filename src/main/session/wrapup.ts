/**
 * 收尾的主进程算账 —— **纯模块**（不 import electron），可被 `node --test` 直接测。
 *
 * - wrapupPlanOf：会话生效视图 → 这次要扫的轮次（上次确认之后的那些）与每轮按
 *   「服务商 × 型号 × 档」的用量、折算官方价。档的口径与任务账本同一份（task-cost 的
 *   taskRecordsOf：盖章优先，旧记录按 pi 时间线补，补不了记 null）。
 * - wrapupOf：确认的清单 → 落进 meta 的 SessionWrapup（每件做完的事的记账快照）。
 *
 * 轮次切分在 shared/wrapup-scan.ts（splitTurns）：扫描 prompt、renderer 的卡片与这里同一个口径。
 */
import { randomUUID } from "node:crypto";
import type { ModelCostDecl } from "../../shared/provider.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { SessionWrapup, WrapupConfirmInput, WrapupPlan, WrapupTurnUsage } from "../../shared/wrapup.ts";
import { compactionPoints, splitTurns, wrapupItemTotals } from "../../shared/wrapup-scan.ts";
import { taskCost, taskRecordsOf, type LevelChange, type TaskRecord, type TokenCounts } from "../usage/task-cost.ts";

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function add(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** 上次确认到第几轮（没确认过 0） */
export function confirmedThrough(meta: Pick<SessionMeta, "wrapups">): number {
  return (meta.wrapups ?? []).reduce((max, wrapup) => Math.max(max, wrapup.throughTurn), 0);
}

/**
 * 这次收尾的计划。没有新轮次（上次确认之后没再说过话）返回 null。
 * rates：（型号，服务商）→ 官方单价，与侧栏用量格 / 价格图同一个口径（model-groups）。
 */
export function wrapupPlanOf(input: {
  records: readonly SessionRecord[];
  meta: Pick<SessionMeta, "wrapups" | "thinkingLevel">;
  timeline: readonly LevelChange[];
  rates: (modelId: string, providerId: string) => ModelCostDecl | null;
}): WrapupPlan | null {
  const turns = splitTurns(input.records);
  const lastTurn = turns.length;
  const sinceTurn = confirmedThrough(input.meta) + 1;
  if (sinceTurn > lastTurn) return null;
  const byId = new Map<string, TaskRecord>();
  for (const item of taskRecordsOf(input.records, input.timeline, input.meta.thinkingLevel)) byId.set(item.id, item);
  return {
    sinceTurn,
    lastTurn,
    compactions: compactionPoints(input.records).filter((point) => point.afterTurn >= sinceTurn),
    turns: turns
      .filter((turn) => turn.n >= sinceTurn)
      .map((turn) => {
        const groups = new Map<string, { providerId: string; modelId: string; level: ThinkingLevel | null; tokens: TokenCounts; recordedCost: number; unpricedTokens: TokenCounts }>();
        // 同一条消息 id 只计一次（流式重放 / 分支复制的重复行）
        const seen = new Set<string>();
        for (const record of input.records.slice(turn.start, turn.end)) {
          const item = byId.get(record.id);
          if (item === undefined || seen.has(item.id)) continue;
          seen.add(item.id);
          const level = item.level ?? null;
          const key = `${item.providerId}\u0000${item.modelId}\u0000${level ?? ""}`;
          const group = groups.get(key) ?? {
            providerId: item.providerId,
            modelId: item.modelId,
            level,
            tokens: ZERO,
            recordedCost: 0,
            unpricedTokens: ZERO,
          };
          const priced = Number.isFinite(item.cost) && item.cost > 0;
          group.tokens = add(group.tokens, item.tokens);
          if (priced) group.recordedCost += item.cost;
          else group.unpricedTokens = add(group.unpricedTokens, item.tokens);
          groups.set(key, group);
        }
        const usage: WrapupTurnUsage[] = [...groups.values()].map((group) => ({
          ...group,
          officialCost: taskCost(
            { tokens: group.tokens, recordedCost: group.recordedCost, unpricedTokens: group.unpricedTokens },
            input.rates(group.modelId, group.providerId),
          ),
        }));
        return { n: turn.n, userId: turn.userId, preview: turn.preview, usage };
      }),
  };
}

/**
 * 确认的清单 → 一次收尾记录。每件做完的事的账按它的轮次从 plan 里现算（与卡片上显示的同一个函数，
 * 显示与落账不会对不上）；轮次越出本次计划的部分不计。
 */
export function wrapupOf(plan: WrapupPlan, input: WrapupConfirmInput, now: number): SessionWrapup {
  return {
    id: randomUUID(),
    at: now,
    throughTurn: Math.min(Math.max(input.throughTurn, plan.sinceTurn - 1), plan.lastTurn),
    items: input.done
      .filter((entry) => entry.title.trim() !== "")
      .map((entry) => {
        const totals = wrapupItemTotals(plan.turns, entry.turns);
        return {
          title: entry.title.trim(),
          turns: entry.turns,
          providerId: totals.providerId,
          modelId: totals.modelId,
          level: totals.level,
          tokens: totals.tokens,
          recordedCost: totals.recordedCost,
          unpricedTokens: totals.unpricedTokens,
        };
      }),
  };
}
