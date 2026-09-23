import type { SkillMeta } from "@shared/skill";

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
