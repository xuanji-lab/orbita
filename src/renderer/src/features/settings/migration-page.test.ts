import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ImportPlanItem, ImportRunReport, ImportScanReport, ImportSourceProbe } from "../../../../shared/import.ts";
import type { GroupedSessions, ImportSummary } from "./migration-groups.ts";
import {
  changeBadge,
  countLine,
  doneFacts,
  doneHeadline,
  footFacts,
  greetingSteps,
  headline,
  mixedSources,
  modelTip,
  pathGlyph,
  runningHeadline,
  sessionFacts,
  sourcePaths,
  sourceStatus,
  stepStates,
} from "./migration-page.ts";
import type { ProviderDto } from "../../../../shared/provider.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

const NOW = new Date(2026, 8, 25, 12, 0).getTime();

function item(overrides: Partial<ImportPlanItem>): ImportPlanItem {
  return {
    sourceId: "s",
    source: "proma",
    sourceKind: "pi",
    change: "new",
    newMessages: 0,
    folder: null,
    sourceFile: "/proma/s.jsonl",
    title: "session",
    workspaceId: null,
    cwd: "/tmp",
    importedModel: "glm-5.3",
    sessionId: "o",
    parentId: null,
    archived: false,
    pinned: false,
    starred: false,
    createdAt: NOW,
    updatedAt: NOW,
    bytes: 100,
    ...overrides,
  };
}

function probe(id: ImportSourceProbe["id"], paths: string[], found = true): ImportSourceProbe {
  return { id, label: id, kind: "cli", paths, found };
}

function report(overrides: Partial<ImportScanReport>): ImportScanReport {
  return {
    plan: [],
    newWorkspaces: [],
    mergedWorkspaceIds: [],
    skipped: [],
    withoutPiSession: 0,
    totalBytes: 0,
    subSessionCount: 0,
    orphanedSubSessions: 0,
    lastImportAt: null,
    skills: [],
    mcp: [],
    greetingCheck: { candidates: 0, model: null, unavailable: null },
    ...overrides,
  };
}

const EMPTY_GROUPED: GroupedSessions = { groups: [], changed: [], hidden: 0, leftOut: 0, totalBySource: {}, total: 0 };

function summary(overrides: Partial<ImportSummary>): ImportSummary {
  return {
    sessions: 0,
    updates: 0,
    subSessions: 0,
    bytes: 0,
    newWorkspaces: 0,
    ...overrides,
  };
}

function run(overrides: Partial<ImportRunReport>): ImportRunReport {
  return {
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: [],
    createdWorkspaces: [],
    mergedWorkspaceIds: [],
    skillsImported: 0,
    skillsFailed: [],
    mcpImported: 0,
    mcpFailed: [],
    ...overrides,
  };
}

describe("migration-page · 步骤", () => {
  test("扫描前：只有 Sources 是当前步", () => {
    assert.deepEqual(stepStates({ scanned: false, imported: false, hasSessions: true, hasSkills: true, hasMcp: true }), {
      sources: "current",
      sessions: "pending",
      skills: "pending",
      mcp: "pending",
      import: "pending",
    });
  });

  test("扫描后：Sources 打勾，三段同为当前步，没有可导条目的那段打勾", () => {
    assert.deepEqual(stepStates({ scanned: true, imported: false, hasSessions: true, hasSkills: false, hasMcp: true }), {
      sources: "done",
      sessions: "current",
      skills: "done",
      mcp: "current",
      import: "current",
    });
  });

  test("什么都没得导：Import 留在未轮到；导入完成后全部打勾", () => {
    assert.equal(stepStates({ scanned: true, imported: false, hasSessions: false, hasSkills: false, hasMcp: false }).import, "pending");
    const done = stepStates({ scanned: true, imported: true, hasSessions: true, hasSkills: true, hasMcp: true });
    assert.deepEqual(Object.values(done), ["done", "done", "done", "done", "done"]);
  });
});

