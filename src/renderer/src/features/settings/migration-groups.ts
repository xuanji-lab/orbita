/**
 * Migration 页 Sessions 段的纯函数层：把扫描报告按源侧文件夹分组、套筛选、算去向选项
 * 与底栏汇总。不碰 React、不碰 IPC，`node --test` 直接测（migration-groups.test.ts）。
 *
 * 选择的单位与主进程同一条规则（isSelectablePlanItem）：页面列出、能勾的只有可选条目；
 * 母会话在计划里的子会话不单列，计进母会话那一行的子会话数，导入时跟着母会话走。
 *
 * 再次导入（ImportChange）：new / deleted 是「搬一条会话进来」，按文件夹分组、跟组的去向；
 * updated / diverged 是已导入会话在 Proma 里有了新消息，单独成一块（changed）——追加的留在
 * 原会话里、另导的放在原会话旁边，都没有去向可选。
 */
import type {
  ImportDestination,
  ImportDestinationChoice,
  ImportPlanItem,
  ImportScanReport,
  ImportSourceId,
} from "@shared/import";
import type { Workspace } from "@shared/workspace";
import { isSelectablePlanItem } from "../../../../shared/import.ts";

export type RangeFilter = "all" | "7d" | "30d" | "90d";

export interface SessionFilters {
  range: RangeFilter;
  includeArchived: boolean;
}

/** 默认全部：不限时间、含归档（wafo 2026-09-24 裁决，筛选按钮保留） */
export const DEFAULT_FILTERS: SessionFilters = { range: "all", includeArchived: true };

