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

import { resumeOf, MAIN_AGENT_RESUMES_KEPT } from "./main-agent.ts";
import { resumePolicy } from "./kernel.ts";

describe("重开后「断过」与主智能体的续跑口径", () => {
  test("resumeOf：名下没被打断的不记；接着做的与停着的分开，from 取最后落盘时刻", () => {
    assert.equal(resumeOf([{ id: "m", updatedAt: 5, policy: null }], 100), null);
    assert.deepEqual(
      resumeOf(
        [
          { id: "m", updatedAt: 5, policy: "resume" },
          { id: "a", updatedAt: 9, policy: "resume" },
          { id: "b", updatedAt: 7, policy: "crashed" },
          { id: "c", updatedAt: 99, policy: null },
        ],
        100,
      ),
      { at: 100, from: 9, resumed: ["m", "a"], stopped: ["b"] },
    );
  });

  test("resumePolicy：主智能体正常退出停下的自己接着做，崩溃的仍给「继续」；普通树根不变", () => {
    const running = (extra: object) => ({ durable: { since: 1, running: true as const, ...extra } });
    assert.equal(resumePolicy({ role: "main", ...running({ stoppedOnQuit: true }) }), "resume");
    assert.equal(resumePolicy({ role: "main", ...running({}) }), "ask");
    assert.equal(resumePolicy({ ...running({ stoppedOnQuit: true }) }), "ask");
    assert.equal(resumePolicy({ parentId: "p", ...running({ stoppedOnQuit: true }) }), "resume");
  });

  test("档案读回：坏的「断过」条目逐条丢，常量有上限", () => {
    const profile = parseMainAgentProfile({
      workspaceId: "w",
      sessionId: "s",
      createdAt: 1,
      resumes: [{ at: 2, from: 1, resumed: ["a"], stopped: [] }, { at: "x" }],
    });
    assert.deepEqual(profile?.resumes, [{ at: 2, from: 1, resumed: ["a"], stopped: [] }]);
    assert.ok(MAIN_AGENT_RESUMES_KEPT > 0);
  });
});

describe("主智能体档案里的型号", () => {
  test("缺席 = 沿用默认（档案里没有 model 键）；齐全合法才认；坏值当缺席，不连累整份档案", () => {
    const base = { workspaceId: "w1", sessionId: "s1", createdAt: 5 };
    assert.equal("model" in (parseMainAgentProfile(base) ?? {}), false);
    const model = { providerId: "zhipu", modelId: "glm-5.3", thinkingLevel: "high" };
    assert.deepEqual(parseMainAgentProfile({ ...base, model })?.model, model);
    for (const bad of [{ ...model, thinkingLevel: "turbo" }, { ...model, modelId: "" }, "glm-5.3", null]) {
      const profile = parseMainAgentProfile({ ...base, model: bad });
      assert.notEqual(profile, null);
      assert.equal("model" in (profile ?? {}), false);
    }
  });
});
