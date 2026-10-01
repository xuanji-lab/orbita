import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandSkillText,
  findSkillTokens,
  formatSkillBlock,
  matchSkillTarget,
  parseSkillSegments,
  replaceSkillTokens,
  skillForReadPath,
  SKILL_NOT_FOUND_CODE,
  type SkillLookup,
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

describe("findSkillTokens", () => {
  it("消息开头与句中（空格后）都认，位置精确", () => {
    assert.deepEqual(findSkillTokens("/skill:tdd 先跑测试"), [
      { start: 0, end: 10, target: "tdd" },
    ]);
    assert.deepEqual(findSkillTokens("先跑测试 /skill:tdd 再重构"), [
      { start: 5, end: 15, target: "tdd" },
    ]);
  });
  it("全角空格与换行也是边界（中文输入的真实习惯）", () => {
    assert.deepEqual(findSkillTokens("先跑\u3000/skill:tdd"), [{ start: 3, end: 13, target: "tdd" }]);
    assert.deepEqual(findSkillTokens("第一行\n/skill:tdd"), [{ start: 4, end: 14, target: "tdd" }]);
  });
  it("多条调用全部扫出，按出现顺序", () => {
    const tokens = findSkillTokens("/skill:a 然后 /skill:b");
    assert.deepEqual(tokens.map((token) => token.target), ["a", "b"]);
    assert.deepEqual(tokens.map((token) => token.start), [0, 12]);
  });
  it("前一个字符不是空白就不算（路径 / 紧贴文字）", () => {
    assert.deepEqual(findSkillTokens("看下C:/skill:x"), []);
    assert.deepEqual(findSkillTokens("看下/skill:x"), []);
    assert.deepEqual(findSkillTokens("https://skill:x"), []);
  });
  it("非 /skill: 前缀与裸 /skill: 不算", () => {
    assert.deepEqual(findSkillTokens("/compact"), []);
    assert.deepEqual(findSkillTokens("跑 /compact"), []);
    assert.deepEqual(findSkillTokens("/skill: 后面是空"), []);
  });
});

describe("replaceSkillTokens", () => {
  const blockOf = (target: string): string => `<skill name="${target}" location="x">\nReferences are relative to /.\n\n正文 ${target}\n</skill>`;

  it("开头单条带附加指示：与旧格式逐字节一致（存量转录不用迁移）", () => {
    const text = "/skill:tdd  按这个来\n第二行";
    const block = formatSkillBlock({
      name: "tdd",
      location: "/cfg/skills/tdd/SKILL.md",
      body: "# TDD",
    });
    // 旧实现：parseSkillInvocation + formatSkillBlock({..., instructions: rest})
    const legacy = formatSkillBlock({
      name: "tdd",
      location: "/cfg/skills/tdd/SKILL.md",
      body: "# TDD",
      instructions: "按这个来\n第二行",
    });
    assert.equal(replaceSkillTokens(text, findSkillTokens(text), () => block), legacy);
  });
  it("开头单条裸调用：只有块", () => {
    assert.equal(
      replaceSkillTokens("/skill:tdd", findSkillTokens("/skill:tdd"), blockOf),
      blockOf("tdd"),
    );
  });
  it("句中调用：散文留在原位，后续文字成为该块的附加指示", () => {
    const out = replaceSkillTokens("先读 /skill:tdd 再重构", findSkillTokens("先读 /skill:tdd 再重构"), blockOf);
    assert.ok(out.startsWith("先读 \n\n"), out);
    assert.ok(out.includes(blockOf("tdd")));
    assert.ok(out.endsWith(`${blockOf("tdd")}\n\n再重构`), out);
  });
  it("多条调用：每块的附加指示吸收到下一个 token 为止，阅读顺序不变", () => {
    const out = replaceSkillTokens("/skill:a 先做 /skill:b 再做", findSkillTokens("/skill:a 先做 /skill:b 再做"), blockOf);
    assert.ok(out.startsWith(blockOf("a")), out);
    assert.ok(out.includes(`${blockOf("a")}\n\n先做\n\n${blockOf("b")}`), out);
    assert.ok(out.endsWith(`${blockOf("b")}\n\n再做`), out);
  });
});

describe("expandSkillText", () => {
  const known = new Set(["tdd", "review"]);
  const lookup = async (target: string): Promise<SkillLookup> =>
    known.has(target) ? { ok: true, block: `[${target}]` } : { ok: false, code: SKILL_NOT_FOUND_CODE };

  it("开头那条查不到：整条抛错（明确的调用，不能静默喂原文给模型）", async () => {
    await assert.rejects(expandSkillText("/skill:nope 做点事", lookup), new RegExp(`${SKILL_NOT_FOUND_CODE}nope`));
  });
  it("句中查不到：原样保留，不让整条消息发不出去", async () => {
    assert.equal(await expandSkillText("上次用 /skill:nope 效果不好", lookup), "上次用 /skill:nope 效果不好");
  });
  it("句中查得到的照常展开，查不到的留在附加指示里", async () => {
    assert.equal(
      await expandSkillText("先读 /skill:tdd 再看 /skill:nope 的写法", lookup),
      "先读 \n\n[tdd]\n\n再看 /skill:nope 的写法",
    );
  });
  it("开头查得到、句中查不到：开头展开，句中原样", async () => {
    assert.equal(await expandSkillText("/skill:review 参考 /skill:nope", lookup), "[review]\n\n参考 /skill:nope");
  });
  it("没有 token：原文原样返回（不 trim）", async () => {
    assert.equal(await expandSkillText("  普通消息  ", lookup), "  普通消息  ");
  });
});

describe("formatSkillBlock / parseSkillSegments", () => {
  const formatted = formatSkillBlock({
    name: "tdd",
    location: "C:\\Users\\d\\Orbita\\skills\\tdd\\SKILL.md",
    body: "# TDD\n先写测试。",
  });
  it("format 出的块能被 parse 原样认回（两端一致的契约；正文含 pi 的 References 行）", () => {
    const segments = parseSkillSegments(formatted);
    assert.deepEqual(segments, [
      {
        kind: "skill",
        name: "tdd",
        content: "References are relative to C:\\Users\\d\\Orbita\\skills\\tdd.\n\n# TDD\n先写测试。",
      },
    ]);
  });
  it("块在前：text 段是附加指示（旧消息形态，开头块 + rest）", () => {
    const segments = parseSkillSegments(`${formatted}\n\n按这个流程做`);
    assert.deepEqual(segments, [
      {
        kind: "skill",
        name: "tdd",
        content: "References are relative to C:\\Users\\d\\Orbita\\skills\\tdd.\n\n# TDD\n先写测试。",
      },
      { kind: "text", text: "\n\n按这个流程做" },
    ]);
  });
  it("句中多块：块前 / 块间的文字按原顺序保留为 text 段", () => {
    const segments = parseSkillSegments(`先读 ${formatted}\n\n按这个来 再 ${formatted}`);
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
    assert.equal(parseSkillSegments("<skill name=\"x\">没有换行闭合</skill>"), null);
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
