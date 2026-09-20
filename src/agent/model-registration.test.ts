import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FALLBACK_MODEL } from "../shared/model-defaults.ts";
import {
  hasModelOverrides,
  registerAndResolveModel,
  toAuthConfig,
  toBuiltinModel,
  toFallbackModels,
  toFallbackRegistration,
  type PiModel,
  type PiProviderRegistration,
} from "./model-registration.ts";

/** 目录条目的最小替身：只填断言要看的字段，其余靠结构断言不需要 */
function catalogModel(id: string, contextWindow: number, inputCost: number): PiModel {
  return {
    id,
    name: id,
    contextWindow,
    // 目录条目都带 input（pi 的 Model 必填）；默认纯文本，要图片的用例自己覆盖
    input: ["text"],
    cost: { input: inputCost, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  } as unknown as PiModel;
}

describe("toAuthConfig —— 注册不带 models，目录官方参数才能存活", () => {
  test("只有 auth 四件，没有 models 键", () => {
    const config = toAuthConfig({
      apiKey: "sk-x",
      baseUrl: "https://api.example/v1",
      api: "openai-completions",
    });
    assert.deepEqual(config, {
      apiKey: "sk-x",
      baseUrl: "https://api.example/v1",
      api: "openai-completions",
    });
    assert.equal("models" in config, false);
  });

  test("headers 有值才带上", () => {
    const withHeaders = toAuthConfig({
      apiKey: "sk-x",
      baseUrl: "https://api.example/v1",
      api: "anthropic-messages",
      headers: { "x-api-version": "2" },
    });
    assert.deepEqual(withHeaders.headers, { "x-api-version": "2" });
  });
});

describe("toFallbackModels —— 保留合并 + 用户字段覆盖", () => {
  test("目录认识的 id 原样保留：官方窗口与单价不被兜底覆盖", () => {
    const glm = catalogModel("glm-4.7", 204_800, 0.6);
    const result = toFallbackModels([glm], [{ id: "glm-4.7" }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.contextWindow, 204_800);
    assert.equal(result[0]?.cost.input, 0.6);
  });

  test("目录没有的 id 落保守默认：128k 窗口、零单价（未知定价不冒充免费之外的数）", () => {
    const result = toFallbackModels([], [{ id: "my-gateway-model" }]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.contextWindow, FALLBACK_MODEL.contextWindow);
    assert.equal(result[0]?.cost.input, 0);
  });

  test("混着来：一个目录条目保官方参数，一个新 id 拿兜底——补一个不砸另一个", () => {
    const glm = catalogModel("glm-4.7", 204_800, 0.6);
    const result = toFallbackModels([glm], [{ id: "glm-4.7" }, { id: "glm-future-99" }]);
    assert.equal(result[0]?.contextWindow, 204_800);
    assert.equal(result[1]?.contextWindow, FALLBACK_MODEL.contextWindow);
  });

  test("用户覆盖逐字段生效：目录条目只被填了的字段盖掉，其余保官方值", () => {
    const glm = catalogModel("glm-4.7", 204_800, 0.6);
    const result = toFallbackModels([glm], [
      { id: "glm-4.7", contextWindow: 1_000_000, cost: { input: 1.2, output: 3, cacheRead: 0.2, cacheWrite: 1.2 } },
    ]);
    assert.equal(result[0]?.contextWindow, 1_000_000); // 用户填的窗口盖目录
    assert.equal(result[0]?.maxTokens, undefined); // 没填的字段不虚构
    assert.deepEqual(result[0]?.cost, { input: 1.2, output: 3, cacheRead: 0.2, cacheWrite: 1.2 });
  });

  test("网关模型填了参数：覆盖落在兜底之上（pi modelFromJson 同款语义）", () => {
    const result = toFallbackModels([], [
      {
        id: "step-3.7-flash",
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    assert.equal(result[0]?.contextWindow, 200_000);
    assert.equal(result[0]?.maxTokens, 16_384);
    assert.equal(result[0]?.cost.input, 0.5);
  });

  test("用户声明 name 时跟着带过去（无声明则目录名 / id 兜底）", () => {
    const result = toFallbackModels([], [{ id: "m1", name: "My Model" }]);
    assert.equal(result[0]?.name, "My Model");
  });
});

describe("hasModelOverrides —— 补注册的触发条件之一", () => {
  test("纯 id 声明不算覆盖：目录认识的模型走原值，不触发重注册", () => {
    assert.equal(hasModelOverrides([{ id: "glm-4.7" }, { id: "glm-future-99" }]), false);
  });

  test("任一声明带 contextWindow / maxTokens / cost 就算——用户填的要盖过目录", () => {
    assert.equal(hasModelOverrides([{ id: "m", contextWindow: 200_000 }]), true);
    assert.equal(hasModelOverrides([{ id: "m" }, { id: "n", maxTokens: 16_384 }]), true);
    assert.equal(
      hasModelOverrides([{ id: "m", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]),
      true,
    );
  });

  test("显式 undefined（表单 Reset 后残留）不算覆盖", () => {
    assert.equal(
      hasModelOverrides([{ id: "m", contextWindow: undefined, maxTokens: undefined, cost: undefined }]),
      false,
    );
  });

  test("vision 覆盖也算：图片能力声明要触发补注册才能落成 input 模态", () => {
    assert.equal(hasModelOverrides([{ id: "m", vision: true }]), true);
    assert.equal(hasModelOverrides([{ id: "m", vision: false }]), true);
    assert.equal(hasModelOverrides([{ id: "m", vision: undefined }]), false);
  });
});

describe("vision 覆盖落成 input 模态", () => {
  test("vision: true → 可吃图片；false → 强制纯文本；缺省 → 目录原样", () => {
    const visionModel = catalogModel("glm-5v", 204_800, 0.6);
    (visionModel as { input?: string[] }).input = ["text", "image", "pdf"];
    const plainWithImage = catalogModel("glm-5-plain", 131_072, 0.6);
    (plainWithImage as { input?: string[] }).input = ["text", "image", "pdf"];
    const result = toFallbackModels([visionModel, plainWithImage], [
      { id: "glm-5v", vision: false },
      { id: "gateway-novel", vision: true },
      { id: "glm-5-plain" },
    ]);
    // 用户强制关：目录带的 image / pdf 都收走
    assert.deepEqual(result[0]?.input, ["text"]);
    // 用户强制开：目录没有的条目也开出来（兜底本是纯文本）
    assert.deepEqual(result[1]?.input, ["text", "image"]);
    // 没写 vision 的目录条目原样带回，不被本字段碰
    assert.deepEqual(result[2]?.input, ["text", "image", "pdf"]);
  });
});

describe("toBuiltinModel —— 目录条目瘦身给设置面", () => {
  test("带官方参数，剥掉 tiers 等无消费者字段", () => {
    const glm = {
      ...catalogModel("glm-4.7", 204_800, 0.6),
      maxTokens: 8_192,
      cost: { input: 0.6, output: 2.2, cacheRead: 0.05, cacheWrite: 0.6, tiers: [{ inputTokensAbove: 0 }] },
    } as unknown as PiModel;
    const model = toBuiltinModel(glm);
    assert.deepEqual(model, {
      id: "glm-4.7",
      contextWindow: 204_800,
      maxTokens: 8_192,
      input: ["text"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.05, cacheWrite: 0.6 },
    });
    assert.equal("tiers" in model.cost, false);
  });
});

describe("toFallbackRegistration —— 补注册必须带完整 auth 面", () => {
  const gateway = {
    apiKey: "sk-gw",
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    models: [{ id: "step-3.7-flash" }],
  };

  test("api / baseUrl / apiKey 都在原始载荷里——自建网关没有目录 defaults 可借，缺了当场抛", () => {
    const registration = toFallbackRegistration(gateway, []);
    assert.equal(registration.api, "openai-completions");
    assert.equal(registration.baseUrl, "https://gw.example/v1");
    assert.equal(registration.apiKey, "sk-gw");
    // 回归锚点：真实事故是只传 {models}，pi 校验（跑在合并之前）抛 no "api" specified
    assert.ok(registration.models !== undefined);
  });

  test("models 里是声明 id 的兜底条目", () => {
    const registration = toFallbackRegistration(gateway, []);
    assert.deepEqual(
      registration.models?.map((model) => model.id),
      ["step-3.7-flash"],
    );
    assert.equal(registration.models?.[0]?.contextWindow, FALLBACK_MODEL.contextWindow);
  });
});

describe("registerAndResolveModel —— create 与会话内换模型（C-4）共用的装配路径", () => {
  const wire = {
    id: "prov",
    apiKey: "sk-x",
    baseUrl: "https://api.example/v1",
    api: "openai-completions",
  };

  /**
   * ModelRuntime 的最小替身：注册整体替换（pi 的注册语义）——auth 面注册不动
   * 目录条目，带 models 的注册盖掉目录。kinds 记下注册顺序供断言。
   *
   * 注册载荷里的 model 条目没有 provider/api/baseUrl（真 runtime 的组合层会补齐），
   * 替身在这里补齐后才能当 getModel 的返回值用——形状差异在替身内消化，不往外泄。
   */
  function fakeRuntime(catalog: readonly PiModel[]) {
    let registeredModels: PiModel[] | undefined;
    const kinds: string[] = [];
    return {
      kinds,
      registerProvider(_id: string, registration: PiProviderRegistration): void {
        kinds.push(registration.models === undefined ? "auth" : "fallback");
        registeredModels = registration.models?.map((model) => ({
          ...model,
          provider: "prov" as const,
          api: registration.api ?? "openai-completions",
          baseUrl: registration.baseUrl ?? "",
        }));
      },
      getModel(providerId: string, modelId: string): PiModel | undefined {
        if (providerId !== "prov") return undefined;
        return (
          registeredModels?.find((model) => model.id === modelId) ??
          catalog.find((model) => model.id === modelId)
        );
      },
      getProviders(): { id: string; getModels: () => readonly PiModel[] }[] {
        return [{ id: "prov", getModels: () => registeredModels ?? catalog }];
      },
    };
  }

  const cast = (fake: ReturnType<typeof fakeRuntime>) =>
    fake as unknown as Pick<ModelRuntime, "registerProvider" | "getModel" | "getProviders">;

  test("目录认识的 id：只注册 auth 面，拿到目录原值——官方窗口不被兜底盖掉", () => {
    const rt = fakeRuntime([catalogModel("glm-4.7", 204_800, 0.6)]);
    const model = registerAndResolveModel(
      cast(rt),
      { ...wire, models: [{ id: "glm-4.7" }] },
      "glm-4.7",
    );
    assert.deepEqual(rt.kinds, ["auth"]);
    assert.equal(model?.contextWindow, 204_800);
  });

  test("目录没有的 id：auth 之后再补注册兜底，拿到兜底条目", () => {
    const rt = fakeRuntime([]);
    const model = registerAndResolveModel(
      cast(rt),
      { ...wire, models: [{ id: "gateway-model" }] },
      "gateway-model",
    );
    assert.deepEqual(rt.kinds, ["auth", "fallback"]);
    assert.equal(model?.contextWindow, FALLBACK_MODEL.contextWindow);
  });

  test("声明带覆盖：目录认识也补注册——用户填的窗口必须生效", () => {
    const rt = fakeRuntime([catalogModel("glm-4.7", 204_800, 0.6)]);
    const model = registerAndResolveModel(
      cast(rt),
      { ...wire, models: [{ id: "glm-4.7", contextWindow: 1_000_000 }] },
      "glm-4.7",
    );
    assert.deepEqual(rt.kinds, ["auth", "fallback"]);
    assert.equal(model?.contextWindow, 1_000_000);
  });

  test("声明里根本没有这个 id：注册了也解析不到——undefined 交调用方报错", () => {
    const rt = fakeRuntime([]);
    const model = registerAndResolveModel(cast(rt), { ...wire, models: [{ id: "a" }] }, "b");
    assert.equal(model, undefined);
  });
});

// ── D4：按 catalogId 查目录（wafo 2026-09-03 实测 1M 被拍成 128k）──

describe("catalogId —— 我们的 id 与 pi 目录的 id 不是一回事", () => {
  test("目录里叫 zai-coding-cn，我们叫 zhipu-coding：按 catalogId 才查得到官方参数", () => {
    const catalogModels = [
      // 展开放最前：官方参数必须盖住兜底，不是反过来
      { ...FALLBACK_MODEL, id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, maxTokens: 131_072 },
    ];
    const registered: Record<string, unknown> = {};
    const runtime = {
      registerProvider: (id: string, config: unknown) => {
        registered[id] = config;
      },
      // 我们自己的 id 在目录里查不到任何模型——这正是 bug 的起点
      getModel: (id: string, modelId: string) =>
        id === "zhipu-coding" && registered["zhipu-coding"] !== undefined
          ? ((registered["zhipu-coding"] as { models?: PiModel[] }).models ?? []).find(
              (m) => m.id === modelId,
            )
          : undefined,
      getProviders: () => [
        { id: "zai-coding-cn", getModels: () => catalogModels as PiModel[] },
      ],
    } as unknown as Parameters<typeof registerAndResolveModel>[0];

    const model = registerAndResolveModel(
      runtime,
      {
        id: "zhipu-coding",
        apiKey: "k",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        api: "anthropic-messages",
        catalogId: "zai-coding-cn",
        models: [{ id: "glm-5.3" }],
      },
      "glm-5.3",
    );
    // 官方 1M 保住了，没被拍成兜底的 128k
    assert.equal(model?.contextWindow, 1_000_000);
  });

  test("没有 catalogId（自建网关）退回按自己的 id 查——查不到就落兜底，不报错", () => {
    const runtime = {
      registerProvider: () => undefined,
      getModel: () => undefined,
      getProviders: () => [],
    } as unknown as Parameters<typeof registerAndResolveModel>[0];
    const model = registerAndResolveModel(
      runtime,
      { id: "my-gateway", apiKey: "k", baseUrl: "https://x/v1", api: "openai-completions", models: [{ id: "m" }] },
      "m",
    );
    assert.equal(model, undefined);
  });
});
