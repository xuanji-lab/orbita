import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  composeInvocationPrompt,
  findInvocationTokens,
  INVOCATION_CLOSE,
  INVOCATION_OPEN,
  entrySkillSlug,
  stripInvocationBlock,
  type InvokedMcp,
  type InvokedPlugin,
  type InvokedSkill,
} from "./invocation.ts";

describe("findInvocationTokens", () => {
  it("消息开头与句中（空格后）都认，位置精确，kind 标对", () => {
    assert.deepEqual(findInvocationTokens("/skill:tdd 先跑测试"), [
      { kind: "skill", start: 0, end: 10, target: "tdd" },
    ]);
    assert.deepEqual(findInvocationTokens("先跑测试 /skill:tdd 再重构"), [
      { kind: "skill", start: 5, end: 15, target: "tdd" },
    ]);
    assert.deepEqual(findInvocationTokens("/mcp:miyo 搜一下"), [
      { kind: "mcp", start: 0, end: 9, target: "miyo" },
    ]);
    assert.deepEqual(findInvocationTokens("先用 /mcp:miyo 再 /skill:tdd"), [
      { kind: "mcp", start: 3, end: 12, target: "miyo" },
      { kind: "skill", start: 15, end: 25, target: "tdd" },
    ]);
  });
  it("全角空格与换行也是边界（中文输入的真实习惯）", () => {
    assert.deepEqual(findInvocationTokens("先跑\u3000/skill:tdd"), [
      { kind: "skill", start: 3, end: 13, target: "tdd" },
    ]);
    assert.deepEqual(findInvocationTokens("第一行\n/mcp:x"), [
      { kind: "mcp", start: 4, end: 10, target: "x" },
    ]);
  });
  it("多条调用全部扫出，按出现顺序；同名去重不在这一层（主进程做）", () => {
    const tokens = findInvocationTokens("/skill:a 然后 /skill:b 还有 /skill:a");
    assert.deepEqual(tokens.map((token) => token.target), ["a", "b", "a"]);
    assert.deepEqual(tokens.map((token) => token.start), [0, 12, 24]);
  });
  it("前一个字符不是空白就不算（路径 / 紧贴文字）", () => {
    assert.deepEqual(findInvocationTokens("看下C:/skill:x"), []);
    assert.deepEqual(findInvocationTokens("看下/skill:x"), []);
    assert.deepEqual(findInvocationTokens("https://skill:x"), []);
    assert.deepEqual(findInvocationTokens("a/mcp:x"), []);
  });
  it("非点名前缀与裸 /skill: / /mcp: 不算", () => {
    assert.deepEqual(findInvocationTokens("/compact"), []);
    assert.deepEqual(findInvocationTokens("跑 /compact"), []);
    assert.deepEqual(findInvocationTokens("/skill: 后面是空"), []);
    assert.deepEqual(findInvocationTokens("/mcp:"), []);
    // /skillify: 不是一个 /skill: 点名——前缀后面必须直接跟 target
    assert.deepEqual(findInvocationTokens("/skillify:x"), []);
  });
});

