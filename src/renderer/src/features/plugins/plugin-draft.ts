/**
 * 草稿预览（agent 的 `preview_plugin` 扫过一个还没安装的插件文件夹）在 renderer 里的状态规则。
 * 纯函数，单独成文件只为可测。
 *
 * 草稿按**会话**记：同一时刻几条会话各在做各的插件，互不串。离开草稿视图（点返回）只清当前会话的那一条；
 * agent 再次 preview 同一个文件夹会重新进入（那是 agent 明确要给用户看）。
 * 这份记忆只用来「agent 预览时自动切右栏」，**不是**草稿的真源：草稿在磁盘上，插件页的「正在做」组
 * （主进程 `plugin:drafts` 扫出来）才是用户回来找它的入口——返回、重开应用都不会让它消失。
 */
import type { PluginDraftEntry } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";

export type PluginDrafts = ReadonlyMap<string, string>;

/** 右栏「正在做」长页要看的那个草稿：文件夹路径 + 它所在的工作区（路径必须落在该工作区根内，主进程校验） */
export interface PluginDraftTarget {
  path: string;
  workspaceId: string | null;
}

export function putDraft(drafts: PluginDrafts, sessionId: string, path: string): PluginDrafts {
  if (drafts.get(sessionId) === path) return drafts;
  return new Map(drafts).set(sessionId, path);
}

export function dropDraft(drafts: PluginDrafts, sessionId: string): PluginDrafts {
  if (!drafts.has(sessionId)) return drafts;
  const next = new Map(drafts);
  next.delete(sessionId);
  return next;
}

/** 这条会话此刻有没有要看的草稿；没打开会话（首页）没有。 */
export function draftOf(drafts: PluginDrafts, sessionId: string | null): string | null {
  return sessionId === null ? null : (drafts.get(sessionId) ?? null);
}

/**
 * 收到 `pluginDraft` 事件：要不要把右栏切到插件页的「正在做」视图。
 * 只在**正看着该会话**时切——别的会话的草稿只记下来，等用户切过去、打开插件页再看。
 */
export function shouldOpenDraft(args: { eventSessionId: string; viewedSessionId: string | null }): boolean {
  return args.viewedSessionId !== null && args.eventSessionId === args.viewedSessionId;
}

/** 「正在做」组里的一个工作区：当前工作区在前，其余按侧栏顺序；组内最近改动的在前。空组不出现。 */
export interface DraftGroup {
  workspace: Workspace;
  items: PluginDraftEntry[];
}

export function groupDrafts(entries: readonly PluginDraftEntry[], workspaces: readonly Workspace[], currentWorkspaceId: string | null): DraftGroup[] {
  const ordered = [...workspaces].sort((a, b) => Number(b.id === currentWorkspaceId) - Number(a.id === currentWorkspaceId));
  const groups: DraftGroup[] = [];
  for (const workspace of ordered) {
    const items = entries.filter((entry) => entry.workspaceId === workspace.id).sort((a, b) => b.updatedAt - a.updatedAt);
    if (items.length > 0) groups.push({ workspace, items });
  }
  return groups;
}

/** 筛选：显示名、名字、描述任一包含查询词（不分大小写）。空词不筛。 */
export function filterDrafts(entries: readonly PluginDraftEntry[], query: string): PluginDraftEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  return entries.filter((entry) => [entry.displayName, entry.name, entry.description].some((text) => text.toLowerCase().includes(needle)));
}

/**
 * 「正在做」那份草稿的文件夹已经不在了（被删 / 挪走）：主进程 locateDraft 回 `not-found` 只有这一种含义
 * （文件夹不存在或不是目录；「还没有清单」不算——那时扫描照常给 ready 的虚线占位）。
 * 这时不该停在一页红字上：自动退回能力列表，列表顶上说一句为什么（2026-11-07 用户要修）。
 * 「不在当前工作区」（outside-workspace）不退：那是工作区配置的问题，红字说明比静默回列表更有用。
 */
export function draftFolderGone(scan: { kind: string; reason?: string }): boolean {
  return scan.kind === "unavailable" && scan.reason === "not-found";
}