const DAY = 24 * 60 * 60 * 1000;
const RANGE_MS: Record<Exclude<RangeFilter, "all">, number> = { "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY };

export const RANGE_LABEL: Record<RangeFilter, string> = {
  all: "All time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export const SOURCE_LABEL: Record<ImportSourceId, string> = {
  proma: "Proma",
  "claude-code": "Claude Code",
  "agent-skills": "Shared agent skills",
};

export interface SessionRow {
  item: ImportPlanItem;
  /** 跟着它一起导入的子会话数（母会话在计划里的那些） */
  subSessions: number;
  /** 它与子会话合计要复制的字节数 */
  bytes: number;
}

export interface SessionGroup {
  /** 分组键 = ImportPlanItem.folder；null = 没有文件夹 */
  folder: string | null;
  /** 过滤后的可选条目，最近更新的在前 */
  rows: SessionRow[];
  /** 组内按来源计数（过滤后） */
  bySource: Partial<Record<ImportSourceId, number>>;
  /** 扫描给的默认去向 */
  defaultDestination: ImportDestination;
}

export interface GroupedSessions {
  groups: SessionGroup[];
  /** 已导入、Proma 里有新消息的（updated 在前、diverged 在后，各自最近更新的在前；过滤后） */
  changed: SessionRow[];
  /** 被筛选藏起来的可选条目数（它们不导入） */
  hidden: number;
  /** 全部可选条目数（不看筛选） */
  total: number;
}

function passes(item: ImportPlanItem, filters: SessionFilters, now: number): boolean {
  if (!filters.includeArchived && item.archived) return false;
  if (filters.range === "all") return true;
  return now - item.updatedAt <= RANGE_MS[filters.range];
}

/** 一条可选条目在报告里的默认去向（按它落进去的工作区反推）。 */
export function defaultDestinationOf(item: ImportPlanItem, report: ImportScanReport): ImportDestination {
  if (item.workspaceId === null) return { kind: "tasks" };
  if (report.newWorkspaces.some((workspace) => workspace.id === item.workspaceId)) return { kind: "new-workspace" };
  return { kind: "workspace", workspaceId: item.workspaceId };
}

/**
 * 分组：有文件夹的组按条数多→少，没有文件夹的那一组放最后（它是「其余」，不是一个项目）。
 * 组内最近更新的在前。筛不出任何行的组不出现。
 */
export function groupSessions(report: ImportScanReport, filters: SessionFilters, now: number): GroupedSessions {
  const planIds = new Set(report.plan.map((item) => item.sessionId));
  const children = new Map<string, { count: number; bytes: number }>();
  for (const item of report.plan) {
    if (isSelectablePlanItem(item, planIds) || item.parentId === null) continue;
    const entry = children.get(item.parentId) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += item.bytes;
    children.set(item.parentId, entry);
  }

  const byFolder = new Map<string | null, SessionGroup>();
  const changed: SessionRow[] = [];
  let total = 0;
  let hidden = 0;
  for (const item of report.plan) {
    if (!isSelectablePlanItem(item, planIds)) continue;
    total += 1;
    if (!passes(item, filters, now)) {
      hidden += 1;
      continue;
    }
    const kids = children.get(item.sessionId);
    if (item.change === "updated" || item.change === "diverged") {
      changed.push({ item, subSessions: kids?.count ?? 0, bytes: item.bytes + (kids?.bytes ?? 0) });
      continue;
    }
    let group = byFolder.get(item.folder);
    if (group === undefined) {
      group = { folder: item.folder, rows: [], bySource: {}, defaultDestination: defaultDestinationOf(item, report) };
      byFolder.set(item.folder, group);
    }
    group.rows.push({ item, subSessions: kids?.count ?? 0, bytes: item.bytes + (kids?.bytes ?? 0) });
    group.bySource[item.source] = (group.bySource[item.source] ?? 0) + 1;
  }

  const groups = [...byFolder.values()];
  for (const group of groups) group.rows.sort((a, b) => b.item.updatedAt - a.item.updatedAt);
  changed.sort(
    (a, b) =>
      Number(a.item.change === "diverged") - Number(b.item.change === "diverged") || b.item.updatedAt - a.item.updatedAt,
  );
  groups.sort((a, b) => {
    if (a.folder === null) return 1;
    if (b.folder === null) return -1;
    return b.rows.length - a.rows.length || a.folder.localeCompare(b.folder);
  });
  return { groups, changed, hidden, total };
}

/** 页面上列出的全部行：changed 块在前，其后各文件夹组。 */
export function allRows(grouped: GroupedSessions): SessionRow[] {
  return [...grouped.changed, ...grouped.groups.flatMap((group) => group.rows)];
}

/**
 * 扫描后的默认勾选：没导过的与 Proma 有新消息的（updated）。两边都聊过的（diverged）与
 * 在 orbita 删过的（deleted）默认不勾——前者勾上会多出一条会话，后者是用户自己删的
 * （wafo 2026-09-24 裁决）。
 */
export function defaultSelection(report: ImportScanReport): Set<string> {
  const planIds = new Set(report.plan.map((item) => item.sessionId));
  return new Set(
    report.plan
      .filter(
        (item) => isSelectablePlanItem(item, planIds) && (item.change === "new" || item.change === "updated"),
      )
      .map((item) => item.sourceFile),
  );
}

export function sameDestination(a: ImportDestination, b: ImportDestination): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "workspace" || (b.kind === "workspace" && a.workspaceId === b.workspaceId);
}

/** 组的当前去向：用户改过就用改过的，否则默认。 */
export function effectiveDestination(
  group: SessionGroup,
  overrides: ReadonlyMap<string | null, ImportDestination>,
): ImportDestination {
  return overrides.get(group.folder) ?? group.defaultDestination;
}

/** 文件夹末段；没有文件夹的组叫 No folder。 */
export function groupName(folder: string | null): string {
  if (folder === null) return "No folder";
  const parts = folder.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? folder;
}

/** 去向在菜单与芯片上的说法。找不到的工作区（刚被删）如实说 missing，不猜。 */
export function destinationLabel(destination: ImportDestination, workspaces: readonly Workspace[]): string {
  if (destination.kind === "tasks") return "Into Tasks";
  if (destination.kind === "new-workspace") return "New workspace";
  const workspace = workspaces.find((candidate) => candidate.id === destination.workspaceId);
  return workspace === undefined ? "Missing workspace" : `Into ${workspace.name}`;
}

export interface DestinationOption {
  destination: ImportDestination;
  label: string;
  hint?: string;
}

/**
 * 一组可选的去向：默认去向在最前，其后 Tasks，再其后其余既有工作区。
 * 「新建工作区」只在默认就是新建时出现——没有文件夹的组建不了，已是工作区的文件夹
 * 再建一个会撞同一路径（主进程也会拒绝）。
 */