describe("composeInvocationPrompt", () => {
  const skills: InvokedSkill[] = [
    { target: "review", location: "/cfg/skills/review/SKILL.md" },
    { target: "tdd", location: "C:\\Orbita\\skills\\tdd\\SKILL.md" },
  ];
  const missing: InvokedSkill[] = [
    { target: "review", location: "/cfg/skills/review/SKILL.md" },
    { target: "nope", problem: "not-found" },
    { target: "broken", problem: "unreadable" },
  ];

  it("只含指令不含正文：SKILL.md 的内容一个字都不进消息（渐进式披露）", () => {
    const out = composeInvocationPrompt(
      "先读 /skill:review 再审 /mcp:miyo",
      [{ target: "review", location: "/cfg/skills/review/SKILL.md" }],
      [{ target: "miyo", available: true }],
    );
    assert.ok(!out.includes("# Skill"), out);
    assert.ok(!out.includes("<skill name="), out);
    assert.ok(out.includes("/cfg/skills/review/SKILL.md"), out);
    assert.ok(out.includes("mcp__miyo__<tool>"), out);
  });
  it("指令块在前、原文一字不动跟在后面（token 原样保留在原地）", () => {
    const original = "帮我 先读 /skill:review，谢谢";
    const out = composeInvocationPrompt(original, skills.slice(0, 1), []);
    assert.ok(out.startsWith(`${INVOCATION_OPEN}\n`), out);
    assert.ok(out.includes(`\n${INVOCATION_CLOSE}\n\n${original}`), out);
    assert.ok(out.endsWith(original), out);
  });
  it("查不到 / 读不出：不拦消息，指令里如实写明、禁止假装加载", () => {
    const out = composeInvocationPrompt("/skill:nope 做点事", missing.slice(1), []);
    assert.ok(out.includes("does not exist or is not linked"), out);
    assert.ok(out.includes("could not be read"), out);
    assert.ok(out.includes("Do not pretend to have loaded"), out);
    assert.ok(out.endsWith("\n\n/skill:nope 做点事"), out);
  });
  it("MCP 未配置 / 禁用：写明不要假装使用", () => {
    const out = composeInvocationPrompt("用 /mcp:ghost 查", [], [{ target: "ghost", available: false }]);
    assert.ok(out.includes("not configured or is disabled"), out);
    assert.ok(out.includes("Do not pretend to use its tools"), out);
  });
  it("两段小节只在有条目时出现，顺序保持传入顺序", () => {
    const out = composeInvocationPrompt(
      "先 /mcp:miyo 后 /skill:review",
      [{ target: "review", location: "/r/SKILL.md" }],
      [{ target: "miyo", available: true }],
    );
    const skillSection = out.indexOf("Skills:");
    const mcpSection = out.indexOf("MCP servers:");
    assert.ok(skillSection > -1 && mcpSection > -1, out);
    assert.ok(out.indexOf("/r/SKILL.md") > skillSection, out);
    assert.ok(out.indexOf("mcp__miyo__") > mcpSection, out);
  });
  it("没有条目时原文原样返回（不 trim、不加块）", () => {
    assert.equal(composeInvocationPrompt("  普通消息  ", [], []), "  普通消息  ");
  });
  it("target 带引号时转义，不撑破小节条目的引号包裹", () => {
    const out = composeInvocationPrompt('/skill:he"llo', [{ target: 'he"llo', location: "/x/SKILL.md" }], []);
    assert.ok(out.includes('he\\"llo'), out);
  });
  it("锁住 pi 不二次展开的形状：组装结果永不以 / 开头（_expandSkillCommand 只认 /skill: 开头）", () => {
    // 消息以 /skill: 开头是最危险的形态——若块拼在后面，pi 的 steer/followUp 路径
    // 可能把全文展开回来。块必须在前，使文本不以 / 开头。
    for (const original of ["/skill:review 审一下", "/mcp:miyo 查", "/skill:review"]) {
      const out = composeInvocationPrompt(original, skills.slice(0, 1), [{ target: "miyo", available: true }]);
      assert.ok(out.startsWith(INVOCATION_OPEN), out);
      assert.ok(!out.startsWith("/"), out);
    }
  });
});

describe("stripInvocationBlock", () => {
  it("compose 的结果能剥回用户原文（往返）", () => {
    const original = "先读 /skill:review 再看 /mcp:miyo\n第二行";
    const out = composeInvocationPrompt(
      original,
      [{ target: "review", location: "/r/SKILL.md" }],
      [{ target: "miyo", available: true }],
    );
    assert.equal(stripInvocationBlock(out), original);
  });
  it("没有块的消息原样返回（不 trim）", () => {
    assert.equal(stripInvocationBlock("  普通消息  "), "  普通消息  ");
    assert.equal(stripInvocationBlock(""), "");
  });
  it("残缺的开标签（用户手打）不剥——宁可不剥，也不吞内容", () => {
    const typed = `${INVOCATION_OPEN}\n我自己打的`;
    assert.equal(stripInvocationBlock(typed), typed);
  });
  it("块不在开头不剥（防误伤消息中间的同名标签）", () => {
    const mid = `先说一句\n\n${INVOCATION_OPEN}\nx\n${INVOCATION_CLOSE}\n\n后话`;
    assert.equal(stripInvocationBlock(mid), mid);
  });
  it("剥完只剩空白也给空白（标题层按空标题处理）", () => {
    const out = composeInvocationPrompt(" /skill:review ", [{ target: "review", location: "/r/SKILL.md" }], []);
    assert.equal(stripInvocationBlock(out), " /skill:review ");
  });
});

describe("/plugin: token", () => {
  it("边界与 /skill: 同一规则（行首或空白后、target 到下一个空白、空 target 不算）", () => {
    assert.deepEqual(findInvocationTokens("/plugin:lit-tracker 跑一下"), [
      { kind: "plugin", start: 0, end: 19, target: "lit-tracker" },
    ]);
    assert.deepEqual(findInvocationTokens("再用 /plugin:a 和 /skill:b"), [
      { kind: "plugin", start: 3, end: 12, target: "a" },
      { kind: "skill", start: 15, end: 23, target: "b" },
    ]);
    assert.deepEqual(findInvocationTokens("先跑\u3000/plugin:a"), [{ kind: "plugin", start: 3, end: 12, target: "a" }]);
    assert.deepEqual(findInvocationTokens("看下C:/plugin:x"), []);
    assert.deepEqual(findInvocationTokens("a/plugin:x"), []);
    assert.deepEqual(findInvocationTokens("/plugin: 后面是空"), []);
    assert.deepEqual(findInvocationTokens("/plugins:x"), []);
  });
});

