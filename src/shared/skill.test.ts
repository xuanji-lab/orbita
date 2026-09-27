import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSkillBlock,
  matchSkillTarget,
  parseSkillBlock,
  parseSkillInvocation,
  skillForReadPath,
} from "./skill.ts";

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

describe("parseSkillInvocation", () => {
  it("裸指令只有 target", () => {
    assert.deepEqual(parseSkillInvocation("/skill:grill-me"), { target: "grill-me" });
  });
  it("带附加指示时 rest 拿到其余全部（含换行）", () => {
    assert.deepEqual(parseSkillInvocation("/skill:tdd  按这个来\n第二行"), {
      target: "tdd",
      rest: "按这个来\n第二行",
    });
  });
  it("前后空白不影响", () => {
    assert.deepEqual(parseSkillInvocation("  /skill:x   "), { target: "x" });
  });
  it("不是指令返回 null", () => {
    assert.equal(parseSkillInvocation("/compact"), null);
    assert.equal(parseSkillInvocation("/skill:"), null);
    assert.equal(parseSkillInvocation("用 /skill:x 的方式"), null);
    assert.equal(parseSkillInvocation(""), null);
  });
});

describe("formatSkillBlock / parseSkillBlock", () => {
  const formatted = formatSkillBlock({
    name: "tdd",
    location: "C:\\Users\\d\\Orbita\\skills\\tdd\\SKILL.md",
    body: "# TDD\n先写测试。",
  });
  it("format 出的块能被 parse 原样认回（两端一致的契约；正文含 pi 的 References 行）", () => {
    const parsed = parseSkillBlock(formatted);
    assert.deepEqual(parsed, {
      name: "tdd",
      content: "References are relative to C:\\Users\\d\\Orbita\\skills\\tdd.\n\n# TDD\n先写测试。",
      rest: "",
    });
  });
  it("带附加指示时 rest 是指示原文", () => {
    const parsed = parseSkillBlock(`${formatted}\n\n按这个流程做`);
    assert.equal(parsed?.name, "tdd");
    assert.equal(parsed?.rest, "按这个流程做");
  });
  it("不是 skill 块的消息返回 null", () => {
    assert.equal(parseSkillBlock("普通消息"), null);
    assert.equal(parseSkillBlock("<skill name=\"x\">没有换行闭合</skill>"), null);
    assert.equal(parseSkillBlock(""), null);
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
