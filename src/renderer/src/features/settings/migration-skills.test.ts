import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ImportSkillGroup, ImportSkillItem } from "@shared/import";
import {
  countSelectedSkills,
  defaultSkillSelection,
  selectedSkillDirs,
  skillCountBySource,
  skillGroupLabel,
  skillGroupNote,
  skillScopeChoices,
  skillScopeLabel,
  skillStatusLabel,
} from "./migration-skills.ts";
import { en } from "../../messages-en.ts";

function skill(slug: string, status: ImportSkillItem["status"], group = "/p", duplicateOf: string | null = null): ImportSkillItem {
  return { slug, name: slug, description: "", dir: `${group}/${slug}`, status, duplicateOf };
}

const proma: ImportSkillGroup = {
  source: "proma",
  name: "默认工作区",
  dir: "/p",
  skills: [skill("archify", "new"), skill("docx", "built-in"), skill("tdd", "in-orbita")],
};
const shared: ImportSkillGroup = {
  source: "agent-skills",
  name: null,
  dir: "/a",
  skills: [skill("archify", "duplicate", "/a", "/p"), skill("tabbit", "new", "/a")],
};
const claude: ImportSkillGroup = { source: "claude-code", name: null, dir: "/c", skills: [skill("tdd", "in-orbita", "/c")] };
const groups = [proma, shared, claude];

describe("migration-skills", () => {
  test("默认只勾 new；built-in 可勾但不默认；in-orbita / duplicate 永远不进执行请求", () => {
    const selected = defaultSkillSelection(groups);
    assert.deepEqual([...selected].sort(), ["/a/tabbit", "/p/archify"]);
    selected.add("/p/docx");
    selected.add("/p/tdd");
    selected.add("/a/archify");
    assert.deepEqual(selectedSkillDirs(groups, selected), ["/p/archify", "/p/docx", "/a/tabbit"]);
    assert.equal(countSelectedSkills(groups, selected), 3);
    assert.deepEqual(skillCountBySource(groups), { proma: 2, "agent-skills": 1, "claude-code": 0 });
  });

  test("组名与说明：能导几个、其余为什么不导；全都不可导时一句话说原因", () => {
    assert.equal(skillGroupLabel(proma, en), "Proma · 默认工作区");
    assert.equal(skillGroupLabel(shared, en), "Shared agent skills");
    assert.equal(skillGroupNote(proma, en), "1 new · 1 came with Proma · 1 already in orbita");
    assert.equal(skillGroupNote(shared, en), "1 new · 1 listed above");
    assert.equal(skillGroupNote(claude, en), "All already in orbita");
    assert.equal(skillGroupNote({ ...claude, skills: [] }, en), "No skills here");
    assert.equal(skillGroupNote({ ...shared, skills: [shared.skills[0]!] }, en), "All listed above");
  });

  test("单条状态：重名指出先列出它的组", () => {
    assert.equal(skillStatusLabel(shared.skills[0]!, groups, en), "Same name in Proma · 默认工作区");
    assert.equal(skillStatusLabel(proma.skills[2]!, groups, en), "Already in orbita");
    assert.equal(skillStatusLabel(proma.skills[0]!, groups, en), null);
  });

  test("作用域：名字与执行请求里只列改过的组", () => {
    const workspaces = [{ id: "w1", name: "orbita", path: "/repo", createdAt: 1, attachedDirs: [] }];
    assert.equal(skillScopeLabel({ kind: "global" }, workspaces, en), "All sessions");
    assert.equal(skillScopeLabel({ kind: "workspace", workspaceId: "w1" }, workspaces, en), "orbita");
    assert.equal(skillScopeLabel({ kind: "off" }, workspaces, en), "Turned off");
    assert.deepEqual(skillScopeChoices(new Map([["/p", { kind: "off" as const }]])), [{ dir: "/p", scope: { kind: "off" } }]);
  });
});
