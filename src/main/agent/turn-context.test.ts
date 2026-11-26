import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resumeTurnContext } from "./turn-context.ts";
import type { SessionMeta } from "../../shared/session.ts";

const meta: SessionMeta = {
  id: "0199a0aa-6bb0-7cc0-8000-00000000000a",
  title: "t",
  titleSource: "auto",
  cwd: "/repo",
  workspaceId: "ws",
  providerId: "kimi",
  modelId: "k3",
  thinkingLevel: "off",
  piSessionFile: "/data/pi-sessions/a.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 2,
};

describe("resumeTurnContext：按会话 meta 拼开工上下文（自动化 this_session 与手机回一句共用）", () => {
  test("一切都取自 meta；只把 text 换成这一句", () => {
    assert.deepEqual(resumeTurnContext(meta, "继续"), {
      ok: true,
      input: {
        sessionId: meta.id,
        cwd: "/repo",
        workspaceId: "ws",
        resume: { piSessionFile: "/data/pi-sessions/a.jsonl" },
        providerId: "kimi",
        modelId: "k3",
              thinkingLevel: "off",
        text: "继续",
      },
    });
  });

  test("没有 pi 本子的会话续不了", () => {
    assert.deepEqual(resumeTurnContext({ ...meta, piSessionFile: null }, "继续"), { ok: false, reason: "unresumable" });
    // 不属于任何工作区的会话照样能续（workspaceId 原样是 null）
    const loose = resumeTurnContext({ ...meta, workspaceId: null }, "x");
    assert.ok(loose.ok && loose.input.workspaceId === null && loose.input.text === "x");
  });
});
