/**
 * 插件页的纯函数：分组、筛选、「里面有什么」一行小字、来源、开关落点、范围编辑的状态机。
 * 单独成文件只为可测——`node --test` 只加载 .ts，这些判定写在 .tsx 里就没法直接跑。
 */
import type { PluginPlacement, PluginScope, PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";

export type PluginGroup =
  | { kind: "global"; items: PluginView[] }
  | { kind: "workspace"; workspace: Workspace; items: PluginView[] }
  | { kind: "none"; items: PluginView[] };

/**
 * 按「装在哪」分组：所有工作区 → 各工作区（按侧栏顺序）→ 未启用。
 * **一行落在它位置所在的每一组**（装在两个工作区的出现两次，设计稿第 2 屏的约定）；
 * 停用的行仍落在它记着的位置里（placement，开关一拨就回原位），没有位置的（旧技能全没链）
 * 落「未启用」。组内按显示名排，同名再按 id，保证顺序稳定。空组不出现。
 */
export function groupPlugins(views: readonly PluginView[], workspaces: readonly Workspace[]): PluginGroup[] {
  const sorted = [...views].sort(compareViews);
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const global = sorted.filter((view) => view.placement?.kind === "global");
  const none = sorted.filter(
    (view) =>
      view.placement === null ||
      (view.placement.kind === "workspaces" && !view.placement.ids.some((id) => known.has(id))),
  );
  const groups: PluginGroup[] = [];
  if (global.length > 0) groups.push({ kind: "global", items: global });
  for (const workspace of workspaces) {
    const items = sorted.filter((view) => view.placement?.kind === "workspaces" && view.placement.ids.includes(workspace.id));
    if (items.length > 0) groups.push({ kind: "workspace", workspace, items });
  }
  if (none.length > 0) groups.push({ kind: "none", items: none });
  return groups;
}

function compareViews(a: PluginView, b: PluginView): number {
  const byName = a.name.localeCompare(b.name);
  return byName !== 0 ? byName : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 筛选：名字、描述、里面的技能名与服务名任一包含查询词（不分大小写）。空词不筛。 */
export function filterPlugins(views: readonly PluginView[], query: string): PluginView[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...views];
  return views.filter((view) =>
    [view.name, view.description, ...view.skills.map((skill) => skill.name), ...view.mcp.map((server) => server.name)].some(
      (text) => text.toLowerCase().includes(needle),
    ),
  );
}

/** 「仅显示已启用」：开着只留此刻生效的；关着原样（拷一份，调用方可以放心排序）。 */
export function filterEnabled(views: readonly PluginView[], onlyEnabled: boolean): PluginView[] {
  return onlyEnabled ? views.filter(isActive) : [...views];
}

/** 此刻对哪些会话生效：不是停用，且「只在这些」的名单非空。 */
export function isActive(view: PluginView): boolean {
  return view.scope.kind === "global" || (view.scope.kind === "workspaces" && view.scope.ids.length > 0);
}

/**
 * 行尾开关拨一下的落点：生效的 → 停用；没生效的 → 回到记着的位置，没有位置（或位置是空名单）
 * 回「所有工作区」——一个开关拨开后必须真的生效，不能拨开了却落在「未启用」。
 */
export function toggleTarget(view: PluginView): PluginScope {
  if (isActive(view)) return { kind: "off" };
  const placement: PluginPlacement | null = view.placement;
  if (placement === null) return { kind: "global" };
  if (placement.kind === "workspaces" && placement.ids.length === 0) return { kind: "global" };
  return placement;
}

/** 「里面有什么」那行小字的各段（技能 N · MCP · 脚本）；什么都没有给空数组，由调用方说「没有可加载的内容」。 */
export function contentsParts(contents: PluginView["contents"]): { kind: "skills" | "mcp" | "scripts"; count: number }[] {
  const parts: { kind: "skills" | "mcp" | "scripts"; count: number }[] = [];
  if (contents.skills > 0) parts.push({ kind: "skills", count: contents.skills });
  if (contents.mcp > 0) parts.push({ kind: "mcp", count: contents.mcp });
  if (contents.scripts) parts.push({ kind: "scripts", count: 1 });
  return parts;
}

/** 来源标签的键（文案在 messages）。真插件看装法，旧的看出身。 */
export function sourceKey(view: PluginView): "userSkill" | "userMcp" | "builtin" | "copy" | "link" | "git" {
  if (view.origin === "user-skill") return "userSkill";
  if (view.origin === "user-mcp") return "userMcp";
  const kind = view.install?.source.kind;
  return kind === "link" ? "link" : kind === "git" ? "git" : kind === "builtin" ? "builtin" : "copy";
}

/** 旧 MCP 的「移除」按钮能不能出：插件页的 user-mcp 全部来自全局 mcp.json（工作区自带
 *  的 `.mcp.json` 不进这张表），而 `mcp.remove` 恰好也只删全局文件——所以逐条都显示。 */
export function canRemoveMcpView(view: Pick<PluginView, "origin">): boolean {
  return view.origin === "user-mcp";
}

/** 列表行右侧小字标的种类：插件 / 内置 / 技能 / MCP（面板叫「能力」，每一项仍按它自己的种类叫）。 */
export type RowKind = "plugin" | "builtin" | "skill" | "mcp";

export function rowKind(view: Pick<PluginView, "origin" | "install">): RowKind {
  if (view.origin === "user-skill") return "skill";
  if (view.origin === "user-mcp") return "mcp";
  return view.install?.source.kind === "builtin" ? "builtin" : "plugin";
}

/** 断链的旧技能：链接还在、真身目录没了。它只能被清理，不能开关、不能点名（选取态也不列）。 */
export function isMissingSkillView(view: Pick<PluginView, "origin" | "problems">): boolean {
  return view.origin === "user-skill" && view.problems.some((problem) => problem.kind === "skill-folder-missing");
}

/** 「在哪儿可用」里的一枚小标：全局，或某个工作区。 */
export type AvailabilityChip = { kind: "global" } | { kind: "workspace"; id: string };

/**
 * 旧技能 / 旧 MCP 详情里「在哪儿可用」当前显示的范围。MCP 停用时 scope 是 off，
 * 但它记着停用前的位置（placement）——小标要照位置画，不能因为停用了就全灭。
 */
export function availabilityScopeOf(view: Pick<PluginView, "origin" | "scope" | "placement">): PluginScope {
  return view.origin === "user-mcp" ? (view.placement ?? { kind: "off" }) : view.scope;
}

/**
 * 点一枚小标后的新范围（原来的 link / unlink 小标的语义）：
 * - 点「全局」：已是全局 → 停用（全取消）；否则 → 全局（原来的工作区链接由主进程互斥移出）；
 * - 点工作区：全局时点它 → 只在这一个；名单里时点它 = 加入 / 取消。
 * `keepOne`：MCP 的开关是单独的「启用」，名单点空会被当成停用，所以不许点空——返回 null（不改）。
 */
export function nextAvailability(scope: PluginScope, chip: AvailabilityChip, keepOne: boolean): PluginScope | null {
  const next: PluginScope =
    chip.kind === "global"
      ? scope.kind === "global"
        ? { kind: "off" }
        : { kind: "global" }
      : scope.kind === "global"
        ? { kind: "workspaces", ids: [chip.id] }
        : toggleWorkspaceInScope(scope, chip.id);
  return keepOne && next.kind === "off" ? null : next;
}

/** 随 Orbita 带的内置插件：可停用，不可卸载。 */
export function isBuiltinView(view: PluginView): boolean {
  return view.install?.source.kind === "builtin";
}

/** 「和智能体一起做一个」靠内置的 plugin-creator 技能：它被停用了就点不得（点了也点名不到）。 */
export const PLUGIN_CREATOR_ID = "plugin:plugin-creator";

export function creatorAvailable(views: readonly PluginView[]): boolean {
  const creator = views.find((view) => view.id === PLUGIN_CREATOR_ID);
  // 没列到（还在加载 / 开发环境没带资源）不拦：按钮照开，点名不到时指令块如实写「没找到」
  return creator === undefined || isActive(creator);
}

/** 页首提示里的数：旧技能与旧 MCP 各几个（为 0 的整条提示不出现）。 */
export function legacyCounts(views: readonly PluginView[]): { skills: number; mcp: number } {
  return {
    skills: views.filter((view) => view.origin === "user-skill").length,
    mcp: views.filter((view) => view.origin === "user-mcp").length,
  };
}

/** 详情里「装在哪」三选一的当前项：生效范围的种类，停用就是 off。 */
export type ScopeMode = "global" | "workspaces" | "off";

export function scopeModeOf(scope: PluginScope): ScopeMode {
  return scope.kind;
}

/**
 * 在「装在哪」里勾选 / 取消一个工作区后的新范围。勾到第一个时进入 workspaces；
 * 取消最后一个时落到 off（不留名单为空却显示启用的状态）。纯函数，不改入参。
 */
export function toggleWorkspaceInScope(scope: PluginScope, workspaceId: string): PluginScope {
  const current = scope.kind === "workspaces" ? scope.ids : [];
  const next = current.includes(workspaceId) ? current.filter((id) => id !== workspaceId) : [...current, workspaceId];
  return next.length === 0 ? { kind: "off" } : { kind: "workspaces", ids: next };
}

/** 工作区 id → 名字（侧栏里删掉的工作区翻不到时原样显示 id，不让它凭空消失）。 */
export function workspaceName(workspaces: readonly Workspace[], id: string): string {
  return workspaces.find((workspace) => workspace.id === id)?.name ?? id;
}

/** 已装的真插件名（plugin:<name> 的 name）。不含旧技能 / 旧 MCP——它们没有「装上」这回事。 */
export function installedNamesOf(views: ReadonlyArray<{ id: string; origin: string; install: unknown }>): ReadonlySet<string> {
  const found = new Set<string>();
  for (const view of views) {
    if (view.origin === "plugin" && view.install !== null && view.id.startsWith("plugin:")) found.add(view.id.slice("plugin:".length));
  }
  return found;
}

/** 归档记录里的范围说成一句：全局 / 工作区名（已不存在的工作区不列）；都没有就空。 */
export function archivedScopeText(entry: { global: boolean; workspaces: readonly string[] }, global: string, nameOf: (id: string) => string | null): string {
  if (entry.global) return global;
  return entry.workspaces.flatMap((id) => nameOf(id) ?? []).join("、");
}
