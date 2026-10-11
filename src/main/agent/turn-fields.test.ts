/**
 * turnFields 的账（从 ipc.ts 抽出来的纯函数，2026-10-11）：renderer 载荷 →
 * 开轮命令的公共字段。workspaceName 的透传是 scope 指引（store-tools）的
 * 主进程侧接线——缺席时彻底不进命令对象（「翻不出名字」与「无工作区」两态
 * 靠 workspaceId 区分，不能靠键在不在猜）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { turnFields } from "./turn-fields.ts";
import type { CompactionSetting } from "../../shared/settings.ts";

const input = {
  sessionId: "s1",
  cwd: "/tmp/x",
  workspaceId: "ws-1",
  providerId: "p",
  modelId: "m",
  mode: "plan",
  thinkingLevel: "medium",
  resume: null,
} as const;

const provider = { id: "p", label: "P", models: {}, apiKey: "k" } as never;

const environment = {
  skillsDirs: [],
  directories: { attached: [], workbench: "/tmp/wb" },
  mcpServers: {},
  compaction: { enabled: true } as CompactionSetting,
  gitAttribution: true,
  attributionLanguage: "en" as const,
};

describe("turnFields", () => {
  test("workspaceName 有值：透传进命令", () => {
    const fields = turnFields(input, provider, "/pi", [], { ...environment, workspaceName: "论文 3" });
    assert.equal(fields.workspaceName, "论文 3");
    assert.equal(fields.workspaceId, "ws-1");
    assert.equal(fields.sessionId, "s1");
  });

  test("workspaceName 缺席（旧夹具 / 工作区已删）：键彻底不出现，不是 undefined 挂着", () => {
    const fields = turnFields(input, provider, "/pi", [], environment);
    assert.equal("workspaceName" in fields, false);
    assert.equal(fields.workspaceId, "ws-1");
  });

  test("无工作区（workspaceId null）：照常，name 自然缺席", () => {
    const fields = turnFields({ ...input, workspaceId: null }, provider, "/pi", [], environment);
    assert.equal(fields.workspaceId, null);
    assert.equal("workspaceName" in fields, false);
  });
});