describe("migration-page · Sources", () => {
  test("路径图标：JSON 文件 / 其他文件 / 目录；点开头的目录不算文件", () => {
    assert.equal(pathGlyph("/Users/me/.proma/agent-sessions.json"), "json");
    assert.equal(pathGlyph("/Users/me/.claude.json"), "json");
    assert.equal(pathGlyph("/Users/me/.config/opencode/opencode.jsonc"), "json");
    assert.equal(pathGlyph("/Users/me/.local/share/opencode/opencode.db"), "file");
    assert.equal(pathGlyph("/Users/me/.claude"), "folder");
    assert.equal(pathGlyph("/Users/me/.proma/agent-workspaces/*/skills"), "folder");
    assert.equal(pathGlyph("/Users/me/.kimi/sessions/"), "folder");
  });

  test("路径清单：只列给定来源的，按来源顺序去重", () => {
    const probes = [probe("proma", ["/a", "/b"]), probe("claude-code", ["/c"]), probe("kimi-code", ["/b", "/d"])];
    assert.deepEqual(sourcePaths(probes, ["kimi-code", "proma"]), ["/a", "/b", "/d"]);
    assert.deepEqual(sourcePaths(probes, []), []);
  });

  test("来源行状态：不在盘上 / 在 / 扫描后才勾的 / 扫过的", () => {
    const counts = { sessions: 3, skills: 0, mcp: 1 };
    assert.deepEqual(sourceStatus(probe("proma", [], false), true, true, null), { kind: "not-found" });
    assert.deepEqual(sourceStatus(probe("proma", []), true, false, null), { kind: "found" });
    assert.deepEqual(sourceStatus(probe("proma", []), false, true, null), { kind: "found" });
    assert.deepEqual(sourceStatus(probe("proma", []), true, true, null), { kind: "not-scanned" });
    assert.deepEqual(sourceStatus(probe("proma", []), true, true, counts), { kind: "scanned", counts });
  });

  test("计数行：是 0 的不写，全 0 为空串", () => {
    assert.equal(countLine({ sessions: 28, skills: 1, mcp: 2 }, en), "28 sessions · 1 skill · 2 MCP");
    assert.equal(countLine({ sessions: 1, skills: 0, mcp: 0 }, en), "1 session");
    assert.equal(countLine({ sessions: 0, skills: 0, mcp: 0 }, en), "");
  });

  test("隐私声明如实写出项目文件夹的存在检查", () => {
    assert.match(en.migration.pathsNote, /only these paths/);
    assert.match(en.migration.pathsNote, /project folder still exists/);
  });
});

describe("migration-page · Sessions", () => {
  test("行内徽标：+N / +N · copy / Deleted here；没导过的没有", () => {
    assert.deepEqual(
      { ...changeBadge(item({ change: "updated", newMessages: 16 }), en), tip: undefined },
      { kind: "updated", text: "+16", tip: undefined },
    );
    assert.match(changeBadge(item({ change: "updated", newMessages: 1, source: "claude-code" }), en)?.tip ?? "", /^1 new message in Claude Code/);
    assert.equal(changeBadge(item({ change: "diverged", newMessages: 3 }), en)?.text, "+3 · copy");
    assert.match(changeBadge(item({ change: "diverged", newMessages: 3 }), en)?.tip ?? "", /not ticked by default/);
    assert.equal(changeBadge(item({ change: "deleted" }), en)?.text, "Deleted here");
    assert.equal(changeBadge(item({ change: "new" }), en), null);
  });

  test("模型悬停：导入的会话不绑定模型，原模型只是记录", () => {
    assert.equal(modelTip(en), en.migration.modelRecordedTip);
    assert.equal(modelTip(zh), zh.migration.modelRecordedTip);
    assert.match(modelTip(en), /pick one when you open them/);
  });

  test("混合来源才在单条行上写来源名", () => {
    assert.equal(mixedSources([item({}), item({})]), false);
    assert.equal(mixedSources([item({}), item({ source: "opencode" })]), true);
  });

  test("事实条：数是 0 的不出现；已导入与导不了分开数", () => {
    assert.deepEqual(sessionFacts(report({}), EMPTY_GROUPED, NOW, en), []);
    const facts = sessionFacts(
      report({
        skipped: [
          { sourceId: "a", title: null, reason: "already-imported" },
          { sourceId: "b", title: null, reason: "already-imported" },
          { sourceId: "c", title: null, reason: "missing-file" },
        ],
        withoutPiSession: 4,
        orphanedSubSessions: 1,
        lastImportAt: new Date(2026, 8, 25, 0, 9).getTime(),
      }),
      { ...EMPTY_GROUPED, hidden: 9, leftOut: 3 },
      NOW, en,
    );
    assert.deepEqual(
      facts.map((fact) => [fact.kind, fact.count, fact.label]),
      [
        ["hidden", 9, "hidden"],
        ["greeting", 3, "only said hi"],
        ["orphaned", 1, "listed on their own"],
        ["already", 2, "already imported"],
        ["cannot", 5, "can't import"],
      ],
    );
    assert.match(facts[3]!.tip, /last import 09-25 00:09$/);
  });
});

