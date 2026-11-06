/**
 * 以后再做面板的分组（纯函数，Sidebar 与测试共用）：工作区 → 来源会话 → 事项两层。
 */
import type { Carryover, SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { bucketCounts, groupByWorkspace, type WsFilter } from "./workspace-filter.ts";

export interface CarryoverGroup {
  /** null = 来源会话已删（标题换占位，跳转不可用） */
  session: SessionMeta | null;
  items: Carryover[];
}

/**
 * 按来源会话归堆，组序跟会话列表（最近的在前）；来源会话已删的堆到最后。
 * 丢掉的（dismissed）不列——它们只在那条任务的进度面板里能找回。
 */
export function groupCarryovers(carryovers: readonly Carryover[], sessions: readonly SessionMeta[]): CarryoverGroup[] {
  const bySource = new Map<string, Carryover[]>();
  for (const item of carryovers) {
    if (item.status === "dismissed") continue;
    const list = bySource.get(item.sourceSessionId) ?? [];
    list.push(item);
    bySource.set(item.sourceSessionId, list);
  }
  const groups: CarryoverGroup[] = [];
  for (const meta of sessions) {
    const items = bySource.get(meta.id);
    if (items !== undefined) groups.push({ session: meta, items });
  }
  for (const [source, items] of bySource) {
    if (sessions.some((meta) => meta.id === source)) continue;
    groups.push({ session: null, items });
  }
  return groups;
}

export interface CarryoverWorkspaceGroup {
  /** null = 「任务」组：来源会话没有工作区，或来源会话已删、查不到它的工作区 */
  workspace: Workspace | null;
  groups: CarryoverGroup[];
  /** 这一组里列着的事项数 */
  count: number;
}

/**
 * 两层分组：工作区（侧栏顺序）→ 来源会话 → 事项，再接「任务」组。
 * 来源已删的会话查不到工作区，进「任务」组末尾（groupCarryovers 本来就把它们排在最后）。
 * `filter` 选了某个工作区 / 任务就只剩那一组。
 */
export function groupCarryoversByWorkspace(
  carryovers: readonly Carryover[],
  sessions: readonly SessionMeta[],
  workspaces: readonly Workspace[],
  filter: WsFilter,
): CarryoverWorkspaceGroup[] {
  return groupByWorkspace(groupCarryovers(carryovers, sessions), (group) => group.session?.workspaceId ?? null, workspaces, filter).map(
    (bucket) => ({
      workspace: bucket.workspace,
      groups: bucket.items,
      count: bucket.items.reduce((sum, group) => sum + group.items.length, 0),
    }),
  );
}

/** 选择条上各档的条数：列着的事项（不含丢掉的）按来源会话的工作区分桶。 */
export function carryoverCounts(
  carryovers: readonly Carryover[],
  sessions: readonly SessionMeta[],
  workspaces: readonly Workspace[],
): { total: number; perWorkspace: Map<string, number>; tasks: number } {
  const listed = carryovers.filter((item) => item.status !== "dismissed");
  const workspaceOf = new Map(sessions.map((meta) => [meta.id, meta.workspaceId]));
  const counts = bucketCounts(listed, (item) => workspaceOf.get(item.sourceSessionId) ?? null, workspaces);
  return { total: listed.length, ...counts };
}
