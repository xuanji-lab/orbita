/**
 * 迁移页的 Skills 一段：列出其他 agent 的 skills 目录，按勾选复制或链接进 orbita 的中心存储。
 * 纯 node 模块（不 import electron），`node --test` 直接测。
 *
 * **源目录只读。** 复制读、链接只建一条指向它的 symlink，都不改源。
 *
 * 一个 skill = 源目录下一个含 SKILL.md 的子目录（或指向这种目录的 symlink）；目录名就是 slug。
 * 重名按 slug 认，**先到先得**：组的顺序就是页面的顺序（Proma 各工作区 → 共用目录 → Claude Code），
 * 后面的同名标 duplicate；orbita 已有的标 in-orbita。两种都不导——同名的两份内容可能不同，
 * 静默挑一份或覆盖都是替用户做决定。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isSkillSlug, type SkillScope } from "../../shared/skill.ts";
import type {
  ImportSkillGroup,
  ImportSkillItem,
  ImportSkillMode,
  ImportSkillScope,
  ImportSkillScopeChoice,
  ImportSourceId,
} from "../../shared/import.ts";
import { parseSkillMd } from "./store.ts";

/** 一个要扫的源 skills 目录。 */
export interface SkillSourceDir {
  source: ImportSourceId;
  /** 来源内的名字（Proma 的工作区名等）；来源只有这一个目录时为 null */
  name: string | null;
  dir: string;
}

/** 目录不在、读不了都当没有：来源没装 skills 是常态，不是错。 */
async function childNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function readSkillMd(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Proma 的工作区目录（`agent-workspaces/<slug>`），名字取工作区表里的 name。默认工作区排最前
 * （它通常最全），其余按名字。skills 与 MCP 都按工作区放，两处共用这一份顺序——重名先到先得
 * 在两段里是同一个优先级。
 */
export async function promaWorkspaceFolders(promaRoot: string): Promise<{ slug: string; name: string }[]> {
  let workspaces: { slug: string; name: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(join(promaRoot, "agent-workspaces.json"), "utf8"));
    const list = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["workspaces"] : null;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const slug = record["slug"];
        const name = record["name"];
        if (typeof slug === "string" && slug !== "") workspaces.push({ slug, name: typeof name === "string" && name !== "" ? name : slug });
      }
    }
  } catch {
    // 工作区表读不到：退回按目录名列
  }
  const known = new Map(workspaces.map((workspace) => [workspace.slug, workspace.name]));
  const slugs = (await childNames(join(promaRoot, "agent-workspaces"))).filter((slug) => !slug.startsWith("."));
  workspaces = slugs.map((slug) => ({ slug, name: known.get(slug) ?? slug }));
  workspaces.sort((a, b) => (a.slug === "default" ? -1 : b.slug === "default" ? 1 : a.name.localeCompare(b.name)));
  return workspaces;
}

/** Proma 的 skills：每个工作区一个目录（停用的在 skills-inactive，不导）。 */
export function promaSkillDirs(promaRoot: string, workspaces: readonly { slug: string; name: string }[]): SkillSourceDir[] {
  return workspaces.map((workspace) => ({
    source: "proma",
    name: workspace.name,
    dir: join(promaRoot, "agent-workspaces", workspace.slug, "skills"),
  }));
}

/** Proma 自带的 skills（`default-skills/` 下的目录名）：列出来但默认不勾。 */
export async function promaBuiltInSkills(promaRoot: string): Promise<Set<string>> {
  return new Set(await childNames(join(promaRoot, "default-skills")));
}

/**
 * Claude Code 的 skills：`~/.claude/skills`，以及 Claude 桌面应用从账号同步下来的
 * `~/.claude/skills/synced/<账号>/`（一个账号一组）。
 */
export async function claudeCodeSkillDirs(skillsDir: string): Promise<SkillSourceDir[]> {
  const dirs: SkillSourceDir[] = [{ source: "claude-code", name: null, dir: skillsDir }];
  // 以 . 开头的是桌面应用的内部目录（.bucket-*），不是账号
  for (const account of (await childNames(join(skillsDir, "synced"))).filter((name) => !name.startsWith("."))) {
    dirs.push({ source: "claude-code", name: "synced", dir: join(skillsDir, "synced", account) });
  }
  return dirs;
}

