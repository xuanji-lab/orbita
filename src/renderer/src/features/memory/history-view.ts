/**
 * 「从历史生成」面板的纯逻辑（可被 `node --test` 直接测）：默认勾选、合计、进度、
 * 哪些状态算任务还在（面板常驻显示进度）。
 */
import type { MemoryHistoryScope, MemoryHistoryStatus } from "../../../../shared/memory.ts";

/** 任务还在（跑着 / 暂停 / 收尾中 / 出错暂停）：面板常驻、不能另起。 */
export function historyActive(status: MemoryHistoryStatus | null): boolean {
  if (status === null) return false;
  return status.state === "running" || status.state === "paused" || status.state === "stopping" || status.state === "failed";
}

/** 默认勾选：正在看的那个范围（token 对上的作用域）；「全部」/ 所有工作区层下不勾。 */
export function defaultHistorySelection(scopes: readonly MemoryHistoryScope[], token: string): string[] {
  const hit = scopes.find((scope) => scope.token === token);
  return hit === undefined ? [] : [hit.scopeId];
}

export interface HistoryTotals {
  sessions: number;
  /** 待处理轮 */
  turns: number;
  /** 已处理（会跳过）的轮 */
  processed: number;
  calls: number;
  /** 选中的范围里还有没统计完的 */
  counting: boolean;
}

export function historyTotals(scopes: readonly MemoryHistoryScope[], selected: ReadonlySet<string>): HistoryTotals {
  const totals: HistoryTotals = { sessions: 0, turns: 0, processed: 0, calls: 0, counting: false };
  for (const scope of scopes) {
    if (!selected.has(scope.scopeId)) continue;
    totals.sessions += scope.sessions;
    if (scope.stats === null) {
      totals.counting = true;
      continue;
    }
    totals.turns += scope.stats.turns;
    totals.processed += scope.stats.processed;
    totals.calls += scope.stats.calls;
  }
  return totals;
}

/** 进度百分比（0..100，整数）；总数还没算出来是 0。 */
export function historyPercent(status: MemoryHistoryStatus): number {
  if (status.totalTurns <= 0) return status.state === "done" ? 100 : 0;
  return Math.min(100, Math.round((status.doneTurns / status.totalTurns) * 100));
}

/** 新一次预估的统计并进旧行：没点名的作用域保留上次算出的数，切换勾选不闪。 */
export function mergeHistoryScopes(
  previous: readonly MemoryHistoryScope[] | null,
  next: readonly MemoryHistoryScope[],
): MemoryHistoryScope[] {
  const known = new Map((previous ?? []).map((scope) => [scope.scopeId, scope.stats]));
  return next.map((scope) => (scope.stats === null ? { ...scope, stats: known.get(scope.scopeId) ?? null } : scope));
}
