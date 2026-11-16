/**
 * 璇玑自写的基底系统提示与它读的资源（项目说明、技能、settings.json）。
 * 在一个空的 pi 配置目录下跑（PI_CODING_AGENT_DIR 指向临时目录），不读用户真实的 ~/.pi。
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBasePrompt, loadoutOrder, loadPiResources, loadProjectContextFiles, readPiSettings } from "./kernel-prompt.ts";
import { ENABLED_BUILTIN_TOOLS } from "./permission.ts";
import { RequestBroker } from "./request-broker.ts";
import { createTurnTools, turnToolFlags, type TurnInput } from "./turn-tools.ts";

let root = "";
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
before(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-kernel-prompt-"));
  await mkdir(join(root, "agent"), { recursive: true });
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
});
after(async () => {
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

function command(cwd: string, skillsDir: string): TurnInput {
  return {
    type: "submit",
    sessionId: "s1",
    text: "hi",
    cwd,
    workspaceId: null,
    provider: { id: "p", api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "k" } as Extract<TurnInput, { type: "submit" }>["provider"],
    modelId: "m",
    thinkingLevel: "off",
    piSessionDir: join(cwd, ".pi"),
    attachmentsDir: join(cwd, ".att"),
    protectedPaths: [],
    protectedFiles: [],
    skillsDirs: [skillsDir],
    mcpServers: {},
    sessionMemory: true,
    automationTools: true,
  };
}

describe("kernel-prompt：璇玑自写的基底", () => {
  it("段的结构、四个内建工具的简介与规则、项目说明、技能索引、cwd", async () => {
    const cwd = join(root, "ws");
    const skillsDir = join(root, "skills");
    await mkdir(join(skillsDir, "demo"), { recursive: true });
    await writeFile(join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: >-\n  演示技能，\n  测提示词用\n---\n正文\n");
    await mkdir(join(skillsDir, "hidden"), { recursive: true });
    await writeFile(join(skillsDir, "hidden", "SKILL.md"), "---\nname: hidden\ndescription: 只能点名\ndisable-model-invocation: true\n---\n");
    await mkdir(join(skillsDir, "nodesc"), { recursive: true });
    await writeFile(join(skillsDir, "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "外层说明\n");
    await writeFile(join(cwd, "AGENTS.md"), "\ufeff# 项目说明\n先跑测试再提交。\n");
    const turn = command(cwd, skillsDir);
    const custom = createTurnTools({
      command: turn,
      flags: turnToolFlags(turn),
      broker: new RequestBroker(() => undefined),
      mcpTools: [],
      planOptions: { branch: () => [], state: { stopping: false } },
      branch: () => [],
      attachedImages: () => [],
      memoryTurn: () => 1,
    });
    const resources = await loadPiResources({ cwd, skillsDirs: [skillsDir], resolveShellPath: () => undefined });
    const order = loadoutOrder([], [...ENABLED_BUILTIN_TOOLS, ...custom.map((definition) => definition.name)]);
    const prompt = resources.basePrompt(order, custom);

    const sections = [...prompt.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]);
    assert.deepEqual(sections, ["tools", "rules", "project_context", "skills", "available_skills", "cwd"]);
    assert.ok(prompt.startsWith("You are a coding assistant running inside Orbita"));
    for (const name of ["bash", "read", "edit", "write"]) assert.match(prompt, new RegExp(`^- ${name}: `, "m"), `${name} 有一行简介`);
    assert.match(prompt, /^- update_plan: /m, "璇玑自己工具的简介照旧");
    assert.match(prompt, /not cat, head or sed/);
    assert.match(prompt, /give all changes to one file in a single call/);
    assert.match(prompt, /Use write only to create a new file or to rewrite a whole file/);
    assert.match(prompt, /Do not run `grep -r` or `find` over a whole directory/);
    assert.match(prompt, /PI_SESSION_ID, PI_PROVIDER, PI_MODEL and PI_REASONING_LEVEL/);
    assert.match(prompt, /- Be concise in your final answers\./);
    assert.doesNotMatch(prompt, /Pi documentation|<docs>|running inside pi/);
    // 项目说明：外层在前、BOM 去掉
    assert.ok(prompt.indexOf("外层说明") < prompt.indexOf("先跑测试再提交"));
    assert.match(prompt, /<project_instructions path="[^"]+AGENTS\.md">\n# 项目说明/);
    // 技能：多行 YAML 描述读得出；disable-model-invocation 不进索引；没有描述的不算技能
    assert.match(prompt, /<description>演示技能， 测提示词用<\/description>/);
    assert.doesNotMatch(prompt, /<name>hidden<\/name>|<name>nodesc<\/name>/);
    assert.match(prompt, /read it with the read tool/);
    assert.ok(prompt.endsWith(`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`));
    assert.deepEqual(resources.skills.map((skill) => skill.name), ["demo", "hidden"]);
  });

  it("没有 read 时技能用 bash 读；没有 bash 时不出搜索与环境变量两条规则", () => {
    const base = { cwd: "/w", definitions: [], contextFiles: [], skills: [{ name: "s", description: "d", filePath: "/s/SKILL.md", hidden: false }] };
    const bashOnly = buildBasePrompt({ ...base, selectedTools: ["bash"] });
    assert.match(bashOnly, /read it with bash/);
    assert.doesNotMatch(bashOnly, /not cat, head or sed/);
    const readOnly = buildBasePrompt({ ...base, selectedTools: ["read"] });
    assert.doesNotMatch(readOnly, /rg \(file contents\)|PI_SESSION_ID/);
    const none = buildBasePrompt({ ...base, selectedTools: [] });
    assert.doesNotMatch(none, /<skills>/);
    assert.match(none, /<tools>\n\(none\)/);
  });

  it("嵌在主仓里的 worktree 不重复读主仓的 AGENTS.md；兄弟 worktree 照常向上找", async () => {
    const main = join(root, "repo");
    const wt = join(main, ".worktrees", "x");
    await mkdir(join(main, ".git", "worktrees", "x"), { recursive: true });
    await writeFile(join(main, ".git", "worktrees", "x", "commondir"), "../..\n");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "x")}\n`);
    await writeFile(join(main, "AGENTS.md"), "主仓说明\n");
    await writeFile(join(wt, "AGENTS.md"), "worktree 说明\n");
    const files = loadProjectContextFiles(wt).map((file) => file.content);
    assert.ok(files.includes("worktree 说明\n"));
    assert.ok(!files.includes("主仓说明\n"), "主仓那份被 worktree 自己那份遮住");
    const plain = loadProjectContextFiles(join(main, "sub-not-worktree"));
    assert.ok(plain.some((file) => file.content === "主仓说明\n"));
  });

  it("settings.json 只读用到的几项，坏文件按缺省", async () => {
    const dir = join(root, "settings-agent");
    await mkdir(dir, { recursive: true });
    assert.equal(readPiSettings(dir).autoResizeImages, true, "没有文件：缺省");
    await writeFile(join(dir, "settings.json"), "{ 坏");
    assert.equal(readPiSettings(dir).retry.maxRetryDelayMs, 60_000);
    await writeFile(join(dir, "settings.json"), JSON.stringify({ images: { autoResize: false }, shellCommandPrefix: "set -e", httpIdleTimeoutMs: "disabled", retry: { provider: { maxRetries: 2 } }, enableInstallTelemetry: false }));
    const settings = readPiSettings(dir);
    assert.equal(settings.autoResizeImages, false);
    assert.equal(settings.shellCommandPrefix, "set -e");
    assert.equal(settings.httpIdleTimeoutMs, 0);
    assert.equal(settings.retry.maxRetries, 2);
    assert.equal(settings.enableInstallTelemetry, false);
  });

  it("loadoutOrder：已在的保持原位，新出现的接在后面，消失的去掉", () => {
    assert.deepEqual(loadoutOrder(["b", "x", "a"], ["a", "b", "c"]), ["b", "a", "c"]);
    assert.deepEqual(loadoutOrder([], ["a", "b"]), ["a", "b"]);
  });
});