describe("migration-page · 底栏", () => {
  test("主句", () => {
    assert.equal(headline(3, 1, 5, 0, en), "Import 3 sessions · 5 skills · update 1 session");
    assert.equal(headline(0, 2, 0, 0, en), "Update 2 sessions");
    assert.equal(headline(0, 0, 0, 1, en), "Import 1 MCP server");
    assert.equal(headline(0, 0, 0, 0, en), "Nothing ticked");
    assert.equal(runningHeadline(3, 1, 0, en), "Importing 3 sessions, 1 skill…");
  });

  test("副行事实：只列有的，skill 方式跟着 Copy / Link", () => {
    assert.deepEqual(footFacts(summary({}), 0, "copy", 0, en), []);
    const facts = footFacts(summary({ sessions: 2, subSessions: 80, newWorkspaces: 1, bytes: 3 * 1024 * 1024 }), 4, "link", 1, en);
    assert.deepEqual(
      facts.map((fact) => [fact.kind, fact.text]),
      [
        ["sub", "80"],
        ["workspaces", "1 new workspace"],
        ["bytes", "3.0 MB"],
        ["skills", "skills linked"],
        ["mcp", "MCP off"],
      ],
    );
    assert.equal(footFacts(summary({ subSessions: 1 }), 0, "copy", 0, en)[0]?.tip, "1 sub-session comes with its parent");
    assert.equal(footFacts(summary({}), 2, "copy", 0, en)[0]?.text, "skills copied");
  });

  test("完成态主句", () => {
    assert.equal(
      doneHeadline(run({ imported: 34, updated: 1, createdWorkspaces: [{ id: "w", name: "w", path: "/w" }], skillsImported: 5, mcpImported: 1 }), en),
      "Imported 34 sessions · 5 skills · 1 MCP server (off) · updated 1 session · 1 new workspace",
    );
    assert.equal(doneHeadline(run({ updated: 2 }), en), "Updated 2 sessions");
    assert.equal(doneHeadline(run({ skillsImported: 1 }), en), "Imported 1 skill");
    assert.equal(doneHeadline(run({}), en), "Nothing imported");
  });

  test("完成态副行：有会话落进来才指侧栏；失败各一项", () => {
    assert.deepEqual(doneFacts(run({ skillsImported: 2 }), en), []);
    const facts = doneFacts(
      run({
        imported: 1,
        failed: [{ sourceId: "x", sessionId: null, error: "EACCES" }],
        skillsFailed: [{ slug: "pdf", error: "taken" }],
        mcpFailed: [{ name: "gh", error: "exists" }],
      }), en,
    );
    assert.deepEqual(
      facts.map((fact) => [fact.kind, fact.text]),
      [
        ["sidebar", "In the sidebar now"],
        ["failed", "1 session failed"],
        ["failed", "1 skill didn't come over"],
        ["failed", "1 MCP server didn't come over"],
      ],
    );
    assert.equal(facts[1]!.tip, "EACCES · import again to retry");
  });
});

