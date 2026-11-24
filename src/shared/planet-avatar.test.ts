import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isAvatarGenerateRequest, isAvatarSelectRequest, isAvatarJobLive, type AvatarJob } from "./planet-avatar.ts";
import { parseSessionMeta, rootSessions, type SessionMeta } from "./session.ts";

describe("planet-avatar 契约", () => {
  it("生成请求：主星 / 行星 id 都认，越界的 id 与超长名字不认", () => {
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "main" }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1a2b", name: "赭汐", mix: { seed: 1, items: [] } }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "../x" }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "", bodyId: "main" }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "main", name: "x".repeat(201) }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "再暖一点", baseCandidateId: "r2-s1" }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "  " }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "x".repeat(1001) }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "加一圈云", baseCandidateId: "../x" }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "再暖一点", useCurrentSurface: true }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", useCurrentSurface: "yes" }), false);
  });

  it("挑选请求：候选 id 只认插件的 r<轮>-s<位>", () => {
    assert.equal(isAvatarSelectRequest({ workspaceId: "w", bodyId: "main", candidateId: "r2-s3" }), true);
    assert.equal(isAvatarSelectRequest({ workspaceId: "w", bodyId: "main", candidateId: "../../etc" }), false);
    assert.equal(isAvatarSelectRequest({ workspaceId: "w", bodyId: "main" }), false);
  });

  it("只有 preparing / running 算在出图", () => {
    const job = (state: AvatarJob["state"]): AvatarJob => ({
      workspaceId: "w", bodyId: "main", state, round: null, slots: [], notes: [], policy: null, model: null, sessionId: null, selected: null, error: null, startedAt: 0, finishedAt: null,
    });
    assert.equal(isAvatarJobLive(job("preparing")), true);
    assert.equal(isAvatarJobLive(job("running")), true);
    assert.equal(isAvatarJobLive(job("ready")), false);
    assert.equal(isAvatarJobLive(null), false);
  });

  it("幕后会话：meta 读得回 backstage，根会话列表不列它", () => {
    const raw = { id: "s1", cwd: "/w", providerId: "p", modelId: "m", createdAt: 1, backstage: "avatar" };
    const meta = parseSessionMeta(raw) as SessionMeta;
    assert.equal(meta.backstage, "avatar");
    assert.deepEqual(rootSessions([meta]), []);
    const plain = parseSessionMeta({ ...raw, id: "s2", backstage: "other" }) as SessionMeta;
    assert.equal(plain.backstage, undefined);
    assert.equal(rootSessions([plain]).length, 1);
  });
});
