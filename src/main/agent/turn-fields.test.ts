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
  pdfCitations: false,
};

describe("turnFields", () => {
  test("workspaceName 有值：透传进命令", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], { ...environment, workspaceName: "论文 3" });
    assert.equal(fields.workspaceName, "论文 3");
    assert.equal(fields.workspaceId, "ws-1");
    assert.equal(fields.sessionId, "s1");
  });

  test("workspaceName 缺席（旧夹具 / 工作区已删）：键彻底不出现，不是 undefined 挂着", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal("workspaceName" in fields, false);
    assert.equal(fields.workspaceId, "ws-1");
  });

  test("无工作区（workspaceId null）：照常，name 自然缺席", () => {
    const fields = turnFields({ ...input, workspaceId: null }, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal(fields.workspaceId, null);
    assert.equal("workspaceName" in fields, false);
  });

  // 续会话的唯一通路：renderer 的 resume → 命令的 piSessionFile → runtime 的 SessionManager.open。
  // 抽 turn-fields.ts 时漏过这一行（2026-10-11），每轮都新建 pi 本子：模型看不到前文，
  // created 事件又把 meta 改指到新本子上，回退随之对不上账
  test("resume 有值：piSessionFile 透传进命令（续跑旧本子）", () => {
    const fields = turnFields(
      { ...input, resume: { piSessionFile: "/pi/2026-10-09_book.jsonl" } },
      provider,
      "/pi",
      "/sessions/s1.attachments",
      [],
      environment,
    );
    assert.equal(fields.piSessionFile, "/pi/2026-10-09_book.jsonl");
  });

  test("resume 为 null（新会话）：piSessionFile 键彻底不出现——runtime 据此新建、主进程据此等 created", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal("piSessionFile" in fields, false);
  });

  // 子会话模型（2026-10-19）：提示词讲「不点名 model 时子会话落到哪」用，同 workspaceName
  // 的纪律——缺席时键不出现（没设 vs 设了但没值，靠键在不在区分）
  test("subSessionModel 有值：透传进命令", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], {
      ...environment,
      subSessionModel: { providerId: "zhipu-coding", modelId: "glm-5.3" },
    });
    assert.deepEqual(fields.subSessionModel, { providerId: "zhipu-coding", modelId: "glm-5.3" });
  });

  test("subSessionModel 缺席（没设）：键彻底不出现，不是 undefined 挂着", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal("subSessionModel" in fields, false);
  });
});

