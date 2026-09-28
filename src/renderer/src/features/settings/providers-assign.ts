/**
 * 「给导入的会话分配模型」的纯逻辑层（ProvidersView 的_assign 部分）。
 * 不碰 React、不碰 IPC，`node --test` 直接测（providers-assign.test.ts）。
 * 匹配与分组的真源在 `@shared/model-assign`；这里只把分组 × 服务商清单折成
 * 预览行与执行清单，以及提示行的三态（该出手 / 只剩对不上的 / 没事可做）。
 */
import { matchModelByName } from "../../../../shared/model-assign.ts";
import type { ModelAssignEntry, ModelAssignGroups, RegisteredModel } from "@shared/model-assign";
import type { ProviderDto } from "@shared/provider";
import { hasCredentials } from "./providers-view-model.ts";

/**
 * 匹配的候选全集：**能用的**服务商（填了 key 且声明过模型——与模型菜单同一把尺，
 * model-menu.tsx 的 usableProviders；选一个发不出请求的组合没有意义）按
 * providers.json 顺序展开。顺序就是用户排的顺序，多渠道同名取第一个靠它。
 */
export function registeredModelsOf(providers: readonly ProviderDto[]): RegisteredModel[] {
  return providers.flatMap((provider) =>
    hasCredentials(provider.auth)
      ? provider.models.declared.map((model) => ({ providerId: provider.id, modelId: model.id }))
      : [],
  );
}

/** 预览里的一行：原模型名 × 会话数 × 建议去向（null = 对不上，保持不变）。 */
export interface AssignPreviewRow {
  model: string;
  sessions: number;
  target: { providerId: string; modelId: string; ambiguous: boolean } | null;
}

export interface AssignPreview {
  rows: AssignPreviewRow[];
  /** 能配上模型的会话数（各行 sessions 之和，只算有 target 的行）——确认按钮上的数 */
  assignable: number;
  /** 对不上的会话数（含原模型名不可知的那些，预览里不单列） */
  unmatched: number;
}

/** 分组 × 已注册模型 → 预览行（顺序沿用分组的：会话数降序、同名次字典序）。 */
export function assignPreview(groups: ModelAssignGroups, providers: readonly ProviderDto[]): AssignPreview {
  const registered = registeredModelsOf(providers);
  const rows = groups.groups.map((group) => ({
    model: group.model,
    sessions: group.sessions,
    target: matchModelByName(group.model, registered),
  }));
  const assignable = rows.reduce((sum, row) => sum + (row.target === null ? 0 : row.sessions), 0);
  const unmatched = groups.total - assignable;
  return { rows, assignable, unmatched };
}

/** 执行清单：预览里有去向的行原样转成 ModelAssignEntry（对不上的不进清单）。 */
export function assignEntries(preview: AssignPreview): ModelAssignEntry[] {
  return preview.rows.flatMap((row) =>
    row.target === null ? [] : [{ model: row.model, providerId: row.target.providerId, modelId: row.target.modelId }],
  );
}

/** 提示行的三态（wafo 2026-09-28：没有导入记录的用户永远不该看到这块）。 */
export type AssignHint =
  | { kind: "none" }
  /** 有可配的：出手（提示 + 按钮） */
  | { kind: "offer"; total: number; assignable: number }
  /** 全剩对不上的：说清去路，不给按钮 */
  | { kind: "leftover"; unmatched: number };

/** total > 0 且至少有一个能用的服务商才有提示；按钮再要求 assignable > 0。 */
export function assignHint(groups: ModelAssignGroups | null, providers: readonly ProviderDto[]): AssignHint {
  if (groups === null || groups.total === 0 || registeredModelsOf(providers).length === 0) return { kind: "none" };
  const { assignable, unmatched } = assignPreview(groups, providers);
  return assignable > 0 ? { kind: "offer", total: groups.total, assignable } : { kind: "leftover", unmatched };
}
