/**
 * 上下文页签的取数 hook —— 面板组件只调它，拿到 ContextInventory 与加载态。
 *
 * - 「本轮」：直接从会话槽的生效视图推导，不取数；
 * - 「整个任务」：尾窗之外还有记录时拉全量——拉取循环与缓存在 useTaskRecords（进度页签的
 *   「做过的」共用同一份，谁先拉另一个直接用）。
 *
 * 组件不管 IPC、不管缓存——它只出 `useContextInventory(sessionId, entry, cwd, scope)`。
 */
import { useMemo } from "react";
import { buildContextInventory, type ContextInventory, type ContextScope } from "@shared/context-inventory";
import type { SessionEntry } from "./session-states.ts";
import { useTaskRecords } from "./useTaskRecords.ts";

export interface ContextInventoryView {
  inventory: ContextInventory;
  /** 「整个任务」还在拉更早的记录（本轮视野恒 false） */
  loading: boolean;
  /** 已额外取回的更早记录条数（进度提示；未取数 = 0） */
  fetched: number;
  /** 撞页数上限：「整个任务」视图不完整，界面要如实标注 */
  capped: boolean;
  error: string | null;
}

export function useContextInventory(
  sessionId: string,
  entry: SessionEntry,
  cwd: string,
  scope: ContextScope,
): ContextInventoryView {
  const view = useTaskRecords(sessionId, entry, scope === "task");
  const inventory = useMemo(
    () => buildContextInventory({ records: view.records, cwd, scope, rules: entry.rules }),
    [view.records, cwd, scope, entry.rules],
  );
  return { inventory, loading: view.loading, fetched: view.fetched, capped: view.capped, error: view.error };
}
