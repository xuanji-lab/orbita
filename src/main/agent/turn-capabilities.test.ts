import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { turnCapabilities } from "./turn-capabilities.ts";

const assembly = {
  skills: [
    { slug: "board", name: "Board", file: "/p/board/SKILL.md", plugin: "atlas" },
    { slug: "other", name: "Other", file: "/p/other/SKILL.md", plugin: "else" },
    { slug: "browser", name: "browser", file: "/b/browser/skills/browser/SKILL.md", plugin: "browser" },
    { slug: "reading", name: "reading", file: "/b/reading/skills/reading/SKILL.md", plugin: "reading" },
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
    assert.deepEqual(turnCapabilities(["image", "mcp:zotero"], assembly), { capabilities: ["image", "mcp:zotero"] });
  });
  test("plugin: 展开成它带的技能与 MCP，只认那一个插件的，结果去重排序", () => {
    assert.deepEqual(turnCapabilities(["browser", "plugin:atlas", "skill:board"], assembly), {
      capabilities: ["browser", "mcp:plugin_atlas_graph", "skill:board", "skill:browser"],
    });
  });
  test("带了模块就带上内置插件里讲它怎么用的技能（浏览器 → browser，读 PDF → reading）；没带的模块不带", () => {
    assert.deepEqual(turnCapabilities(["pdf-docx", "browser"], assembly), { capabilities: ["pdf-docx", "browser", "skill:browser", "skill:reading"] });
    assert.deepEqual(turnCapabilities(["terminal"], assembly), { capabilities: ["terminal"] });
  });
});
