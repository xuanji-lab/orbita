import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { turnCapabilities } from "./turn-capabilities.ts";

const assembly = {
  skills: [
    { slug: "board", name: "Board", file: "/p/board/SKILL.md", plugin: "atlas" },
    { slug: "other", name: "Other", file: "/p/other/SKILL.md", plugin: "else" },
  ],
  mcpServers: { plugin_atlas_graph: { command: "x" }, plugin_else_y: { command: "y" }, zotero: { command: "z" } },
} as unknown as Parameters<typeof turnCapabilities>[1];

describe("开轮命令里的能力集", () => {
  test("缺席（全带）原样缺席：命令里不出现这个键", () => {
    assert.deepEqual(turnCapabilities(undefined, assembly), {});
  });
  test("没有 plugin: 的原样带过去（含空数组与纯聊天）", () => {
    assert.deepEqual(turnCapabilities([], assembly), { capabilities: [] });
    assert.deepEqual(turnCapabilities(["none"], assembly), { capabilities: ["none"] });
    assert.deepEqual(turnCapabilities(["browser", "mcp:zotero"], assembly), { capabilities: ["browser", "mcp:zotero"] });
  });
  test("plugin: 展开成它带的技能与 MCP，只认那一个插件的，结果去重排序", () => {
    assert.deepEqual(turnCapabilities(["browser", "plugin:atlas", "skill:board"], assembly), {
      capabilities: ["browser", "mcp:plugin_atlas_graph", "skill:board"],
    });
  });
});