describe("composeInvocationPrompt · 插件", () => {
  const enabled: InvokedPlugin = {
    target: "lit-tracker",
    state: "enabled",
    displayName: "文献追踪",
    workflow: [
      { title: "爬论文、去重", skill: "lit-intake" },
      { title: "写周报", skill: "lit-digest" },
      { title: "刊登到看板", skill: "show_plugin_board" },
      { title: "人工过目", skill: null },
    ],
    entry: { skill: "lit-intake", location: "/p/lit-tracker/skills/lit-intake/SKILL.md" },
    hasBoard: true,
  };
  const original = "用 /plugin:lit-tracker 跑一下";

  it("指令块写明插件名、工作流各步、入口技能路径与看板句，不内联技能全文", () => {
    const out = composeInvocationPrompt(original, [], [], [enabled]);
    assert.ok(out.startsWith(INVOCATION_OPEN));
    assert.match(out, /Plugins:/);
    assert.match(out, /"lit-tracker" \(display name "文献追踪"\) — enabled in this workspace/);
    assert.match(out, /1\. 爬论文、去重 → lit-intake/);
    assert.match(out, /3\. 刊登到看板 → show_plugin_board/);
    assert.match(out, /4\. 人工过目\n/);
    assert.match(out, /read "\/p\/lit-tracker\/skills\/lit-intake\/SKILL\.md" with the read tool BEFORE any other/);
    assert.match(out, /call show_plugin_board with plugin "lit-tracker"/);
    assert.ok(out.endsWith(`\n\n${original}`));
    assert.equal(stripInvocationBlock(out), original);
  });
  it("没有看板就没有 show_plugin_board 那句；没有工作流就没有 Workflow 段", () => {
    const out = composeInvocationPrompt(original, [], [], [{ ...enabled, workflow: [], hasBoard: false }]);
    assert.doesNotMatch(out, /show_plugin_board/);
    assert.doesNotMatch(out, /Workflow:/);
    assert.match(out, /Entry skill "lit-intake"/);
  });
  it("入口技能读不出：如实写明，不给路径", () => {
    const out = composeInvocationPrompt(original, [], [], [{ ...enabled, entry: null }]);
    assert.match(out, /entry skill could not be found or read/);
    assert.doesNotMatch(out, /with the read tool/);
  });
  it("没装：如实写明不要假装；没启用：叫用户先在这个工作区启用，不给路径", () => {
    const missing = composeInvocationPrompt(original, [], [], [{ target: "ghost", state: "not-installed" }]);
    assert.match(missing, /"ghost" — is not installed/);
    assert.match(missing, /Do not pretend/);
    const off = composeInvocationPrompt(original, [], [], [{ target: "lit-tracker", state: "disabled", displayName: "文献追踪" }]);
    assert.match(off, /NOT enabled in this workspace/);
    assert.match(off, /enable it in the Plugins panel/);
    assert.doesNotMatch(off, /SKILL\.md/);
  });
  it("与 skill、mcp 同块共存，各一段", () => {
    const out = composeInvocationPrompt(original, [{ target: "a", location: "/a/SKILL.md" }], [{ target: "m", available: true }], [enabled]);
    assert.match(out, /Skills:[\s\S]*MCP servers:[\s\S]*Plugins:/);
  });
  it("三者都为空时原文原样返回", () => {
    assert.equal(composeInvocationPrompt("普通消息", [], [], []), "普通消息");
    assert.equal(composeInvocationPrompt("普通消息", [], []), "普通消息");
  });
});

describe("entrySkillSlug", () => {
  it("工作流第一个对上技能的步骤点名的那条", () => {
    assert.equal(
      entrySkillSlug([{ skillSlug: null }, { skillSlug: "b" }, { skillSlug: "a" }], [{ slug: "a" }, { slug: "b" }]),
      "b",
    );
  });
  it("没有工作流（或没有一步对上）取第一条技能；一条也没有为 null", () => {
    assert.equal(entrySkillSlug([], [{ slug: "a" }, { slug: "b" }]), "a");
    assert.equal(entrySkillSlug([{ skillSlug: null }], [{ slug: "z" }]), "z");
    assert.equal(entrySkillSlug([], []), null);
  });
});
