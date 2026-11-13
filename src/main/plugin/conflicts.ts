/**
 * 插件的冲突判定（纯函数）。**重名一律拒装、由用户去改名**——不自动改名、不静默丢一条：
 * pi 遇到同名技能是先到先得、后来的悄悄丢（skills.js 的 collision 诊断没有人看），
 * 用户装了插件却发现某条技能从不生效，是最难查的一类。
 *
 * 技能的「身份」有两个：目录名 slug（`/skill:<slug>` 点名与右栏选取先按它匹配）与 SKILL.md 头里的
 * name（pi 的 prompt 标识，点名时第二顺位）。任何一个撞上别人的任何一个，点名就有歧义，所以
 * 比的是两边身份集合的交集，而不只是 name 对 name。
 */
import type { PluginConflict, PluginSkillInfo } from "../../shared/plugin.ts";
import { qualifiedPluginServerName } from "./names.ts";

export interface SkillIdentity {
  slug: string;
  name: string;
}

/** 两条技能的身份有交集吗。 */
export function skillsCollide(a: SkillIdentity, b: SkillIdentity): boolean {
  return a.name === b.name || a.slug === b.slug || a.name === b.slug || a.slug === b.name;
}

/** 已装的别的插件：冲突检测要它们的技能与 MCP 服务名。 */
export interface OtherPlugin {
  name: string;
  skills: readonly SkillIdentity[];
  /** 它每台 server 在模型那边的名字（`plugin_<名>_<服务>`） */
  qualifiedServers: readonly string[];
}

export function findConflicts(input: {
  name: string;
  skills: readonly PluginSkillInfo[];
  /** 清单里每台 server 的原名（认不出的也算占名字） */
  serverNames: readonly string[];
  userSkills: readonly SkillIdentity[];
  others: readonly OtherPlugin[];
  /** 安装时给 true：同名插件已装就是冲突；查「已装插件此刻的冲突」时给 false（自己不和自己比） */
  checkExists: boolean;
}): PluginConflict[] {
  const conflicts: PluginConflict[] = [];
  const otherPlugins = input.others.filter((other) => other.name !== input.name);
  if (input.checkExists && input.others.some((other) => other.name === input.name)) {
    conflicts.push({ kind: "plugin-exists", name: input.name });
  }

  for (const [index, skill] of input.skills.entries()) {
    const user = input.userSkills.find((each) => skillsCollide(skill, each));
    if (user !== undefined) {
      conflicts.push({ kind: "skill-name", skill: skill.name, with: { origin: "user-skill", name: user.name } });
      continue;
    }
    const owner = otherPlugins.find((other) => other.skills.some((each) => skillsCollide(skill, each)));
    if (owner !== undefined) {
      conflicts.push({ kind: "skill-name", skill: skill.name, with: { origin: "plugin", name: owner.name } });
      continue;
    }
    // 自己内部撞：只和排在前面的比，一对只报一次
    if (input.skills.slice(0, index).some((earlier) => skillsCollide(skill, earlier))) {
      conflicts.push({ kind: "skill-duplicate", skill: skill.name });
    }
  }

  const taken = new Map<string, string>();
  for (const other of otherPlugins) for (const qualified of other.qualifiedServers) taken.set(qualified, other.name);
  const own = new Set<string>();
  for (const server of input.serverNames) {
    const qualified = qualifiedPluginServerName(input.name, server);
    const owner = taken.get(qualified);
    if (owner !== undefined) {
      conflicts.push({ kind: "mcp-name", server, qualified, with: owner });
    } else if (own.has(qualified)) {
      // 规整把两个不同的原名压成了同一个（a.b 与 a_b）：同插件内也撞
      conflicts.push({ kind: "mcp-name", server, qualified, with: input.name });
    }
    own.add(qualified);
  }
  return conflicts;
}
