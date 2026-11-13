import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "../../shared/mcp.ts";
import { runConfigImport, scanConfig, type ConfigImportDeps } from "./config-import.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-config-import-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skill(dir: string, slug: string): Promise<void> {
  await mkdir(join(dir, slug), { recursive: true });
  await writeFile(join(dir, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: d\n---\nbody\n`);
}

function deps(over: Partial<ConfigImportDeps> = {}): ConfigImportDeps {
  return {
    promaRoots: [],
    claudeCode: [{ skillsDir: join(root, ".claude", "skills"), claudeJson: join(root, ".claude.json") }],
    kimiCode: [],
    opencode: [],
    agentSkillsDir: join(root, ".agents", "skills"),
    existingSkills: [],
    existingMcp: [],
    ...over,
  };
}

describe("技能与 MCP 的导入（聊天记录不在这里）", () => {
  test("扫描：按来源读技能目录与 MCP 配置；重名先到先得；没勾的来源不读", async () => {
    await skill(join(root, ".agents", "skills"), "docx");
    await skill(join(root, ".claude", "skills"), "docx");
    await skill(join(root, ".claude", "skills"), "tdd");
    await writeFile(join(root, ".claude.json"), JSON.stringify({ mcpServers: { miyo: { command: "miyo", args: [] } } }));

    const { report, mcpServers } = await scanConfig(deps({ existingSkills: ["tdd"] }), ["agent-skills", "claude-code"]);
    const statuses = report.skills.flatMap((group) => group.skills.map((item) => `${group.source}:${item.slug}:${item.status}`));
    assert.deepEqual(statuses, ["agent-skills:docx:new", "claude-code:docx:duplicate", "claude-code:tdd:in-orbita"]);
    assert.deepEqual(report.mcp.map((item) => [item.name, item.status]), [["miyo", "new"]]);
    assert.ok(mcpServers.has("miyo"));

    const onlyShared = await scanConfig(deps(), ["agent-skills"]);
    assert.deepEqual(onlyShared.report.mcp, []);
    assert.equal(onlyShared.report.skills.length, 1);
  });

  test("执行：只落勾选的技能与 MCP（MCP 停用），别的什么都不写", async () => {
    await skill(join(root, ".agents", "skills"), "docx");
    await skill(join(root, ".agents", "skills"), "pptx");
    await writeFile(join(root, ".claude.json"), JSON.stringify({ mcpServers: { miyo: { command: "miyo", args: [] }, other: { command: "x", args: [] } } }));
    const copied: string[] = [];
    const added: [string, McpServer][] = [];
    let reloads = 0;
    const before = await readdir(root);
    const result = await runConfigImport(
      deps(),
      {
        skillTarget: {
          copyFrom: async (dir) => {
            copied.push(dir);
            return "slug";
          },
          importFrom: async () => {
            throw new Error("link not chosen");
          },
        },
        mcpTarget: {
          add: async (name, server) => {
            added.push([name, server]);
          },
          reload: async () => {
            reloads += 1;
          },
        },
        workspaceIds: new Set(),
      },
      {
        sources: ["agent-skills", "claude-code"],
        skills: [join(root, ".agents", "skills", "docx")],
        skillMode: "copy",
        skillScopes: [],
        mcp: ["miyo"],
      },
    );
    assert.deepEqual(result, { skillsImported: 1, skillsFailed: [], mcpImported: 1, mcpFailed: [] });
    assert.deepEqual(copied, [join(root, ".agents", "skills", "docx")]);
    assert.deepEqual(added.map(([name, server]) => [name, server.disabled]), [["miyo", true]]);
    assert.equal(reloads, 1);
    // 源目录没多出任何文件（没有会话副本、没有导入清单）
    assert.deepEqual(await readdir(root), before);
  });
});
