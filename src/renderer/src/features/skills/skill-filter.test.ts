import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { filterSkills } from "./skill-filter.ts";
import type { SkillMeta } from "@shared/skill";

const skill = (over: Partial<SkillMeta> = {}): SkillMeta => ({
  slug: "code-review",
  name: "Code review",
  description: "Review the changes since a fixed point.",
  global: false,
  workspaces: ["orbita"],
  missing: false,
  linkedPath: null,
  ...over,
});

describe("filterSkills", () => {
  test("name 命中", () => {
    const skills = [skill(), skill({ slug: "tdd", name: "TDD" })];
    assert.deepEqual(
      filterSkills(skills, "code").map((s) => s.slug),
      ["code-review"],
    );
  });

  test("slug 命中（name 不含查询词）", () => {
    const skills = [skill({ slug: "pdf-tools", name: "PDF" })];
    assert.deepEqual(
      filterSkills(skills, "tools").map((s) => s.slug),
      ["pdf-tools"],
    );
  });

  test("description 命中（name 与 slug 都不含查询词）", () => {
    const skills = [
      skill({ slug: "writing-plans", name: "Writing plans", description: "Draft an implementation plan." }),
    ];
    assert.deepEqual(
      filterSkills(skills, "implementation").map((s) => s.slug),
      ["writing-plans"],
    );
  });

  test("大小写不敏感", () => {
    const skills = [skill({ name: "Code Review" })];
    assert.equal(filterSkills(skills, "CODE").length, 1);
    assert.equal(filterSkills(skills, "code").length, 1);
  });

  test("空串与纯空白：原样返回，不过滤", () => {
    const skills = [skill(), skill({ slug: "tdd", name: "TDD" })];
    assert.equal(filterSkills(skills, "").length, 2);
    assert.equal(filterSkills(skills, "   ").length, 2);
  });

  test("无命中：返回空数组", () => {
    const skills = [skill()];
    assert.deepEqual(filterSkills(skills, "nonexistent"), []);
  });
});
