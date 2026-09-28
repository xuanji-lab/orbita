import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_ASSIGN_TARGET_GONE_CODE,
  findDeadTarget,
  groupUnassignedModels,
  isUnassignedSession,
  matchModelByName,
  normalizeModelId,
  originalModelOf,
  parseModelAssignEntries,
  planAssignments,
  type RegisteredModel,
} from "./model-assign.ts";
import { UNASSIGNED_MODEL_ID, UNASSIGNED_PROVIDER_ID, type SessionMeta } from "./session.ts";

const REGISTERED: RegisteredModel[] = [
  { providerId: "zai-coding", modelId: "glm-5.3" },
  { providerId: "kimi", modelId: "Kimi K3" },
  { providerId: "gateway", modelId: "GLM_5_3" },
];

describe("normalizeModelId / matchModelByName", () => {
  it("归一化：小写 + 只留字母数字", () => {
    assert.equal(normalizeModelId("GLM_5.3"), "glm53");
    assert.equal(normalizeModelId("Kimi K3"), "kimik3");
    assert.equal(normalizeModelId("。。。"), "");
  });

  it("精确命中优先，多服务商同名取列表第一个并标 ambiguous", () => {
    const hit = matchModelByName("glm-5.3", REGISTERED);
    assert.deepEqual(hit, { providerId: "zai-coding", modelId: "glm-5.3", ambiguous: false });
    // gateway 的 GLM_5_3 只能归一化对上：精确命中时不参与，不算多渠道
  });

  it("精确没有才走归一化；归一化多渠道取第一个并标 ambiguous", () => {
    const hit = matchModelByName("glm-5-3", REGISTERED);
    assert.deepEqual(hit, { providerId: "zai-coding", modelId: "glm-5.3", ambiguous: true });
  });

  it("归一化命中带书写差的声明（Kimi K3 ↔ kimi-k3）", () => {
    const hit = matchModelByName("kimi-k3", REGISTERED);
    assert.deepEqual(hit, { providerId: "kimi", modelId: "Kimi K3", ambiguous: false });
  });

  it("对不上返回 null——没有兜底", () => {
    assert.equal(matchModelByName("claude-opus-4", REGISTERED), null);
    assert.equal(matchModelByName("", REGISTERED), null);
  });

  it("同一 provider 下多个同名模型不算 ambiguous（渠道才有歧义）", () => {
    const dupe: RegisteredModel[] = [
      { providerId: "a", modelId: "m" },
      { providerId: "a", modelId: "m" },
    ];
    assert.equal(matchModelByName("m", dupe)?.ambiguous, false);
  });
});