/**
 * 扫描：按给定顺序读每个目录，产出页面的组。**只读 SKILL.md**（名字与描述），不读 skill 的其余文件。
 * 一个目录里一个 skill 都没有的组照样返回（空组）——页面据此说「这里没有 skill」还是干脆不列，是页面的事。
 */
export async function scanSkillDirs(
  dirs: readonly SkillSourceDir[],
  existing: ReadonlySet<string>,
  builtIns: ReadonlySet<string>,
): Promise<ImportSkillGroup[]> {
  const firstSeen = new Map<string, string>();
  const groups: ImportSkillGroup[] = [];
  for (const source of dirs) {
    const skills: ImportSkillItem[] = [];
    for (const slug of await childNames(source.dir)) {
      if (!isSkillSlug(slug)) continue;
      const dir = join(source.dir, slug);
      // symlink 指向的目录也算（~/.claude/skills 里常见）；stat 跟链
      const isDirectory = await stat(dir).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (!isDirectory) continue;
      const raw = await readSkillMd(dir);
      if (raw === null) continue;
      const parsed = parseSkillMd(raw);
      const seenIn = firstSeen.get(slug);
      const status: ImportSkillItem["status"] = existing.has(slug)
        ? "in-orbita"
        : seenIn !== undefined
          ? "duplicate"
          : source.source === "proma" && builtIns.has(slug)
            ? "built-in"
            : "new";
      if (seenIn === undefined) firstSeen.set(slug, source.dir);
      skills.push({
        slug,
        name: parsed.name ?? slug,
        description: parsed.description ?? "",
        dir,
        status,
        duplicateOf: status === "duplicate" ? (seenIn ?? null) : null,
      });
    }
    groups.push({ source: source.source, name: source.name, dir: source.dir, skills });
  }
  return groups;
}

/** 落盘动作（生产接 SkillStore，测试接假实现）。都返回落下的 slug；同名已存在要抛错，不覆盖。 */
export interface SkillImportTarget {
  copyFrom(sourceDir: string, scope: SkillScope | null): Promise<string>;
  importFrom(sourceDir: string, scope: SkillScope | null): Promise<string>;
}

export interface SkillSelection {
  skills: ReadonlySet<string>;
  mode: ImportSkillMode;
  scopes: readonly ImportSkillScopeChoice[];
}

/** 页面的作用域 → SkillStore 的作用域；off = 只落存储不建链。工作区已不存在则抛错（不替用户换成 global）。 */
function toSkillScope(scope: ImportSkillScope, workspaceIds: ReadonlySet<string>): SkillScope | null {
  if (scope.kind === "off") return null;
  if (scope.kind === "global") return { kind: "global" };
  if (!workspaceIds.has(scope.workspaceId)) throw new Error("the workspace chosen for these skills no longer exists");
  return { kind: "workspace", workspaceId: scope.workspaceId };
}

/**
 * 执行：按**重扫得到的**组与状态过滤勾选（只导 new / built-in），逐条复制或链接。单条失败记下继续。
 */
export async function importSkills(
  groups: readonly ImportSkillGroup[],
  selection: SkillSelection,
  target: SkillImportTarget,
  workspaceIds: ReadonlySet<string>,
): Promise<{ imported: number; failed: { slug: string; error: string }[] }> {
  const scopeByGroup = new Map(selection.scopes.map((choice) => [choice.dir, choice.scope]));
  let imported = 0;
  const failed: { slug: string; error: string }[] = [];
  for (const group of groups) {
    for (const skill of group.skills) {
      if (!selection.skills.has(skill.dir)) continue;
      if (skill.status !== "new" && skill.status !== "built-in") continue;
      try {
        const scope = toSkillScope(scopeByGroup.get(group.dir) ?? { kind: "global" }, workspaceIds);
        if (selection.mode === "copy") await target.copyFrom(skill.dir, scope);
        else await target.importFrom(skill.dir, scope);
        imported += 1;
      } catch (cause) {
        failed.push({ slug: skill.slug, error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  }
  return { imported, failed };
}
