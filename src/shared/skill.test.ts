import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSkillAvailable, matchSkillTarget, parseSkillSegments, skillForReadPath } from "./skill.ts";

/**
 * 旧转录的 `<skill>` 块字节形状（2026-10-02 改指令式之前，主进程 formatSkillBlock
 * 产出的格式）。用字面量钉在这里：显示端要永远认得它，而产出方已经删了——
 * 测试就是这份遗留格式的规格说明。
 */
const LEGACY_SKILL_BLOCK = [
  '<skill name="tdd" location="C:\\Users\\d\\Orbita\\skills\\tdd\\SKILL.md">',
  "References are relative to C:\\Users\\d\\Orbita\\skills\\tdd.",
  "",
  "# TDD",
  "先写测试。",
  "</skill>",
].join("\n");

describe("isSkillAvailable", () => {
  // 三种归属形态：global、单工作区、多工作区；missing 是第四种状态（断链）
  const globalSkill = { slug: "g", name: "g", description: "", global: true, workspaces: [], missing: false, linkedPath: null };
  const wsSkill = { slug: "w", name: "w", description: "", global: false, workspaces: ["ws1"], missing: false, linkedPath: null };
  const multiSkill = { slug: "m", name: "m", description: "", global: false, workspaces: ["ws1", "ws2"], missing: false, linkedPath: null };
  const brokenSkill = { slug: "b", name: "b", description: "", global: true, workspaces: [], missing: true, linkedPath: null };
  it("global 对所有会话可用（含无工作区）", () => {
    assert.equal(isSkillAvailable(globalSkill, null), true);
    assert.equal(isSkillAvailable(globalSkill, "ws1"), true);
  });
  it("链在本工作区才可用", () => {
    assert.equal(isSkillAvailable(wsSkill, "ws1"), true);
    assert.equal(isSkillAvailable(wsSkill, "ws2"), false);
  });
  it("多工作区：链在其中一个即可", () => {
    assert.equal(isSkillAvailable(multiSkill, "ws1"), true);
    assert.equal(isSkillAvailable(multiSkill, "ws2"), true);
    assert.equal(isSkillAvailable(multiSkill, "ws3"), false);
  });
  it("无工作区的会话只剩 global 可用", () => {
    assert.equal(isSkillAvailable(wsSkill, null), false);
  });
  it("断链一律不可用（哪怕 global）", () => {
    assert.equal(isSkillAvailable(brokenSkill, null), false);
    assert.equal(isSkillAvailable(brokenSkill, "ws1"), false);
  });
});

describe("matchSkillTarget", () => {
  const available = [
    { slug: "grill-me", name: "Grill" },
    { slug: "tdd", name: "tdd" },
  ];
  it("slug 优先于 name", () => {
    assert.deepEqual(matchSkillTarget(available, "grill-me"), available[0]);
    assert.deepEqual(matchSkillTarget(available, "tdd"), available[1]);
  });
  it("slug 不中再按 name 匹配", () => {
    assert.deepEqual(matchSkillTarget(available, "Grill"), available[0]);
  });
  it("都不中返回 null", () => {
    assert.equal(matchSkillTarget(available, "nope"), null);
  });
});

describe("parseSkillSegments（旧转录显示路径）", () => {
  it("旧格式的块原样认回（正文含 pi 的 References 行）", () => {
    const segments = parseSkillSegments(LEGACY_SKILL_BLOCK);
    assert.deepEqual(segments, [
      {
        kind: "skill",
        name: "tdd",
        content:
          "References are relative to C:\\Users\\d\\Orbita\\skills\\tdd.\n\n# TDD\n先写测试。",
      },
    ]);
  });
  it("块在前：text 段是附加指示（旧消息形态，开头块 + rest）", () => {
    const segments = parseSkillSegments(`${LEGACY_SKILL_BLOCK}\n\n按这个流程做`);
    assert.deepEqual(segments, [
      {
        kind: "skill",
        name: "tdd",
        content:
          "References are relative to C:\\Users\\d\\Orbita\\skills\\tdd.\n\n# TDD\n先写测试。",
      },
      { kind: "text", text: "\n\n按这个流程做" },
    ]);
  });
  it("句中多块：块前 / 块间的文字按原顺序保留为 text 段", () => {
    const segments = parseSkillSegments(`先读 ${LEGACY_SKILL_BLOCK}\n\n按这个来 再 ${LEGACY_SKILL_BLOCK}`);
    assert.equal(segments?.length, 4);
    assert.deepEqual(segments?.[0], { kind: "text", text: "先读 " });
    assert.equal(segments?.[1]?.kind, "skill");
    assert.ok(
      segments?.[2]?.kind === "text" && segments[2].text.includes("按这个来 再"),
    );
    assert.equal(segments?.[3]?.kind, "skill");
  });
  it("不是 skill 块的消息返回 null", () => {
    assert.equal(parseSkillSegments("普通消息"), null);
    assert.equal(parseSkillSegments('<skill name="x">没有换行闭合</skill>'), null);
    assert.equal(parseSkillSegments(""), null);
  });
});

describe("skillForReadPath", () => {
  const skills = [
    { slug: "tdd", name: "TDD" },
    { slug: "Grill-Me", name: "Grill" },
  ];
  it("链接目录路径按 slug 尾巴命中", () => {
    assert.deepEqual(
      skillForReadPath("C:\\cfg\\skill-links\\global\\tdd\\SKILL.md", skills),
      { slug: "tdd", name: "TDD" },
    );
  });
  it("存储路径同样命中；大小写与斜杠方向不敏感", () => {
    assert.deepEqual(skillForReadPath("/cfg/skills/GRILL-ME/Skill.md", skills), {
      slug: "Grill-Me",
      name: "Grill",
    });
  });
  it("slug 不认识 / 不是 SKILL.md，都是 null", () => {
    assert.equal(skillForReadPath("C:\\cfg\\skills\\nope\\SKILL.md", skills), null);
    assert.equal(skillForReadPath("C:\\proj\\src\\main.ts", skills), null);
    assert.equal(skillForReadPath("C:\\x\\tdd\\notes.md", skills), null);
  });
});
