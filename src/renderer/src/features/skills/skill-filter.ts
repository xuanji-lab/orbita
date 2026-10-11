import type { SkillMeta } from "@shared/skill";

/**
 * 补全模式（句中 `/` 触发）的命中：slug 或 name 的**严格前缀**，大小写不敏感。
 * 这是路径防误触的第三道闸：`/tmp` 一打 t/m/p，没有指令前缀命中，面板直接不弹
 * （Claude Code 同款规则——“Only commands whose names start with those letters
 * match, so a file path such as /tmp/notes.md doesn't keep a list open”）。
 * 与 filterSkills 的分工：过滤行/主模式面板用子串（搜索发现），补全用前缀（打字辅助）。
 */
export function skillsByPrefix(skills: SkillMeta[], query: string): SkillMeta[] {
  const q = query.trim().toLowerCase();
  return skills.filter(
    (s) => s.slug.toLowerCase().startsWith(q) || s.name.toLowerCase().startsWith(q),
  );
}

/**
 * 过滤行的匹配逻辑：按 name / slug / description 命中，大小写不敏感。
 *
 * **只回 skills，不动分组**——分组（Global / workspace / Disabled）仍在组件层按
 * `SkillMeta` 的 `global` / `workspaces` 现算，过滤后的结果原样喂给那套逻辑，
 * 组内没有匹配行的组自然消失，不需要这里知道「组」是什么。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */
export function filterSkills(skills: SkillMeta[], query: string): SkillMeta[] {
  const q = query.trim().toLowerCase();
  if (q === "") return skills;
  return skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  );
}