describe("migration-page · 中文（小学作业）", () => {
  test("计数用量词，0 项不写", () => {
    assert.equal(countLine({ sessions: 28, skills: 1, mcp: 2 }, zh), "28 个会话 · 1 个技能 · 2 个 MCP");
    assert.equal(countLine({ sessions: 0, skills: 0, mcp: 0 }, zh), "");
  });

  test("底栏主句与执行中：列举用顿号", () => {
    assert.equal(headline(3, 1, 5, 0, zh), "导入 3 个会话 · 5 个技能 · 更新 1 个会话");
    assert.equal(headline(0, 0, 0, 0, zh), "什么都没勾");
    assert.equal(runningHeadline(3, 5, 0, zh), "正在导入 3 个会话、5 个技能…");
  });

  test("完成态主句", () => {
    assert.equal(
      doneHeadline(run({ imported: 34, updated: 1, createdWorkspaces: [{ id: "w", name: "w", path: "/w" }], skillsImported: 5, mcpImported: 1 }), zh),
      "已导入 34 个会话 · 5 个技能 · 1 个 MCP 服务（已关闭） · 已更新 1 个会话 · 1 个新工作区",
    );
  });

  test("行内徽标与模型悬停", () => {
    assert.equal(changeBadge(item({ change: "diverged", newMessages: 3 }), zh)?.text, "+3 · 副本");
    assert.equal(
      changeBadge(item({ change: "updated", newMessages: 2, source: "claude-code" }), zh)?.tip,
      "上次导入后 Claude Code 里又有 2 条新消息 · 追加进这里的同一个会话",
    );
  });

  test("事实条：数字在前、量词跟着 label", () => {
    const facts = sessionFacts(report({ orphanedSubSessions: 2 }), EMPTY_GROUPED, NOW, zh);
    assert.deepEqual(
      facts.map((fact) => `${fact.count} ${fact.label}`),
      ["2 个单独列出"],
    );
  });
});


describe("greetingSteps —— 三步清单前两步的判定（每次回迁移页现算）", () => {
  const provider = (id: string, models: string[], keyed = true): ProviderDto => ({
    id,
    displayName: id,
    endpoint: { baseUrl: "https://x", api: "openai-completions" },
    auth: keyed ? { scheme: "api_key", hasSecret: true, masked: "k" } : { scheme: "none" },
    models: { declared: models.map((m) => ({ id: m })) },
  });

  test("无服务商：①②都未完成（没 key 或没模型的服务商不算「配好」）", () => {
    assert.deepEqual(greetingSteps([], undefined), { provider: false, chore: false });
    assert.deepEqual(greetingSteps([provider("nokey", ["glm-5.3"], false)], undefined), { provider: false, chore: false });
    assert.deepEqual(greetingSteps([provider("empty", [])], undefined), { provider: false, chore: false });
  });

  test("有服务商没选家务活模型：①完成、②未完成", () => {
    assert.deepEqual(greetingSteps([provider("zai", ["glm-5.3"])], undefined), { provider: true, chore: false });
  });

  test("选了且模型还在：两步都完成", () => {
    const providers = [provider("zai", ["glm-5.3"])];
    assert.deepEqual(greetingSteps(providers, { providerId: "zai", modelId: "glm-5.3" }), { provider: true, chore: true });
  });

  test("家务活模型指的服务商被删（或没 key）：②按未完成处理", () => {
    assert.deepEqual(greetingSteps([provider("zai", ["glm-5.3"])], { providerId: "gone", modelId: "glm-5.3" }), { provider: true, chore: false });
    assert.deepEqual(
      greetingSteps([provider("zai", ["glm-5.3"], false)], { providerId: "zai", modelId: "glm-5.3" }),
      { provider: false, chore: false },
    );
  });

  test("服务商在但那个模型已不在声明里：②未完成", () => {
    assert.deepEqual(greetingSteps([provider("zai", ["glm-5.3"])], { providerId: "zai", modelId: "kimi-k3" }), { provider: true, chore: false });
  });
});
