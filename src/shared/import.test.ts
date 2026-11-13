import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isCustomRootSource,
  parseImportCustomRootInput,
  parseImportRunInput,
  parseImportScanInput,
} from "./import.ts";

describe("parseImportScanInput", () => {
  test("认识的来源原样通过，重复的去重", () => {
    assert.deepEqual(parseImportScanInput({ sources: ["proma", "proma"] }), { sources: ["proma"] });
    assert.deepEqual(parseImportScanInput({ sources: ["claude-code", "proma"] }), {
      sources: ["claude-code", "proma"],
    });
  });

  test("契约里的八个来源都认（含只有技能的 agent-skills）", () => {
    const all = ["proma", "claude-code", "kimi-code", "opencode", "reasonix", "zcode", "codex", "agent-skills"];
    assert.deepEqual(parseImportScanInput({ sources: all }).sources, all);
  });

  test("空来源合法（什么都不读）", () => {
    assert.deepEqual(parseImportScanInput({ sources: [] }), { sources: [] });
  });

  test("不认识的来源 / 坏形状整体拒绝", () => {
    assert.throws(() => parseImportScanInput({ sources: ["cursor"] }), /unknown import source/);
    assert.throws(() => parseImportScanInput({ sources: "proma" }), /array/);
    assert.throws(() => parseImportScanInput(null), /object/);
  });
});

describe("parseImportCustomRootInput", () => {
  test("认识的来源 + 非空路径原样通过（空白会被 trim）", () => {
    assert.deepEqual(parseImportCustomRootInput({ source: "proma", dir: "  ~/.proma-dev  " }), {
      source: "proma",
      dir: "~/.proma-dev",
    });
  });

  test("isCustomRootSource 只认有定位规格的来源（agent-skills 不支持自定义路径）", () => {
    assert.equal(isCustomRootSource("proma"), true);
    assert.equal(isCustomRootSource("codex"), true);
    assert.equal(isCustomRootSource("agent-skills"), false);
    assert.equal(isCustomRootSource("cursor"), false);
    assert.equal(isCustomRootSource(1), false);
  });

  test("不认识的来源 / agent-skills / 空路径 / 坏形状整体拒绝", () => {
    assert.throws(() => parseImportCustomRootInput({ source: "cursor", dir: "/x" }), /unknown import source/);
    assert.throws(() => parseImportCustomRootInput({ source: "agent-skills", dir: "/x" }), /unknown import source/);
    assert.throws(() => parseImportCustomRootInput({ source: "proma", dir: "" }), /non-empty/);
    assert.throws(() => parseImportCustomRootInput({ source: "proma", dir: "   " }), /non-empty/);
    assert.throws(() => parseImportCustomRootInput({ source: "proma" }), /non-empty/);
    assert.throws(() => parseImportCustomRootInput(null), /object/);
  });
});

describe("parseImportRunInput", () => {
  test("技能、作用域与 MCP 原样通过并去重；聊天记录的字段不再收", () => {
    const input = parseImportRunInput({
      sources: ["proma"],
      sessions: ["/a.jsonl"],
      skills: ["/s/a", "/s/a"],
      skillMode: "link",
      mcp: ["miyo", "miyo"],
      skillScopes: [
        { dir: "/s", scope: { kind: "off" } },
        { dir: "/t", scope: { kind: "workspace", workspaceId: "w-1" } },
      ],
    });
    assert.deepEqual(input, {
      sources: ["proma"],
      skills: ["/s/a"],
      skillMode: "link",
      mcp: ["miyo"],
      skillScopes: [
        { dir: "/s", scope: { kind: "off" } },
        { dir: "/t", scope: { kind: "workspace", workspaceId: "w-1" } },
      ],
    });
  });

  test("坏形状整体拒绝", () => {
    const base = { sources: ["agent-skills"], skills: [], skillMode: "copy", skillScopes: [], mcp: [] };
    assert.doesNotThrow(() => parseImportRunInput(base));
    assert.throws(() => parseImportRunInput({ ...base, sources: ["kimi"] }), /unknown import source/);
    assert.throws(() => parseImportRunInput({ ...base, skillMode: "move" }), /copy or link/);
    assert.throws(() => parseImportRunInput({ ...base, mcp: [{}] }), /server names/);
    assert.throws(() => parseImportRunInput({ ...base, skills: [1] }), /array of folders/);
    assert.throws(() => parseImportRunInput({ ...base, skillScopes: [{ dir: "/s", scope: { kind: "workspace" } }] }), /bad skill scope/);
    assert.throws(() => parseImportRunInput({ ...base, skillScopes: [{ dir: "", scope: { kind: "off" } }] }), /name a folder/);
  });
});
