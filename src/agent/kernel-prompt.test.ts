/**
 * 新内核重建的 pi 基础系统提示 == 旧内核里 pi 会话自己算出来的那一份（逐字节）。
 * 两边都在一个空的 pi 配置目录下跑（PI_CODING_AGENT_DIR 指向临时目录），不读用户真实的 ~/.pi。
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { builtinToolDefinitions } from "./durable-tools.ts";
import { loadoutOrder, loadPiResources } from "./kernel-prompt.ts";
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
    mode: "skip",
    thinkingLevel: "off",
    piSessionDir: join(cwd, ".pi"),
    attachmentsDir: join(cwd, ".att"),
    protectedPaths: [],
    skillsDirs: [skillsDir],
    mcpServers: {},
    sessionMemory: true,
    automationTools: true,
  };
}

describe("kernel-prompt：pi 基础系统提示两个内核逐字节相同", () => {
  it("同一组工具、同一份 AGENTS.md 与技能目录下，与 pi 会话的 systemPrompt 相等", async () => {
    const cwd = join(root, "ws");
    const skillsDir = join(root, "skills");
    await mkdir(join(skillsDir, "demo"), { recursive: true });
    await writeFile(join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: 演示技能，测提示词用\n---\n正文\n");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "# 项目说明\n先跑测试再提交。\n");
    const turn = command(cwd, skillsDir);
    const custom = createTurnTools({
      command: turn,
      flags: turnToolFlags(turn),
      broker: new RequestBroker(() => undefined),
      mcpTools: [],
      currentMode: () => "skip",
      planOptions: { getMode: () => "skip", planFirst: false, branch: () => [], state: { stopping: false } },
      branch: () => [],
      attachedImages: () => [],
      memoryTurn: () => 1,
    });

    // 旧内核：与 runtime.ts openTurn 同样的装配（noSkills + additionalSkillPaths、defaultTools 七件、customTools）
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { noSkills: true, additionalSkillPaths: [skillsDir], extensionFactories: [] },
    });
    services.settingsManager.applyOverrides({ defaultTools: [...ENABLED_BUILTIN_TOOLS] });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(cwd, join(root, "pi-sessions")),
      customTools: custom,
    });
    const oldPrompt = session.systemPrompt;
    const oldTools = session.getActiveToolNames();
    session.dispose();

    // 新内核
    const resources = await loadPiResources({ cwd, skillsDirs: [skillsDir], resolveShellPath: () => undefined });
    const definitions = [...builtinToolDefinitions(cwd, resources.builtinOptions), ...custom];
    const order = loadoutOrder([], definitions.map((definition) => definition.name));
    assert.deepEqual(order, oldTools, "全新会话的工具顺序与 pi 的 active 顺序相同");
    const newPrompt = resources.basePrompt(order, definitions);
    assert.match(oldPrompt, /先跑测试再提交/);
    assert.match(oldPrompt, /demo/);
    assert.equal(newPrompt, oldPrompt);
  });

  it("loadoutOrder：已在的保持原位，新出现的接在后面，消失的去掉", () => {
    assert.deepEqual(loadoutOrder(["b", "x", "a"], ["a", "b", "c"]), ["b", "a", "c"]);
    assert.deepEqual(loadoutOrder([], ["a", "b"]), ["a", "b"]);
  });
});
