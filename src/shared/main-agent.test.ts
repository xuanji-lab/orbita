import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseMainAgentProfile } from "./main-agent.ts";
import { parseSessionMeta } from "./session.ts";

describe("主智能体档案与 meta 的 role 字段", () => {
  test("档案：齐全的原样读回，缺字段 / 坏类型当没有", () => {
    const ok = { workspaceId: "w1", sessionId: "s1", createdAt: 5 };
    assert.deepEqual(parseMainAgentProfile(ok), ok);
    assert.equal(parseMainAgentProfile({ workspaceId: "w1", sessionId: "", createdAt: 5 }), null);
    assert.equal(parseMainAgentProfile({ workspaceId: "w1", sessionId: "s1" }), null);
    assert.equal(parseMainAgentProfile({ workspaceId: 1, sessionId: "s1", createdAt: 5 }), null);
    assert.equal(parseMainAgentProfile("x"), null);
    assert.equal(parseMainAgentProfile(null), null);
  });

  test("meta：只认 role 为 main，缺席与坏值都是普通会话", () => {
    const base = { id: "a", cwd: "/x", providerId: "p", modelId: "m", createdAt: 1 };
    assert.equal(parseSessionMeta({ ...base, role: "main" })?.role, "main");
    assert.equal(parseSessionMeta(base)?.role, undefined);
    assert.equal("role" in (parseSessionMeta({ ...base, role: "boss" }) ?? {}), false);
  });
});
