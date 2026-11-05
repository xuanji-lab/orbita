import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginConflict, PluginMcpProblem, PluginPreviewError, PluginProblem } from "../../../../shared/plugin.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { conflictText, mcpProblemText, previewErrorText, problemText, rowFailureText, rowMode, rowReasonText, rowScopeText, rowSkillsText } from "./plugin-text.ts";

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

describe("对话里「装上插件」那一行的文字", () => {
  test("rowMode：此刻的已装列表说了算；没读到时按落盘时的样子；装上过又卸载了 = uninstalled", () => {
    assert.equal(rowMode({ state: "pending" }, true), "installed");
    assert.equal(rowMode({ state: "installed" }, true), "installed");
    assert.equal(rowMode({ state: "pending" }, false), "pending");
    assert.equal(rowMode({ state: "installed" }, false), "uninstalled");
    assert.equal(rowMode({ state: "pending" }, undefined), "pending");
    assert.equal(rowMode({ state: "installed" }, undefined), "installed");
  });

  test("技能数 / 范围 / 为什么没直接装：中英两张表都说得出，且带上名字", () => {
    for (const table of [zh.plugins.row, en.plugins.row]) {
      assert.notEqual(rowSkillsText(table, { skills: ["a", "b"] }), "");
      assert.equal(rowSkillsText(table, { skills: [] }), "");
      assert.equal(rowScopeText(table, { scope: "workspace", workspaceName: "文献组" }).includes("文献组"), true);
      assert.equal(rowScopeText(table, { scope: "workspace", workspaceName: null }), "");
      assert.notEqual(rowScopeText(table, { scope: "global", workspaceName: null }), "");
      for (const reason of ["mcp", "global", "manual"] as const) assert.notEqual(rowReasonText(table, { reason }), "");
      assert.equal(rowReasonText(table, { reason: null }), "");
    }
    assert.equal(rowSkillsText(zh.plugins.row, { skills: ["a", "b"] }), "2 个技能");
    assert.equal(rowSkillsText(en.plugins.row, { skills: ["a"] }), "1 skill");
  });

  test("点「安装」没成的每个原因都有话说；invalid / failed 把细节带进去", () => {
    const reasons = ["disabled", "no-session", "not-found", "changed", "invalid", "failed"] as const;
    for (const table of [zh.plugins.row, en.plugins.row]) {
      for (const reason of reasons) assert.notEqual(rowFailureText(table, reason, "DETAIL"), "");
      assert.equal(rowFailureText(table, "invalid", "DETAIL").includes("DETAIL"), true);
      assert.equal(rowFailureText(table, "failed", "DETAIL").includes("DETAIL"), true);
    }
  });
});
