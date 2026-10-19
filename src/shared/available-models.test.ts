/**
 * 可选模型清单的契约（2026-10-18）：provider 配置 → 事实清单，以及它作为开轮命令
 * 字段的（反）序列化。清单随开轮命令过 parentPort（structured clone），
 * 所以「能克隆、字段不丢、没声明的能力不凭空出现」是契约的一部分。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { availableModelsFromProviders, usableSubSessionSetting } from "./available-models.ts";
import type { AgentCommand } from "./agent-ipc.ts";
import type { ProviderDto } from "./provider.ts";

/** 一个最小可用的 provider 配置；auth / models 由用例给。 */
function provider(over: Partial<ProviderDto> & Pick<ProviderDto, "id" | "displayName" | "auth">): ProviderDto {
  return {
    endpoint: { baseUrl: "https://example.com/v1", api: "openai-completions" },
    models: { declared: [] },
    ...over,
  };
}

describe("availableModelsFromProviders", () => {
  test("没配好密钥的厂商整个跳过（与模型菜单的 usableProviders 同源判定）", () => {
    const models = availableModelsFromProviders([
      provider({
        id: "nokey",
        displayName: "No Key",
        auth: { scheme: "api_key", hasSecret: false, masked: null },
        models: { declared: [{ id: "ghost" }] },
      }),
      provider({
        id: "none",
        displayName: "None",
        auth: { scheme: "none" },
        models: { declared: [{ id: "ghost-2" }] },
      }),
      provider({
        id: "oauth-out",
        displayName: "OAuth Out",
        auth: { scheme: "oauth", loggedIn: false, account: null },
        models: { declared: [{ id: "ghost-3" }] },
      }),
    ]);
    assert.deepEqual(models, []);
  });

  test("有密钥的厂商按声明顺序列出；展示名缺省就是 modelId；能力没声明就缺席", () => {
    const models = availableModelsFromProviders([
      provider({
        id: "zai-coding",
        displayName: "Zhipu",
        auth: { scheme: "api_key", hasSecret: true, masked: "sk-***" },
        models: { declared: [{ id: "glm-5.3", name: "GLM-5.3", vision: true }, { id: "glm-4" }] },
      }),
      provider({
        id: "kimi",
        displayName: "Kimi",
        auth: { scheme: "env", envKeys: ["KIMI_API_KEY"] },
        models: { declared: [{ id: "k3", name: "K3", vision: false }] },
      }),
      provider({
        id: "claude",
        displayName: "Claude",
        auth: { scheme: "oauth", loggedIn: true, account: "a@b.c" },
        models: { declared: [{ id: "claude-opus" }] },
      }),
    ]);
    assert.deepEqual(models, [
      {
        providerId: "zai-coding",
        providerName: "Zhipu",
        modelId: "glm-5.3",
        modelName: "GLM-5.3",
        imageInput: true,
      },
      { providerId: "zai-coding", providerName: "Zhipu", modelId: "glm-4", modelName: "glm-4" },
      { providerId: "kimi", providerName: "Kimi", modelId: "k3", modelName: "K3", imageInput: false },
      { providerId: "claude", providerName: "Claude", modelId: "claude-opus", modelName: "claude-opus" },
    ]);
    // 「没声明能不能看图」是缺席，不是 undefined 挂着——提示词据此写 unknown
    assert.equal("imageInput" in models[1]!, false);
  });

  test("没声明任何模型、或没有 provider：空清单（提示词走「沿用父会话模型」）", () => {
    assert.deepEqual(
      availableModelsFromProviders([
        provider({
          id: "empty",
          displayName: "Empty",
          auth: { scheme: "api_key", hasSecret: true, masked: "k" },
        }),
      ]),
      [],
    );
    assert.deepEqual(availableModelsFromProviders([]), []);
  });
});

describe("usableSubSessionSetting —— 设置里的子会话模型此刻是否会生效", () => {
  const setting = { providerId: "gpt", modelId: "strong" };
  const alive = provider({
    id: "gpt",
    displayName: "GPT",
    auth: { scheme: "api_key", hasSecret: true, masked: "k" },
    models: { declared: [{ id: "strong" }] },
  });

  test("provider 还在 → 原样返回（提示词讲设置里的模型）", () => {
    assert.deepEqual(usableSubSessionSetting(setting, [alive]), setting);
  });

  test("provider 被删 → undefined（运行时退回同父，提示词也得讲同父）", () => {
    assert.equal(usableSubSessionSetting(setting, []), undefined);
    assert.equal(
      usableSubSessionSetting(setting, [
        provider({ id: "other", displayName: "Other", auth: { scheme: "env", envKeys: ["OTHER_KEY"] } }),
      ]),
      undefined,
    );
  });

  test("本来就没设 → undefined，且不因 provider 列表而变化", () => {
    assert.equal(usableSubSessionSetting(undefined, [alive]), undefined);
    assert.equal(usableSubSessionSetting(undefined, []), undefined);
  });
});

describe("开轮命令的 availableModels：能过 structured clone 的字段", () => {
  test("submit 命令带清单 → 克隆后逐字段相等；缺席的能力字段不会被补出来", () => {
    const command = {
      type: "submit",
      sessionId: "s1",
      text: "hi",
      cwd: "/tmp/x",
      workspaceId: null,
      provider: {
        id: "p",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        apiKey: "k",
        models: [],
      },
      modelId: "m",
      mode: "skip",
      thinkingLevel: "medium",
      piSessionDir: "/pi",
      attachmentsDir: "/att",
      protectedPaths: [],
      skillsDirs: [],
      mcpServers: {},
      availableModels: availableModelsFromProviders([
        provider({
          id: "zai-coding",
          displayName: "Zhipu",
          auth: { scheme: "api_key", hasSecret: true, masked: "k" },
          models: { declared: [{ id: "glm-5.3", vision: true }, { id: "glm-4" }] },
        }),
      ]),
    } satisfies Extract<AgentCommand, { type: "submit" }>;

    const cloned = structuredClone(command);
    assert.deepEqual(cloned, command);
    assert.equal(cloned.availableModels?.length, 2);
    assert.equal(cloned.availableModels?.[0]?.imageInput, true);
    assert.equal("imageInput" in (cloned.availableModels?.[1] ?? {}), false);
  });
});