export function destinationOptions(group: SessionGroup, workspaces: readonly Workspace[]): DestinationOption[] {
  const options: DestinationOption[] = [];
  const first = group.defaultDestination;
  if (first.kind === "new-workspace") {
    options.push({ destination: first, label: "New workspace", hint: groupName(group.folder) });
  } else if (first.kind === "workspace") {
    options.push({ destination: first, label: destinationLabel(first, workspaces), hint: "Same folder" });
  }
  options.push({ destination: { kind: "tasks" }, label: "Into Tasks", hint: "No workspace" });
  for (const workspace of workspaces) {
    if (first.kind === "workspace" && first.workspaceId === workspace.id) continue;
    options.push({ destination: { kind: "workspace", workspaceId: workspace.id }, label: `Into ${workspace.name}` });
  }
  return options;
}

export interface ImportSummary {
  /** 勾选且可见、会新落一条会话的可选条目（new / deleted / diverged） */
  sessions: number;
  /** 勾选且可见、追加新消息的既有会话（updated） */
  updates: number;
  /** 跟着它们的子会话 */
  subSessions: number;
  bytes: number;
  /** 去向为新建的组里有勾选的，就要建一个工作区 */
  newWorkspaces: number;
  /** 勾选的会话里原模型没配、会用默认模型打开的条数，与这些原模型 id（去重） */
  fallback: { count: number; models: string[]; fallbackModel: string | null };
}

export function summarize(
  grouped: GroupedSessions,
  selected: ReadonlySet<string>,
  overrides: ReadonlyMap<string | null, ImportDestination>,
): ImportSummary {
  let sessions = 0;
  let updates = 0;
  let subSessions = 0;
  let bytes = 0;
  let newWorkspaces = 0;
  const models = new Set<string>();
  let fallbackCount = 0;
  let fallbackModel: string | null = null;
  const count = (row: SessionRow): boolean => {
    if (!selected.has(row.item.sourceFile)) return false;
    if (row.item.change === "updated") updates += 1;
    else sessions += 1;
    subSessions += row.subSessions;
    bytes += row.bytes;
    if (!row.item.modelMatched) {
      fallbackCount += 1;
      fallbackModel = row.item.modelId;
      if (row.item.importedModel !== null) models.add(row.item.importedModel);
    }
    return true;
  };
  for (const row of grouped.changed) count(row);
  for (const group of grouped.groups) {
    let picked = 0;
    for (const row of group.rows) {
      if (count(row)) picked += 1;
    }
    if (picked > 0 && effectiveDestination(group, overrides).kind === "new-workspace") newWorkspaces += 1;
  }
  return {
    sessions,
    updates,
    subSessions,
    bytes,
    newWorkspaces,
    fallback: { count: fallbackCount, models: [...models], fallbackModel },
  };
}

/** 执行入参里的 sessions：只交勾选**且可见**的——被筛选藏起来的不导（所见即所导）。 */
export function selectedSourceFiles(grouped: GroupedSessions, selected: ReadonlySet<string>): string[] {
  return allRows(grouped)
    .filter((row) => selected.has(row.item.sourceFile))
    .map((row) => row.item.sourceFile);
}

/** 执行入参里的 destinations：只交改过且与默认不同的组。 */
export function destinationChoices(
  grouped: GroupedSessions,
  overrides: ReadonlyMap<string | null, ImportDestination>,
): ImportDestinationChoice[] {
  const choices: ImportDestinationChoice[] = [];
  for (const group of grouped.groups) {
    const chosen = overrides.get(group.folder);
    if (chosen !== undefined && !sameDestination(chosen, group.defaultDestination)) {
      choices.push({ folder: group.folder, destination: chosen });
    }
  }
  return choices;
}

/** 路径里的家目录缩成 ~（机器事实照样 mono 显示，只是短一点）。 */
export function abbreviateHome(path: string, home: string): string {
  if (home === "") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** 字节数 → 人读的体量（导入是 GB 级的事，用户需要知道要复制多少进盘）。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 上次导入的时刻：日期同 formatDay，再带上时:分（同一天可能导好几次）。 */
export function formatMoment(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${formatDay(timestamp, now)} ${time}`;
}

/** 行上的日期：今年的只写月-日，往年的带年份。 */
export function formatDay(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() === new Date(now).getFullYear() ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}
