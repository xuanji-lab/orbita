/**
 * Migration 页 Skills 一段的纯逻辑：默认勾选、组的说明、作用域的名字与选项。与 migration-groups.ts
 * 同样不碰 React，`node --test` 直接测。
 */
import type {
  ImportSkillGroup,
  ImportSkillItem,
  ImportSkillScope,
  ImportSkillScopeChoice,
  ImportSourceId,
} from "@shared/import";
import type { Workspace } from "@shared/workspace";
import { SOURCE_LABEL } from "./migration-groups.ts";

/** 能勾的：new 与 built-in。in-orbita / duplicate 列出来但不可勾（主进程也只导前两种）。 */
export function isSelectableSkill(skill: ImportSkillItem): boolean {
  return skill.status === "new" || skill.status === "built-in";
}

/** 默认勾选：new 全勾；built-in（源应用自带的）不勾。 */
export function defaultSkillSelection(groups: readonly ImportSkillGroup[]): Set<string> {
  const selected = new Set<string>();
  for (const group of groups) {
    for (const skill of group.skills) {
      if (skill.status === "new") selected.add(skill.dir);
    }
  }
  return selected;
}

export function selectableSkills(group: ImportSkillGroup): ImportSkillItem[] {
  return group.skills.filter(isSelectableSkill);
}

/** 执行请求用：勾选里仍可选的那些（重扫后状态可能变了，主进程还会再过滤一遍）。 */
export function selectedSkillDirs(groups: readonly ImportSkillGroup[], selected: ReadonlySet<string>): string[] {
  return groups.flatMap((group) => selectableSkills(group).filter((skill) => selected.has(skill.dir)).map((skill) => skill.dir));
}

export function countSelectedSkills(groups: readonly ImportSkillGroup[], selected: ReadonlySet<string>): number {
  return selectedSkillDirs(groups, selected).length;
}

/** 各来源能导的 skill 数（来源行上的计数）。 */
export function skillCountBySource(groups: readonly ImportSkillGroup[]): Partial<Record<ImportSourceId, number>> {
  const counts: Partial<Record<ImportSourceId, number>> = {};
  for (const group of groups) {
    counts[group.source] = (counts[group.source] ?? 0) + selectableSkills(group).length;
  }
  return counts;
}

/** 组名：「Proma · 默认工作区」「Claude Code · synced」；来源只有一个目录时就是来源名。 */
export function skillGroupLabel(group: ImportSkillGroup): string {
  return group.name === null ? SOURCE_LABEL[group.source] : `${SOURCE_LABEL[group.source]} · ${group.name}`;
}

/**
 * 组名后面那行小字：能导几个、其余为什么不导。「listed above」指向先列出同名的组。
 */
export function skillGroupNote(group: ImportSkillGroup): string {
  const count = (status: ImportSkillItem["status"]): number => group.skills.filter((skill) => skill.status === status).length;
  const fresh = count("new");
  const builtIn = count("built-in");
  const inOrbita = count("in-orbita");
  const duplicate = count("duplicate");
  if (fresh + builtIn === 0) {
    if (group.skills.length === 0) return "No skills here";
    if (duplicate === group.skills.length) return "All listed above";
    if (inOrbita === group.skills.length) return "All already in orbita";
  }
  return [
    fresh > 0 ? `${fresh} new` : null,
    builtIn > 0 ? `${builtIn} came with ${SOURCE_LABEL[group.source]}` : null,
    inOrbita > 0 ? `${inOrbita} already in orbita` : null,
    duplicate > 0 ? `${duplicate} listed above` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** 单条 skill 行尾的状态字；可导的 new 没有。 */
export function skillStatusLabel(skill: ImportSkillItem, groups: readonly ImportSkillGroup[]): string | null {
  if (skill.status === "in-orbita") return "Already in orbita";
  if (skill.status === "built-in") return "Came with the app";
  if (skill.status === "duplicate") {
    const first = groups.find((group) => group.dir === skill.duplicateOf);
    return first === undefined ? "Listed above" : `Same name in ${skillGroupLabel(first)}`;
  }
  return null;
}

export const DEFAULT_SKILL_SCOPE: ImportSkillScope = { kind: "global" };

export function sameSkillScope(a: ImportSkillScope, b: ImportSkillScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "workspace" || (b.kind === "workspace" && a.workspaceId === b.workspaceId);
}

export function skillScopeLabel(scope: ImportSkillScope, workspaces: readonly Workspace[]): string {
  if (scope.kind === "global") return "All sessions";
  if (scope.kind === "off") return "Turned off";
  return workspaces.find((workspace) => workspace.id === scope.workspaceId)?.name ?? "Missing workspace";
}

/** 作用域菜单：All sessions、各工作区、先不启用。 */
export function skillScopeOptions(workspaces: readonly Workspace[]): { scope: ImportSkillScope; label: string; hint?: string }[] {
  return [
    { scope: { kind: "global" }, label: "All sessions" },
    ...workspaces.map((workspace) => ({
      scope: { kind: "workspace", workspaceId: workspace.id } as const,
      label: workspace.name,
      hint: "Only this workspace",
    })),
    { scope: { kind: "off" }, label: "Turned off", hint: "Added, enable later in Skills" },
  ];
}

/** 执行请求里的作用域：只列改过的组（没列的主进程按 global）。 */
export function skillScopeChoices(overrides: ReadonlyMap<string, ImportSkillScope>): ImportSkillScopeChoice[] {
  return [...overrides].map(([dir, scope]) => ({ dir, scope }));
}
