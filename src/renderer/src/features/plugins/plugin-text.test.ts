import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginConflict, PluginMcpProblem, PluginPreviewError, PluginProblem } from "../../../../shared/plugin.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { conflictText, mcpProblemText, previewErrorText, problemText } from "./plugin-text.ts";

const CONFLICTS: PluginConflict[] = [
  { kind: "skill-name", skill: "pdf", with: { origin: "user-skill", name: "pdf-mine" } },
  { kind: "skill-name", skill: "pdf", with: { origin: "plugin", name: "docs" } },
  { kind: "skill-duplicate", skill: "pdf" },
  { kind: "plugin-exists", name: "docs" },
  { kind: "mcp-name", server: "s", qualified: "plugin_a_s", with: "other" },
];
const PROBLEMS: PluginProblem[] = (
  ["manifest-unreadable", "manifest-invalid", "path-escape", "path-missing", "skill-unreadable", "skill-no-description", "config-key-invalid", "mcp-unreadable", "root-missing"] as const
).map((kind) => ({ kind, detail: "DETAIL" }));
const MCP_PROBLEMS: PluginMcpProblem[] = [
  { kind: "unknown-variable", variable: "ZCODE_BASE_URL" },
  { kind: "config-missing", key: "api_key" },
  { kind: "invalid", reason: "unsupported-shape" },
  { kind: "command-missing", command: "/x/y" },
];
const ERRORS: (PluginPreviewError | { kind: "stale-preview" })[] = [
  { kind: "not-a-plugin" },
  { kind: "invalid-name", name: "Bad Name" },
  { kind: "git-url-rejected", url: "http://x" },
  { kind: "git-failed", message: "fatal: nope" },
  { kind: "git-failed", message: "timeout" },
  { kind: "too-large" },
  { kind: "symlink-escape", paths: ["a", "b", "c", "d"] },
  { kind: "read-failed", message: "ENOENT" },
  { kind: "stale-preview" },
];

describe("plugin-text", () => {
  test("每种冲突、问题、错误在中英两张表里都说得出话，且把关键信息带进句子", () => {
    for (const table of [en.plugins, zh.plugins]) {
      for (const c of CONFLICTS) assert.notEqual(conflictText(table, c), "");
      for (const p of PROBLEMS) assert.equal(problemText(table, p).includes("DETAIL"), true);
      for (const p of MCP_PROBLEMS) assert.notEqual(mcpProblemText(table, p), "");
      for (const e of ERRORS) assert.notEqual(previewErrorText(table, e), "");
    }
  });

  test("冲突句子指出撞的是谁（给用户去哪改的线索）", () => {
    assert.equal(conflictText(en.plugins, CONFLICTS[0] as PluginConflict).includes("pdf-mine"), true);
    assert.equal(conflictText(en.plugins, CONFLICTS[1] as PluginConflict).includes("docs"), true);
    assert.equal(conflictText(zh.plugins, CONFLICTS[0] as PluginConflict).includes("技能"), true);
  });

  test("git 超时单独一句；符号链接只列前三条路径", () => {
    assert.equal(previewErrorText(en.plugins, { kind: "git-failed", message: "timeout" }), en.plugins.install.error.gitTimeout);
    const text = previewErrorText(en.plugins, { kind: "symlink-escape", paths: ["a", "b", "c", "d"] });
    assert.equal(text.includes("a, b, c"), true);
    assert.equal(text.includes(", d"), false);
  });
});
