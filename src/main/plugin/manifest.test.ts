import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parseUserConfig, resolveComponentPath, scanPlugin } from "./manifest.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-plugin-manifest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SKILL = (name: string, description = "做一件事"): string => `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;

async function put(relative: string, content: string): Promise<void> {
  const file = join(dir, ...relative.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content, "utf8");
}

describe("scanPlugin 清单", () => {
  test("认 .claude-plugin/plugin.json 的元数据", async () => {
    await put(
      ".claude-plugin/plugin.json",
      JSON.stringify({ name: "deploy-tools", displayName: "Deploy Tools", version: "1.2.0", description: "部署", author: { name: "Example Team" }, license: "MIT" }),
    );
    const scanned = await scanPlugin(dir, "ignored");
    assert.equal(scanned.name, "deploy-tools");
    assert.equal(scanned.nameValid, true);
    assert.equal(scanned.displayName, "Deploy Tools");
    assert.equal(scanned.version, "1.2.0");
    assert.equal(scanned.author, "Example Team");
    assert.equal(scanned.manifestFile, ".claude-plugin/plugin.json");
  });

  test("没有 .claude-plugin 时认 .zcode-plugin/plugin.json；两个都有以前者为准", async () => {
    await put(".zcode-plugin/plugin.json", JSON.stringify({ name: "z", version: "0.1.0" }));
    assert.equal((await scanPlugin(dir, "x")).manifestFile, ".zcode-plugin/plugin.json");
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "c" }));
    const both = await scanPlugin(dir, "x");
    assert.equal(both.name, "c");
    assert.equal(both.manifestFile, ".claude-plugin/plugin.json");
  });

  test("清单可选：名字退回目录名（小写化），默认位置照扫", async () => {
    await put("skills/alpha/SKILL.md", SKILL("alpha"));
    const scanned = await scanPlugin(dir, "My-Plugin");
    assert.equal(scanned.name, "my-plugin");
    assert.equal(scanned.manifestFile, null);
    assert.deepEqual(scanned.skills.map((s) => s.slug), ["alpha"]);
    assert.equal(scanned.foundAnything, true);
  });

  test("名字不合法（空格、大写之外的符号）如实标出，不替用户改", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "bad name" }));
    const scanned = await scanPlugin(dir, "x");
    assert.equal(scanned.name, "bad name");
    assert.equal(scanned.nameValid, false);
  });

  test("清单 JSON 写坏：报 manifest-invalid，仍按默认位置扫，不抛", async () => {
    await put(".claude-plugin/plugin.json", "{ nope");
    await put("skills/a/SKILL.md", SKILL("a"));
    const scanned = await scanPlugin(dir, "fallback");
    assert.equal(scanned.problems.some((p) => p.kind === "manifest-invalid"), true);
    assert.equal(scanned.manifestFile, ".claude-plugin/plugin.json");
    assert.equal(scanned.skills.length, 1);
  });

  test("空目录：什么都没找到", async () => {
    const scanned = await scanPlugin(dir, "empty");
    assert.equal(scanned.foundAnything, false);
  });
});

