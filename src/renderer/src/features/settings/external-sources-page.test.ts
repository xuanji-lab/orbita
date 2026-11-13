import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExternalSourceInfo } from "@shared/external-sources";
import type { ImportRunReport } from "@shared/import";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
  doneFacts,
  doneHeadline,
  footFacts,
  headline,
  noneFound,
  runningHeadline,
  sourceRowState,
  stepStates,
  switchesAfter,
} from "./external-sources-page.ts";

const source = (id: ExternalSourceInfo["id"], over: Partial<ExternalSourceInfo> = {}): ExternalSourceInfo => ({
  id,
  roots: [{ dir: `/home/me/.${id}`, custom: false, hasData: true }],
  expected: `/home/me/.${id}`,
  sessions: 3,
  enabled: true,
  problems: [],
  ...over,
});

const report = (over: Partial<ImportRunReport> = {}): ImportRunReport => ({
  skillsImported: 0,
  skillsFailed: [],
  mcpImported: 0,
  mcpFailed: [],
  ...over,
});

describe("外部来源页", () => {
  test("步骤：列出来源即打勾；扫描前技能是当前步；扫出来没东西的段直接打勾；导入后全勾", () => {
    assert.deepEqual(stepStates({ listed: false, scanned: false, imported: false, hasSkills: false, hasMcp: false }), {
      sources: "current",
      skills: "current",
      mcp: "pending",
      import: "pending",
    });
    assert.deepEqual(stepStates({ listed: true, scanned: true, imported: false, hasSkills: true, hasMcp: false }), {
      sources: "done",
      skills: "current",
      mcp: "done",
      import: "current",
    });
    assert.equal(stepStates({ listed: true, scanned: true, imported: true, hasSkills: true, hasMcp: true }).import, "done");
  });

  test("来源行：没发现 / 发现（关着的照数会话）；一个都没发现出空态", () => {
    assert.deepEqual(sourceRowState(source("codex", { roots: [], sessions: 0 })), { kind: "missing" });
    assert.deepEqual(sourceRowState(source("proma", { enabled: false, sessions: 325 })), { kind: "found", sessions: 325 });
    assert.equal(noneFound([source("codex", { roots: [] }), source("zcode", { roots: [] })]), true);
    assert.equal(noneFound([source("codex", { roots: [] }), source("zcode")]), false);
  });

  test("开关：只翻这一个，其余保持页面上的状态，整张表落设置", () => {
    const sources = [source("claude-code"), source("codex", { enabled: false }), source("proma")];
    assert.deepEqual(switchesAfter(sources, "proma", false), { "claude-code": true, codex: false, proma: false });
  });

  test("底栏只讲技能与 MCP（中英）", () => {
    assert.equal(headline(2, 1, en), "Import 2 skills · 1 MCP server");
    assert.equal(headline(0, 0, en), en.migration.nothingTicked);
    assert.match(headline(2, 0, zh), /2 个技能/);
    assert.match(runningHeadline(1, 1, en), /Importing 1 skill/);
    assert.deepEqual(
      footFacts(2, "link", 1, en).map((fact) => fact.kind),
      ["skills", "mcp"],
    );
    assert.equal(doneHeadline(report({ skillsImported: 2, mcpImported: 1 }), en), "Imported 2 skills · 1 MCP server (off)");
    assert.equal(doneHeadline(report(), en), en.migration.nothingImported);
    assert.equal(doneFacts(report({ skillsFailed: [{ slug: "a", error: "boom" }] }), en)[0]?.tip, "a: boom");
  });
});
