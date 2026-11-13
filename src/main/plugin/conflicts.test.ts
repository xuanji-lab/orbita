import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findConflicts, skillsCollide } from "./conflicts.ts";

const skill = (slug: string, name = slug) => ({ slug, name, description: "d" });

describe("skillsCollide", () => {
  test("name 对 name、slug 对 slug、name 对 slug 任何一对相等都算撞（点名会有歧义）", () => {
    assert.equal(skillsCollide({ slug: "a", name: "A" }, { slug: "b", name: "A" }), true);
    assert.equal(skillsCollide({ slug: "a", name: "A" }, { slug: "a", name: "B" }), true);
    assert.equal(skillsCollide({ slug: "a", name: "A" }, { slug: "x", name: "a" }), true);
    assert.equal(skillsCollide({ slug: "a", name: "A" }, { slug: "b", name: "B" }), false);
  });
});

describe("findConflicts", () => {
  const base = { name: "p", serverNames: [], userSkills: [], others: [], checkExists: true } as const;

  test("没有冲突是空数组", () => {
    assert.deepEqual(findConflicts({ ...base, skills: [skill("a")] }), []);
  });

  test("用户技能优先于别的插件作为「撞的对象」；每条技能只报一次", () => {
    const conflicts = findConflicts({
      ...base,
      skills: [skill("a")],
      userSkills: [{ slug: "a", name: "a" }],
      others: [{ name: "q", skills: [{ slug: "a", name: "a" }], qualifiedServers: [] }],
    });
    assert.deepEqual(conflicts, [{ kind: "skill-name", skill: "a", with: { origin: "user-skill", name: "a" } }]);
  });

  test("插件内部两条互撞：只报后面那条", () => {
    const conflicts = findConflicts({ ...base, skills: [skill("x1", "same"), skill("x2", "same")] });
    assert.deepEqual(conflicts, [{ kind: "skill-duplicate", skill: "same" }]);
  });

  test("查已装插件自己的冲突时（checkExists=false）不和自己比，也不报 plugin-exists", () => {
    const conflicts = findConflicts({
      ...base,
      checkExists: false,
      skills: [skill("a")],
      others: [{ name: "p", skills: [{ slug: "a", name: "a" }], qualifiedServers: ["plugin_p_s"] }],
      serverNames: ["s"],
    });
    assert.deepEqual(conflicts, []);
  });

  test("同一插件内两台 server 规整后同名：报 mcp-name，with 是自己", () => {
    const conflicts = findConflicts({ ...base, skills: [], serverNames: ["a.b", "a_b"] });
    assert.deepEqual(conflicts, [{ kind: "mcp-name", server: "a_b", qualified: "plugin_p_a_b", with: "p" }]);
  });
});
