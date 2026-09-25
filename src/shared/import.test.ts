import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isImportSourceId, parseImportRunInput, parseImportScanInput } from "./import.ts";

describe("parseImportScanInput", () => {
  test("认识的来源原样通过，重复的去重", () => {
    assert.deepEqual(parseImportScanInput({ sources: ["proma", "proma"] }), { sources: ["proma"] });
    assert.deepEqual(parseImportScanInput({ sources: ["claude-code", "proma"] }), {
      sources: ["claude-code", "proma"],
    });
  });

  test("isImportSourceId 只认契约里的来源", () => {
    assert.equal(isImportSourceId("claude-code"), true);
    assert.equal(isImportSourceId("proma"), true);
    assert.equal(isImportSourceId("codex"), false);
    assert.equal(isImportSourceId(1), false);
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

describe("parseImportRunInput", () => {
  test("三种去向与 null 文件夹都能过；会话去重", () => {
    const input = parseImportRunInput({
      sources: ["proma"],
      sessions: ["/a.jsonl", "/a.jsonl", "/b.jsonl"],
      destinations: [
        { folder: null, destination: { kind: "tasks" } },
        { folder: "/repo/x", destination: { kind: "workspace", workspaceId: "w-1" } },
        { folder: "/repo/y", destination: { kind: "new-workspace" } },
      ],
      skills: ["/s/a", "/s/a"],
      skillMode: "link",
      mcp: ["miyo", "miyo"],
      skillScopes: [
        { dir: "/s", scope: { kind: "off" } },
        { dir: "/t", scope: { kind: "workspace", workspaceId: "w-1" } },
      ],
    });
    assert.deepEqual(input.sessions, ["/a.jsonl", "/b.jsonl"]);
    assert.deepEqual(input.skills, ["/s/a"]);
    assert.equal(input.skillMode, "link");
    assert.deepEqual(input.mcp, ["miyo"]);
    assert.deepEqual(input.skillScopes[1], { dir: "/t", scope: { kind: "workspace", workspaceId: "w-1" } });
    assert.equal(input.destinations.length, 3);
    assert.deepEqual(input.destinations[1], { folder: "/repo/x", destination: { kind: "workspace", workspaceId: "w-1" } });
  });

  test("坏去向、空文件夹串、非字符串会话都整体拒绝", () => {
    const base = { sources: ["proma"], sessions: [], destinations: [], skills: [], skillMode: "copy", skillScopes: [], mcp: [] };
    assert.throws(() => parseImportRunInput({ ...base, destinations: [{ folder: "/x", destination: { kind: "workspace" } }] }), /bad destination/);
    assert.throws(() => parseImportRunInput({ ...base, destinations: [{ folder: "", destination: { kind: "tasks" } }] }), /bad folder/);
    assert.throws(() => parseImportRunInput({ ...base, sessions: [1] }), /source files/);
    assert.throws(() => parseImportRunInput({ ...base, sources: ["kimi"] }), /unknown import source/);
  });

  test("skills 的坏形状整体拒绝", () => {
    const base = { sources: ["agent-skills"], sessions: [], destinations: [], skills: [], skillMode: "copy", skillScopes: [], mcp: [] };
    assert.doesNotThrow(() => parseImportRunInput(base));
    assert.throws(() => parseImportRunInput({ ...base, skillMode: "move" }), /copy or link/);
    assert.throws(() => parseImportRunInput({ ...base, mcp: [{}] }), /server names/);
    assert.throws(() => parseImportRunInput({ ...base, skills: [1] }), /array of folders/);
    assert.throws(() => parseImportRunInput({ ...base, skillScopes: [{ dir: "/s", scope: { kind: "workspace" } }] }), /bad skill scope/);
    assert.throws(() => parseImportRunInput({ ...base, skillScopes: [{ dir: "", scope: { kind: "off" } }] }), /name a folder/);
  });
});