/** 占位会话 meta 的最小形状（只填这个功能读的字段）。 */
function meta(patch: Partial<Pick<SessionMeta, "id" | "providerId" | "modelId" | "importedModel">>): SessionMeta {
  return {
    id: "x",
    title: "",
    titleSource: "derived",
    cwd: "/tmp",
    workspaceId: null,
    providerId: UNASSIGNED_PROVIDER_ID,
    modelId: "m",
    mode: "plan",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("originalModelOf / isUnassignedSession", () => {
  it("importedModel 优先；占位值与空不算", () => {
    assert.equal(originalModelOf(meta({ importedModel: "glm-5.3", modelId: "whatever" })), "glm-5.3");
    assert.equal(originalModelOf(meta({ modelId: "glm-5.3" })), "glm-5.3");
    assert.equal(originalModelOf(meta({ modelId: UNASSIGNED_MODEL_ID })), null);
    assert.equal(originalModelOf(meta({ importedModel: UNASSIGNED_MODEL_ID })), null);
  });

  it("只有占位 provider 的才算未分配", () => {
    assert.equal(isUnassignedSession(meta({})), true);
    assert.equal(isUnassignedSession(meta({ providerId: "zai-coding" })), false);
  });
});

describe("groupUnassignedModels", () => {
  it("按原模型名分组，会话数降序、同名次按字典序；total 含不可知的", () => {
    const groups = groupUnassignedModels([
      meta({ importedModel: "glm-5.3" }),
      meta({ modelId: "glm-5.3" }),
      meta({ importedModel: "kimi-k3" }),
      meta({ modelId: UNASSIGNED_MODEL_ID }),
      meta({ providerId: "zai-coding", modelId: "glm-5.3" }), // 已分配，不数
    ]);
    assert.equal(groups.total, 4);
    assert.deepEqual(groups.groups, [
      { model: "glm-5.3", sessions: 2 },
      { model: "kimi-k3", sessions: 1 },
    ]);
  });

  it("没有占位会话时 total 0、组空", () => {
    assert.deepEqual(groupUnassignedModels([meta({ providerId: "zai-coding" })]), { total: 0, groups: [] });
  });
});

describe("parseModelAssignEntries", () => {
  it("合法清单原样通过，同名去重", () => {
    assert.deepEqual(
      parseModelAssignEntries([
        { model: "glm-5.3", providerId: "zai-coding", modelId: "glm-5.3" },
        { model: "glm-5.3", providerId: "gateway", modelId: "GLM_5_3" },
        { model: "kimi-k3", providerId: "kimi", modelId: "Kimi K3" },
      ]),
      [
        { model: "glm-5.3", providerId: "zai-coding", modelId: "glm-5.3" },
        { model: "kimi-k3", providerId: "kimi", modelId: "Kimi K3" },
      ],
    );
  });

  it("坏形状整体拒绝", () => {
    assert.throws(() => parseModelAssignEntries([]), /non-empty/);
    assert.throws(() => parseModelAssignEntries(null), /array/);
    assert.throws(() => parseModelAssignEntries([{ model: "", providerId: "a", modelId: "m" }]), /bad model/);
    assert.throws(() => parseModelAssignEntries([{ model: "m", providerId: "", modelId: "m" }]), /bad providerId/);
    assert.throws(() => parseModelAssignEntries([{ model: "m", providerId: "a", modelId: 1 }]), /bad modelId/);
  });

  it("稳定错误码导出在案（主进程与 renderer 共用同一个常量）", () => {
    assert.equal(MODEL_ASSIGN_TARGET_GONE_CODE, "MODEL_ASSIGN_TARGET_GONE:");
  });
});

describe("findDeadTarget / planAssignments", () => {
  const entries = [
    { model: "glm-5.3", providerId: "zai-coding", modelId: "glm-5.3" },
    { model: "kimi-k3", providerId: "kimi", modelId: "Kimi K3" },
  ];

  it("目标都在注册表里 → null；哪条失效返回哪条（整批拒绝的依据）", () => {
    const registered = [
      { providerId: "zai-coding", modelId: "glm-5.3" },
      { providerId: "kimi", modelId: "Kimi K3" },
    ];
    assert.equal(findDeadTarget(entries, registered), null);
    // 模型被删 / provider 被删都算失效
    assert.equal(findDeadTarget(entries, registered.slice(0, 1))?.model, "kimi-k3");
    assert.equal(
      findDeadTarget([{ model: "m", providerId: "gone", modelId: "m" }], [{ providerId: "kimi", modelId: "m" }])?.model,
      "m",
    );
  });

  it("计划只收占位且原模型名在清单里的会话；已手选 / 不可知 / 不在清单的不动", () => {
    const plans = planAssignments(
      [
        meta({ id: "a", importedModel: "glm-5.3" }),
        meta({ id: "b", modelId: "glm-5.3" }),
        meta({ id: "c", importedModel: "claude-opus-4" }), // 对不上，不在清单
        meta({ id: "d", modelId: UNASSIGNED_MODEL_ID }), // 原模型名不可知
        meta({ id: "e", providerId: "zai-coding", modelId: "glm-5.3" }), // 已手选
      ],
      entries,
    );
    assert.deepEqual(plans, [
      { id: "a", providerId: "zai-coding", modelId: "glm-5.3" },
      { id: "b", providerId: "zai-coding", modelId: "glm-5.3" },
    ]);
  });
});
