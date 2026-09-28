import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignEntries, assignHint, assignPreview, registeredModelsOf } from "./providers-assign.ts";
import type { ProviderDto } from "../../../../shared/provider.ts";

function provider(id: string, models: string[], keyed = true): ProviderDto {
  return {
    id,
    displayName: id,
    endpoint: { baseUrl: "https://x", api: "openai-completions" },
    auth: keyed ? { scheme: "api_key", hasSecret: true, masked: "k" } : { scheme: "none" },
    models: { declared: models.map((m) => ({ id: m })) },
  };
}

describe("registeredModelsOf", () => {
  it("只收能用的服务商（有 key 且声明过模型），按列表顺序展开", () => {
    assert.deepEqual(
      registeredModelsOf([provider("zai", ["glm-5.3"]), provider("nokey", ["m"], false), provider("kimi", ["k3"])]),
      [
        { providerId: "zai", modelId: "glm-5.3" },
        { providerId: "kimi", modelId: "k3" },
      ],
    );
  });
});

describe("assignPreview", () => {
  const providers = [provider("zai", ["glm-5.3"]), provider("gateway", ["GLM_5_3"]), provider("kimi", ["Kimi K3"])];

  it("精确 / 归一化 / 多渠道取第一个并标 ambiguous / 对不上", () => {
    const preview = assignPreview(
      {
        total: 60,
        groups: [
          { model: "glm-5.3", sessions: 42 },
          { model: "glm-5-3-ish", sessions: 5 }, // 归一化对上 zai/gateway → ambiguous
          { model: "kimi-k3", sessions: 2 },
          { model: "claude-opus-4", sessions: 10 },
        ],
      },
      providers,
    );
    assert.deepEqual(preview.rows[0], { model: "glm-5.3", sessions: 42, target: { providerId: "zai", modelId: "glm-5.3", ambiguous: false } });
    // glm-5-3-ish 精确没有、归一化 glm53ish 谁都对不上 → null。换一个真能归一化对上的：
    const normalized = assignPreview({ total: 5, groups: [{ model: "glm_5_3", sessions: 5 }] }, providers);
    assert.deepEqual(normalized.rows[0]?.target, { providerId: "zai", modelId: "glm-5.3", ambiguous: true });
    assert.deepEqual(preview.rows[2]?.target, { providerId: "kimi", modelId: "Kimi K3", ambiguous: false });
    assert.equal(preview.rows[3]?.target, null);
    // assignable = 42 + 2（5 那行对不上）；unmatched = 60 - 44 = 16（含 total 里不可知的）
    assert.equal(preview.assignable, 44);
    assert.equal(preview.unmatched, 16);
  });

  it("执行清单只收有去向的行", () => {
    const preview = assignPreview({ total: 12, groups: [{ model: "glm-5.3", sessions: 10 }, { model: "x", sessions: 2 }] }, providers);
    assert.deepEqual(assignEntries(preview), [{ model: "glm-5.3", providerId: "zai", modelId: "glm-5.3" }]);
  });
});

describe("assignHint 三态", () => {
  const providers = [provider("zai", ["glm-5.3"])];

  it("没有占位会话 / 分组还没读到 / 没有能用的服务商 → 不显示", () => {
    assert.deepEqual(assignHint({ total: 0, groups: [] }, providers), { kind: "none" });
    assert.deepEqual(assignHint(null, providers), { kind: "none" });
    assert.deepEqual(assignHint({ total: 3, groups: [{ model: "glm-5.3", sessions: 3 }] }, []), { kind: "none" });
    assert.deepEqual(assignHint({ total: 3, groups: [{ model: "glm-5.3", sessions: 3 }] }, [provider("z", ["glm-5.3"], false)]), { kind: "none" });
  });

  it("有可配的 → offer；全剩对不上的 → leftover（不给按钮）", () => {
    assert.deepEqual(assignHint({ total: 3, groups: [{ model: "glm-5.3", sessions: 2 }, { model: "x", sessions: 1 }] }, providers), {
      kind: "offer",
      total: 3,
      assignable: 2,
    });
    assert.deepEqual(assignHint({ total: 5, groups: [{ model: "x", sessions: 3 }] }, providers), {
      kind: "leftover",
      unmatched: 5,
    });
  });
});