describe("scanPlugin 技能", () => {
  test("skills/ 下每个带 SKILL.md 的子文件夹一条，按 slug 排序（索引进 system prompt，顺序要稳）", async () => {
    await put("skills/zeta/SKILL.md", SKILL("zeta"));
    await put("skills/alpha/SKILL.md", SKILL("Alpha Skill", "第一条"));
    await put("skills/not-a-skill/README.md", "x");
    const skills = (await scanPlugin(dir, "p")).skills;
    assert.deepEqual(skills.map((s) => [s.slug, s.name]), [["alpha", "Alpha Skill"], ["zeta", "zeta"]]);
    assert.equal(skills[0]?.description, "第一条");
  });

  test("清单 skills 不带 ./（ZCode 官方写法）也认，且与默认 skills/ 相加不重复", async () => {
    await put(".zcode-plugin/plugin.json", JSON.stringify({ name: "p", skills: "skills" }));
    await put("skills/one/SKILL.md", SKILL("one"));
    const scanned = await scanPlugin(dir, "p");
    assert.deepEqual(scanned.skills.map((s) => s.slug), ["one"]);
  });

  test("清单 skills 指向额外目录；`.` 指插件根；指向自带 SKILL.md 的单个文件夹", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", skills: ["./extra", "./single"] }));
    await put("extra/e1/SKILL.md", SKILL("e1"));
    await put("single/SKILL.md", SKILL("solo"));
    const scanned = await scanPlugin(dir, "p");
    assert.deepEqual(scanned.skills.map((s) => s.slug).sort(), ["e1", "single"]);
  });

  test("没有 skills/ 也没写 skills、根上有 SKILL.md：整个插件是一条技能，slug 取插件名", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "whole" }));
    await put("SKILL.md", SKILL("whole-skill"));
    const scanned = await scanPlugin(dir, "dirname");
    assert.deepEqual(scanned.skills.map((s) => [s.slug, s.name]), [["whole", "whole-skill"]]);
  });

  test("官方插件常见的块标量 description（> 折叠）读到全文，不是孤零零的 >", async () => {
    await put("skills/doc/SKILL.md", "---\nname: doc\ndescription: >\n  第一句。\n  第二句。\n---\n正文\n");
    const skills = (await scanPlugin(dir, "p")).skills;
    assert.equal(skills[0]?.description, "第一句。 第二句。");
  });

  test("没有 description 的 SKILL.md pi 不会加载：不当技能数，报出来", async () => {
    await put("skills/dead/SKILL.md", "---\nname: dead\n---\n正文\n");
    const scanned = await scanPlugin(dir, "p");
    assert.equal(scanned.skills.length, 0);
    assert.equal(scanned.problems.some((p) => p.kind === "skill-no-description" && p.detail === "dead/SKILL.md"), true);
  });

  test("清单路径含 ..、写成绝对路径、符号链接指到根外：全部拒绝并报 path-escape", async () => {
    const outside = await mkdtemp(join(tmpdir(), "orbita-plugin-outside-"));
    try {
      await mkdir(join(outside, "evil"), { recursive: true });
      await writeFile(join(outside, "evil", "SKILL.md"), SKILL("evil"), "utf8");
      await symlink(outside, join(dir, "linked"));
      await put(
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "p", skills: ["../outside", join(outside), "./linked"] }),
      );
      const scanned = await scanPlugin(dir, "p");
      assert.equal(scanned.skills.length, 0);
      const escapes = scanned.problems.filter((p) => p.kind === "path-escape");
      assert.equal(escapes.length, 3);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("skills/ 里的子文件夹是指到根外的符号链接：不加载并报逃逸", async () => {
    const outside = await mkdtemp(join(tmpdir(), "orbita-plugin-outside-"));
    try {
      await writeFile(join(outside, "SKILL.md"), SKILL("evil"), "utf8");
      await mkdir(join(dir, "skills"), { recursive: true });
      await symlink(outside, join(dir, "skills", "evil"));
      await put("skills/ok/SKILL.md", SKILL("ok"));
      const scanned = await scanPlugin(dir, "p");
      assert.deepEqual(scanned.skills.map((s) => s.slug), ["ok"]);
      assert.equal(scanned.problems.some((p) => p.kind === "path-escape" && p.detail.includes("evil")), true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("清单里写了不存在的路径：报 path-missing，不抛", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", skills: "./nope" }));
    const scanned = await scanPlugin(dir, "p");
    assert.equal(scanned.problems.some((p) => p.kind === "path-missing"), true);
  });
});

describe("resolveComponentPath", () => {
  test("带不带 ./ 都解析到根内；. 与 ./ 是根", async () => {
    await mkdir(join(dir, "a"), { recursive: true });
    const real = (await import("node:fs/promises")).realpath;
    const realRoot = await real(dir);
    for (const raw of ["a", "./a", "a/", ".", "./"]) {
      const result = await resolveComponentPath(dir, realRoot, "skills", raw);
      assert.equal(result.ok, true, raw);
    }
  });
});

describe("scanPlugin MCP", () => {
  test(".mcp.json 先读，再按清单声明的顺序，同名后者替换前者", async () => {
    await put(".mcp.json", JSON.stringify({ mcpServers: { a: { command: "one" }, b: { command: "keep" } } }));
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", mcpServers: { a: { command: "two", args: ["x"] }, c: { type: "http", url: "https://example.com/mcp" } } }));
    const servers = (await scanPlugin(dir, "p")).mcpServers;
    assert.deepEqual(servers.map((s) => s.name), ["a", "b", "c"]);
    assert.deepEqual(servers[0]?.server, { transport: "stdio", command: "two", args: ["x"] });
    assert.equal(servers[2]?.server?.transport, "http");
  });

  test(".mcp.json 也可以直接是名字表（不套 mcpServers）", async () => {
    await put(".mcp.json", JSON.stringify({ solo: { command: "node", args: ["s.js"] } }));
    assert.deepEqual((await scanPlugin(dir, "p")).mcpServers.map((s) => s.name), ["solo"]);
  });

  test("清单 mcpServers 可以指向 .json 文件", async () => {
    await put("mcp/servers.json", JSON.stringify({ mcpServers: { filed: { command: "x" } } }));
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", mcpServers: "./mcp/servers.json" }));
    assert.deepEqual((await scanPlugin(dir, "p")).mcpServers.map((s) => s.name), ["filed"]);
  });

  test("认不出的配置（SSE、缺 command）列出来并说明原因，不静默丢", async () => {
    await put(".mcp.json", JSON.stringify({ mcpServers: { old: { type: "sse", url: "https://x/sse" }, broken: { args: ["x"] } } }));
    const servers = (await scanPlugin(dir, "p")).mcpServers;
    assert.equal(servers.length, 2);
    for (const entry of servers) {
      assert.equal(entry.server, null);
      assert.equal(entry.invalid, "unsupported-shape");
    }
  });

  test("插件里的 server 自带的 workspaces / disabled 被剥掉：范围只由插件的启用范围管", async () => {
    await put(".mcp.json", JSON.stringify({ mcpServers: { s: { command: "x", workspaces: ["w"], disabled: true } } }));
    const server = (await scanPlugin(dir, "p")).mcpServers[0]?.server;
    assert.equal(server !== null && server !== undefined && "workspaces" in server, false);
    assert.equal(server !== null && server !== undefined && "disabled" in server, false);
  });

  test(".mcp.json 写坏：报 mcp-unreadable，其它照常", async () => {
    await put(".mcp.json", "{ broken");
    await put("skills/a/SKILL.md", SKILL("a"));
    const scanned = await scanPlugin(dir, "p");
    assert.equal(scanned.problems.some((p) => p.kind === "mcp-unreadable"), true);
    assert.equal(scanned.skills.length, 1);
  });

  test(".mcpb 包与 https 包地址不支持：进 unsupported 的 mcp-bundle", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", mcpServers: ["./b.mcpb", "https://example.com/s.dxt"] }));
    const unsupported = (await scanPlugin(dir, "p")).unsupported;
    assert.deepEqual(unsupported.find((u) => u.kind === "mcp-bundle")?.count, 2);
  });
});

describe("scanPlugin 暂不支持的组件", () => {
  test("命令、智能体、hooks、面板（ZCode ui.surfaces）、bin 都解析出名字，不加载", async () => {
    await put(
      ".zcode-plugin/plugin.json",
      JSON.stringify({
        name: "rich",
        skills: "skills",
        agents: "agents",
        ui: { surfaces: [{ id: "pdf", title: "PDF" }] },
        commands: { status: { source: "./commands/status.md" } },
      }),
    );
    await put("skills/s/SKILL.md", SKILL("s"));
    await put("agents/visual-judge.md", "# agent");
    await put("commands/deploy.md", "# deploy");
    await put("hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [] } }));
    await put("bin/tool", "#!/bin/sh");
    await put("scripts/run.sh", "echo");
    const scanned = await scanPlugin(dir, "rich");
    const kinds = new Map(scanned.unsupported.map((u) => [u.kind, u]));
    assert.deepEqual(kinds.get("agents")?.items, ["visual-judge"]);
    assert.deepEqual(kinds.get("panel")?.items, ["pdf"]);
    assert.deepEqual(kinds.get("hooks")?.items, ["PreToolUse"]);
    assert.deepEqual(kinds.get("commands")?.items.sort(), ["deploy", "status"]);
    assert.equal(kinds.has("bin"), true);
    assert.equal(scanned.hasScripts, true);
    assert.equal(scanned.skills.length, 1);
    assert.equal(scanned.mcpServers.length, 0);
  });

  test("每类最多列前 6 个名字，count 给真数", async () => {
    for (let i = 0; i < 9; i += 1) await put(`commands/c${i}.md`, "x");
    const commands = (await scanPlugin(dir, "p")).unsupported.find((u) => u.kind === "commands");
    assert.equal(commands?.items.length, 6);
    assert.equal(commands?.count, 9);
  });
});

describe("parseUserConfig", () => {
  test("规范字段全认；ZCode 缺 title / required 时 title 退回键名、required 为假", () => {
    const fields = parseUserConfig({
      api_token: { type: "string", title: "API token", description: "令牌", sensitive: true, required: true },
      default_avd: { type: "string", default: "medium_phone", description: "设备" },
      level: { type: "string", options: ["a", "b"], default: "a" },
      port: { type: "number", min: 1, max: 65535, default: 80 },
    });
    assert.equal(fields[0]?.sensitive, true);
    assert.equal(fields[0]?.required, true);
    assert.equal(fields[1]?.title, "default_avd");
    assert.equal(fields[1]?.required, false);
    assert.equal(fields[1]?.default, "medium_phone");
    assert.deepEqual(fields[2]?.options, ["a", "b"]);
    assert.equal(fields[3]?.min, 1);
    assert.equal(fields[3]?.max, 65535);
  });

  test("键名不合法（数字开头、含连字符）跳过并报，其余照常", () => {
    const problems: Parameters<typeof parseUserConfig>[1] = [];
    const fields = parseUserConfig({ "1bad": {}, "bad-key": {}, good: { type: "boolean" } }, problems);
    assert.deepEqual(fields.map((f) => f.key), ["good"]);
    assert.deepEqual(problems, [
      { kind: "config-key-invalid", detail: "1bad" },
      { kind: "config-key-invalid", detail: "bad-key" },
    ]);
  });

  test("不认的 type 退回 string；非对象的配置项当空声明", () => {
    const fields = parseUserConfig({ a: { type: "weird" }, b: "not an object" });
    assert.deepEqual(fields.map((f) => [f.key, f.type]), [["a", "string"], ["b", "string"]]);
  });
});

describe("scanPlugin 的 orbita 扩展（workflow）", () => {
  test("orbita.workflow 解析进 scanned.workflow，技能按 slug / name 对上本插件的", async () => {
    await put("skills/lit-scan/SKILL.md", SKILL("lit-scan"));
    await put(
      ".claude-plugin/plugin.json",
      JSON.stringify({
        name: "lit",
        orbita: { workflow: [{ title: "扫", skill: "lit-scan" }, { title: "写", output: "data/x.jsonl" }, { title: "错", skill: "nope" }] },
      }),
    );
    const scanned = await scanPlugin(dir, "lit");
    assert.deepEqual(scanned.workflow.map((step) => [step.title, step.skillSlug]), [["扫", "lit-scan"], ["写", null], ["错", null]]);
    assert.deepEqual(scanned.problems, []);
    assert.deepEqual(scanned.unsupported, []);
  });

  test("workflow 写坏的一步进 problems（workflow-invalid），其余步骤与技能照常", async () => {
    await put("skills/a/SKILL.md", SKILL("a"));
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", orbita: { workflow: [{ skill: "a" }, { title: "好", skill: "a" }] } }));
    const scanned = await scanPlugin(dir, "p");
    assert.deepEqual(scanned.workflow.map((step) => step.title), ["好"]);
    assert.deepEqual(scanned.problems, [{ kind: "workflow-invalid", detail: "orbita.workflow[0]: title is required" }]);
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["a"]);
  });

  test("orbita 下除 workflow / panel 之外的子键列进「暂不支持」", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", orbita: { workflow: [], panel: { title: "x" }, automation: {}, agents: [] } }));
    const scanned = await scanPlugin(dir, "p");
    assert.deepEqual(scanned.unsupported, [{ kind: "orbita", items: ["automation", "agents"], count: 2 }]);
  });

  test("只有 workflow / panel 时不出「暂不支持」；没有 orbita 时 workflow 为空数组", async () => {
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p", orbita: { panel: { title: "x" } } }));
    assert.deepEqual((await scanPlugin(dir, "p")).unsupported, []);
    await put(".claude-plugin/plugin.json", JSON.stringify({ name: "p" }));
    assert.deepEqual((await scanPlugin(dir, "p")).workflow, []);
  });
});
