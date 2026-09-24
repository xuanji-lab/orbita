import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "../../shared/mcp.ts";
import { importMcpServers, mergeMcpEntries, readClaudeCodeMcp, readPromaMcp, toOrbitaServer } from "./import.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-mcp-import-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("toOrbitaServer", () => {
  test("stdio / http 两种形状；缺 type 按有无 command 判；SSE 与缺字段给出原因", () => {
    assert.deepEqual(toOrbitaServer({ type: "stdio", command: "miyo", args: ["mcp"], env: { K: "v" }, enabled: true }), {
      transport: "stdio",
      command: "miyo",
      args: ["mcp"],
      env: { K: "v" },
    });
    assert.deepEqual(toOrbitaServer({ command: "npx", args: [] }), { transport: "stdio", command: "npx" });
    assert.deepEqual(toOrbitaServer({ type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer k" } }), {
      transport: "http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer k" },
    });
    assert.deepEqual(toOrbitaServer({ url: "https://y/mcp" }), { transport: "http", url: "https://y/mcp" });
    assert.equal(toOrbitaServer({ type: "sse", url: "https://z/sse" }), "SSE transport isn't supported here");
    assert.equal(toOrbitaServer({ type: "stdio" }), "no command");
    assert.equal(toOrbitaServer("x"), "not a server entry");
  });
});

describe("读各家配置并按名字归并", () => {
  test("Proma 各工作区 → Claude Code 全局 → 项目；同名取先到的，出处都列上；已有的与转不了的标出来", async () => {
    const promaRoot = join(root, "proma");
    await mkdir(join(promaRoot, "agent-workspaces", "default"), { recursive: true });
    await writeFile(
      join(promaRoot, "agent-workspaces", "default", "mcp.json"),
      JSON.stringify({
        servers: {
          "web-search-prime": { type: "http", url: "https://proma/search", headers: { Authorization: "k" } },
          miyo: { type: "stdio", command: "/bin/miyo", args: ["mcp"] },
          legacy: { type: "sse", url: "https://old/sse" },
        },
      }),
    );
    const claudeJson = join(root, "claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        mcpServers: { "web-search-prime": { type: "http", url: "https://claude/search" } },
        projects: { "/repo/app": { mcpServers: { context7: { type: "http", url: "https://context7/mcp" } } }, "/repo/b": {} },
        otherStuff: { history: ["secret"] },
      }),
    );
    const entries = [
      ...(await readPromaMcp(promaRoot, [{ slug: "default", name: "默认工作区" }])),
      ...(await readClaudeCodeMcp(claudeJson)),
    ];
    const { items, servers } = mergeMcpEntries(entries, new Set(["miyo"]));
    assert.deepEqual(
      items.map((item) => [item.name, item.status, item.transport, item.carriesSecrets]),
      [
        ["context7", "new", "http", false],
        ["legacy", "unsupported", "stdio", false],
        ["miyo", "in-orbita", "stdio", false],
        ["web-search-prime", "new", "http", true],
      ],
    );
    assert.deepEqual(items.find((item) => item.name === "web-search-prime")?.origins, [
      { source: "proma", where: "默认工作区" },
      { source: "claude-code", where: null },
    ]);
    assert.deepEqual(items.find((item) => item.name === "context7")?.origins, [{ source: "claude-code", where: "/repo/app" }]);
    assert.equal(items.find((item) => item.name === "legacy")?.reason, "SSE transport isn't supported here");
    assert.deepEqual([...servers.keys()].sort(), ["context7", "web-search-prime"]);
    assert.deepEqual(servers.get("web-search-prime"), {
      transport: "http",
      url: "https://proma/search",
      headers: { Authorization: "k" },
    });
  });

  test("配置文件不在或坏了：这个来源没有 MCP，不抛", async () => {
    assert.deepEqual(await readClaudeCodeMcp(join(root, "nope.json")), []);
    await writeFile(join(root, "bad.json"), "{");
    assert.deepEqual(await readClaudeCodeMcp(join(root, "bad.json")), []);
  });
});

describe("importMcpServers", () => {
  test("只导勾选的，一律停用；单台失败继续；导了才 reload", async () => {
    const added: [string, McpServer][] = [];
    let reloads = 0;
    const target = {
      add: async (name: string, server: McpServer) => {
        if (name === "taken") throw new Error(`A server named "${name}" already exists`);
        added.push([name, server]);
      },
      reload: async () => {
        reloads += 1;
      },
    };
    const servers = new Map<string, McpServer>([
      ["a", { transport: "stdio", command: "a" }],
      ["taken", { transport: "stdio", command: "t" }],
      ["b", { transport: "http", url: "https://b" }],
    ]);
    const result = await importMcpServers(servers, new Set(["a", "taken"]), target);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.failed.map((item) => item.name), ["taken"]);
    assert.deepEqual(added, [["a", { transport: "stdio", command: "a", disabled: true }]]);
    assert.equal(reloads, 1);
    await importMcpServers(servers, new Set(), target);
    assert.equal(reloads, 1);
  });
});
