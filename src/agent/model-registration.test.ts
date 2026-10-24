import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";
import { FALLBACK_MODEL } from "../shared/model-defaults.ts";
import type { ModelDecl } from "../shared/provider.ts";
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
    // 目录条目都带协议与地址（pi 的 Model 必填）；默认 OpenAI Chat，要别的协议的用例自己覆盖
    api: "openai-completions",
    baseUrl: "https://catalog.example/v1",
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
      reasoning: undefined,
      // 替身没设 reasoning → pi 规则判「只有 off」；真模型的档位表在这里算好过线
      supportedThinkingLevels: ["off"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.05, cacheWrite: 0.6 },
    });
    assert.equal("tiers" in model.cost, false);
  });
});

describe("toFallbackModels —— 借参抄档位表（thinkingLevelMap 是模型能力，跟 id 走）", () => {
  test("目录原始条目带表：借参注册的模型拿到同款表，支持集不再是伪五档", () => {
    const withMap = {
      id: "glm-5.3",
      name: "GLM-5.3",
      api: "openai-completions",
      provider: "zai",
      baseUrl: "",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    } as unknown as PiModel;
    const registered = toFallbackModels([], [{ id: "glm-5.3" }], [], {}, [withMap])[0];
    assert.notEqual(registered, undefined);
    assert.deepEqual(registered?.thinkingLevelMap, withMap.thinkingLevelMap);
  });

  test("目录没有、白名单也没有这个 id：不带表（交给 pi 的「无表」规则）", () => {
    const registered = toFallbackModels([], [{ id: "ghost-model" }], [], {}, [])[0];
    assert.notEqual(registered, undefined);
    assert.equal(registered !== undefined && "thinkingLevelMap" in registered, false);
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

  test("models 里是声明 id 的条目：目录没收录也还有白名单这一层", () => {
    const registration = toFallbackRegistration(gateway, []);
    assert.deepEqual(
      registration.models?.map((model) => model.id),
      ["step-3.7-flash"],
    );
    // pi 目录未收 stepfun，但我们的白名单有官方的 256k——按 id 查之后自建网关也吃得到
    assert.equal(registration.models?.[0]?.contextWindow, 256_000);
  });

  test("白名单与目录都没有的 id：还是兜底条目", () => {
    const registration = toFallbackRegistration({ ...gateway, models: [{ id: "house-model" }] }, []);
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

  test("白名单要改模型时补注册：claude-opus-5 的档位进会话；只写了默认档的不补", () => {
    const opus = { ...catalogModel("claude-opus-5", 1_000_000, 5), reasoning: true } as PiModel;
    const rt = fakeRuntime([opus, catalogModel("deepseek-v4-flash", 1_000_000, 0.2)]);
    const model = registerAndResolveModel(cast(rt), { ...wire, models: [{ id: "claude-opus-5" }] }, "claude-opus-5");
    assert.deepEqual(rt.kinds, ["auth", "fallback"]);
    assert.ok(model !== undefined);
    // 白名单 off + low→max：目录没写 minimal 时 pi 会多算出它，现在标成 null
    assert.equal(model.thinkingLevelMap?.minimal, null);
    assert.equal(model.thinkingLevelMap?.max, "max");

    // deepseek-v4-flash 的白名单只有默认档（偏好，不进 pi 的模型对象）：不触发补注册
    const rt2 = fakeRuntime([catalogModel("deepseek-v4-flash", 1_000_000, 0.2)]);
    registerAndResolveModel(cast(rt2), { ...wire, models: [{ id: "deepseek-v4-flash" }] }, "deepseek-v4-flash");
    assert.deepEqual(rt2.kinds, ["auth"]);
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

// ── 自建网关按模型 id 跨目录借参数（wafo 2026-09-21 实测：7 个模型全显示 128k）──

describe("跨目录借参数 —— 自建网关没有 catalogId，但它跑的是有官方口径的型号", () => {
  /** 目录切片：claude-opus-5 在 anthropic 名下，glm-5.3 在 zai 名下（数值取自 pi-ai 实际条目） */
  function catalogRuntime(api: string, declared: ModelDecl[]) {
    const anthropic = {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      getModels: () => [
        {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          input: ["text", "image"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        },
      ] as unknown as PiModel[],
    };
    const zai = {
      id: "zai",
      name: "Z.AI",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      getModels: () => [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          api: "openai-completions",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ] as unknown as PiModel[],
    };
    let registered: PiModel[] | undefined;
    const runtime = {
      registerProvider: (_id: string, registration: PiProviderRegistration) => {
        if (registration.models !== undefined) registered = registration.models as PiModel[];
      },
      // 我们自己的 id（自建网关）在目录里当然查不到——只有补注册之后才解析得出来
      getModel: (_id: string, modelId: string) => registered?.find((m) => m.id === modelId),
      getProviders: () => [anthropic, zai],
    } as unknown as Parameters<typeof registerAndResolveModel>[0];
    return {
      resolve: (modelId: string) =>
        registerAndResolveModel(
          runtime,
          { id: "my-gw", apiKey: "k", baseUrl: "https://gw.example", api, models: declared },
          modelId,
        ),
    };
  }

  const declared: ModelDecl[] = [{ id: "claude-opus-5" }, { id: "glm-5.3" }, { id: "house-model" }];

  test("anthropic 兼容网关声明 claude-opus-5：拿到 anthropic 目录的 1M 与图片能力", () => {
    const model = catalogRuntime("anthropic-messages", declared).resolve("claude-opus-5");
    assert.equal(model?.contextWindow, 1_000_000);
    assert.equal(model?.maxTokens, 128_000);
    assert.deepEqual(model?.input, ["text", "image"]);
  });

  test("同一个网关的 glm-5.3：1M 但纯文本——图片能力照目录说的来，不一刀切", () => {
    const model = catalogRuntime("anthropic-messages", declared).resolve("glm-5.3");
    assert.equal(model?.contextWindow, 1_000_000);
    assert.deepEqual(model?.input, ["text"]);
  });

  test("目录里真没有的自家模型仍落兜底，但默认能吃图（剥图是静默的，400 不是）", () => {
    const model = catalogRuntime("anthropic-messages", declared).resolve("house-model");
    assert.equal(model?.contextWindow, FALLBACK_MODEL.contextWindow);
    assert.deepEqual(model?.input, ["text", "image"]);
  });
});

describe("toFallbackModels —— 借来的基线仍在用户覆盖之下", () => {
  const catalog = [
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: [
        {
          id: "claude-opus-5",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          input: ["text", "image"] as ("text" | "image")[],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        },
      ],
    },
  ];

  test("本家目录没有这个 id：按 id 跨目录借窗口 / 输出 / 单价 / 图片", () => {
    const result = toFallbackModels([], [{ id: "claude-opus-5" }], catalog, {
      api: "anthropic-messages",
    });
    assert.equal(result[0]?.contextWindow, 1_000_000);
    assert.equal(result[0]?.maxTokens, 128_000);
    assert.equal(result[0]?.cost.input, 5);
    assert.deepEqual(result[0]?.input, ["text", "image"]);
  });

  test("用户填了就以用户的为准——借参只是基线，不是结论", () => {
    const result = toFallbackModels(
      [],
      [{ id: "claude-opus-5", contextWindow: 200_000, vision: false }],
      catalog,
      { api: "anthropic-messages" },
    );
    assert.equal(result[0]?.contextWindow, 200_000);
    assert.deepEqual(result[0]?.input, ["text"]);
    assert.equal(result[0]?.maxTokens, 128_000); // 没填的字段仍吃借来的值
  });

  test("不传目录（老调用点）行为不变：直接落兜底", () => {
    const result = toFallbackModels([], [{ id: "claude-opus-5" }]);
    assert.equal(result[0]?.contextWindow, FALLBACK_MODEL.contextWindow);
  });
});

describe("自适应思考 —— 新 Claude 只收 adaptive + effort，网关注册要带上 forceAdaptiveThinking", () => {
  /** 原始目录条目：compat / 档位表取自 pi-ai 0.84.3 实际条目（其余字段只为让 pi 能构造请求） */
  function rawModel(id: string, api: string, extra: Record<string, unknown>): PiModel {
    return {
      id,
      name: id,
      api,
      baseUrl: "",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      ...extra,
    } as unknown as PiModel;
  }
  const fableMap = { off: null, xhigh: "xhigh", max: "max" };
  // 排在前面的 copilot 同 id 条目走 openai-completions、不带这一项：协议不对的条目不能说了算
  const copilot = {
    id: "github-copilot",
    name: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    getModels: () => [rawModel("claude-fable-5", "openai-completions", { thinkingLevelMap: fableMap })],
  };
  const anthropic = {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    getModels: () => [
      rawModel("claude-opus-5", "anthropic-messages", {
        compat: {
          forceAdaptiveThinking: true,
          supportsTemperature: false,
          supportsStrictTools: true,
          allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-4-8" }],
        },
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      }),
      rawModel("claude-fable-5", "anthropic-messages", {
        compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
        thinkingLevelMap: fableMap,
      }),
      rawModel("claude-sonnet-4-5", "anthropic-messages", { compat: { supportsStrictTools: true } }),
    ],
  };
  const cloudflare = {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    baseUrl: "https://gateway.ai.cloudflare.com",
    getModels: () => [
      rawModel("claude-opus-5", "anthropic-messages", {
        compat: { sendSessionAffinityHeaders: true, forceAdaptiveThinking: true, supportsTemperature: false },
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      }),
    ],
  };

  function resolveOnGateway(api: string, modelId: string): PiModel | undefined {
    let registered: PiModel[] | undefined;
    const runtime = {
      registerProvider: (_id: string, registration: PiProviderRegistration) => {
        if (registration.models !== undefined) registered = registration.models as PiModel[];
      },
      getModel: (_id: string, id: string) => registered?.find((m) => m.id === id),
      getProviders: () => [copilot, anthropic, cloudflare],
    } as unknown as Parameters<typeof registerAndResolveModel>[0];
    const declared = ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-4-5", "claude-opus-5-5"].map((id) => ({ id }));
    const model = registerAndResolveModel(
      runtime,
      { id: "my-gw", apiKey: "k", baseUrl: "https://gw.example", api, models: declared },
      modelId,
    );
    // pi 的注册会把 provider 级的 api / baseUrl 并进每个模型；替身只存 models，这里补齐
    return model === undefined ? undefined : ({ ...model, api, provider: "my-gw", baseUrl: "https://gw.example" } as PiModel);
  }

  /** pi 真正要发出去的请求体：onPayload 里截下后抛错，请求不出进程 */
  async function outgoingParams(model: PiModel, reasoning: ThinkingLevel): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const events = streamSimple(
      model as Model<"anthropic-messages">,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        apiKey: "sk-test",
        reasoning,
        onPayload: (payload) => {
          captured = payload as Record<string, unknown>;
          throw new Error("stop before network");
        },
      },
    );
    for await (const _event of events) {
      // 抛错后流以 error 事件收尾，排干即可
    }
    assert.ok(captured !== undefined, "pi 没有走到构造请求体那一步");
    return captured;
  }

  test("精确 id 命中：compat 只带 forceAdaptiveThinking，其余端点怪癖一个不抄", () => {
    const model = resolveOnGateway("anthropic-messages", "claude-opus-5");
    assert.deepEqual(model?.compat, { forceAdaptiveThinking: true });
  });

  test("家族借参（claude-fable-5-1 → claude-fable-5）：思考协议与档位表跟着参数同源，再按白名单纠", () => {
    const model = resolveOnGateway("anthropic-messages", "claude-fable-5-1");
    assert.deepEqual(model?.compat, { forceAdaptiveThinking: true });
    // 借来的表（fableMap）没写 minimal，pi 按「非显式 null 即支持」会多算出它；白名单按官方
    // 档位表（low→max）标成 null——菜单里本来就没有 minimal，会话现在也没有
    assert.deepEqual(model?.thinkingLevelMap, { ...fableMap, minimal: null });
    assert.ok(model !== undefined);
    assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
  });

  test("老的 budget 模型不带：claude-sonnet-4-5 仍走 budget_tokens", () => {
    const model = resolveOnGateway("anthropic-messages", "claude-sonnet-4-5");
    assert.equal(model !== undefined && "compat" in model, false);
  });

  test("OpenAI 兼容网关上的同名模型不带：这一项只属于 anthropic-messages 协议", () => {
    const model = resolveOnGateway("openai-completions", "claude-opus-5");
    assert.equal(model !== undefined && "compat" in model, false);
  });

  test("pi 据此发 adaptive + effort：xhigh / max 原样送到，不再换算成 budget_tokens", async () => {
    const opus = resolveOnGateway("anthropic-messages", "claude-opus-5");
    const fable = resolveOnGateway("anthropic-messages", "claude-fable-5-1");
    assert.ok(opus !== undefined && fable !== undefined);
    const xhigh = await outgoingParams(opus, "xhigh");
    assert.deepEqual(xhigh.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(xhigh.output_config, { effort: "xhigh" });
    const medium = await outgoingParams(opus, "medium");
    assert.deepEqual(medium.output_config, { effort: "medium" });
    const max = await outgoingParams(fable, "max");
    assert.deepEqual(max.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(max.output_config, { effort: "max" });
  });

  test("目录外的型号（claude-opus-5-5，家族也借不到）：白名单声明 adaptiveThinking 即带上，档位表按白名单生成", () => {
    const model = resolveOnGateway("anthropic-messages", "claude-opus-5-5");
    assert.deepEqual(model?.compat, { forceAdaptiveThinking: true });
    // 关不掉思考：off 为 null；没有 minimal；xhigh / max 映射成同名 effort
    assert.deepEqual(model?.thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" });
    assert.equal(model?.contextWindow, 1_000_000); // 窗口同样来自白名单，不落 128k 兜底
    // pi 发送前按这个支持集夹档：正好是白名单的 low→max，xhigh / max 不会被夹走
    assert.ok(model !== undefined);
    assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
  });

  test("白名单的 adaptive 声明只对 anthropic-messages 生效：openai 兼容网关上的 opus-5-5 不带", () => {
    const model = resolveOnGateway("openai-completions", "claude-opus-5-5");
    assert.equal(model !== undefined && "compat" in model, false);
  });

  test("opus-5-5 发出去的是 adaptive + effort：xhigh 原样送到（不被当成无表模型夹成 high），medium 是它的默认档", async () => {
    const model = resolveOnGateway("anthropic-messages", "claude-opus-5-5");
    assert.ok(model !== undefined);
    const xhigh = await outgoingParams(model, "xhigh");
    assert.deepEqual(xhigh.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(xhigh.output_config, { effort: "xhigh" });
    const medium = await outgoingParams(model, "medium");
    assert.deepEqual(medium.output_config, { effort: "medium" });
  });

  test("对照：不带这一项的模型 pi 仍发 budget_tokens（证明上一条断言的是这一项的效果）", async () => {
    const sonnet = resolveOnGateway("anthropic-messages", "claude-sonnet-4-5");
    assert.ok(sonnet !== undefined);
    const params = await outgoingParams(sonnet, "medium");
    assert.equal((params.thinking as { type?: string } | undefined)?.type, "enabled");
    assert.equal("output_config" in params, false);
  });
});

describe("DeepSeek 思考回传 —— 聚合网关换写法时从同家目录条目借协议", () => {
  /** 目录条目替身：compat 取自 pi-ai 0.84.3 的 opencode-go 实际条目 */
  function directoryModel(id: string, compat: Record<string, unknown>): PiModel {
    return {
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat,
    } as unknown as PiModel;
  }
  const opencodeCatalog = [
    directoryModel("deepseek-v4-flash", {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    }),
    directoryModel("glm-5.3", {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    }),
  ];

  function register(declaredIds: string[], api = "openai-completions"): PiModel[] {
    return toFallbackModels(
      opencodeCatalog,
      declaredIds.map((id) => ({ id })),
      [],
      { api },
      opencodeCatalog,
    ) as PiModel[];
  }

  test("deepseek-v4.1-flash 借到两项思考协议；端点怪癖（supportsStore 等）一个不抄", () => {
    const [model] = register(["deepseek-v4.1-flash"]);
    assert.deepEqual(model?.compat, {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
  });

  // 真实目录里 glm 条目**没有**思考协议两项（pi-ai 0.84.3 实测）——所以 glm-5.9 借不到
  // 任何东西，也绝不能把同目录里 deepseek 条目的协议抄过来。替身曾给 glm 造过
  // thinkingFormat:"zai"，那是目录里不存在的形状，断言跟着说了不存在的行为（验收发现）。
  test("家族不串味：glm-5.9 借不到协议，更不会抄成 deepseek 的", () => {
    const [model] = register(["glm-5.9"]);
    assert.equal(model !== undefined && "compat" in model, false);
  });

  test("没有同族条目就不带：不按 id 猜协议", () => {
    const [model] = register(["mystery-model-1"]);
    assert.equal(model !== undefined && "compat" in model, false);
  });

  test("协议不跨 api 借：anthropic-messages 接入时不带 openai-completions 的回传项", () => {
    const [model] = register(["deepseek-v4.1-flash"], "anthropic-messages");
    assert.equal(model !== undefined && "compat" in model, false);
  });

  /** 真正要发出去的请求体：onPayload 里截下后抛错，请求不出进程 */
  async function outgoing(model: PiModel): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const wire = { ...model, provider: "my-gw", api: "openai-completions", baseUrl: "https://gw.example/v1" };
    const events = streamOpenAI(
      wire as Model<"openai-completions">,
      {
        messages: [
          { role: "user", content: "跑一下", timestamp: 0 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
            api: "openai-completions",
            provider: "my-gw",
            model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      {
        apiKey: "sk-test",
        reasoning: "high",
        onPayload: (payload) => {
          captured = payload as Record<string, unknown>;
          throw new Error("stop before network");
        },
      },
    );
    for await (const _event of events) {
      // 抛错后流以 error 事件收尾，排干即可
    }
    assert.ok(captured !== undefined, "pi 没有走到构造请求体那一步");
    return captured;
  }

  function assistantTurn(params: Record<string, unknown>): Record<string, unknown> {
    const messages = params.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant");
    assert.ok(assistant !== undefined);
    return assistant;
  }

  test("缺思考的 assistant 消息回传空 reasoning_content —— 这是那条 400 的直接解", async () => {
    const [model] = register(["deepseek-v4.1-flash"]);
    assert.ok(model !== undefined);
    const params = await outgoing(model);
    assert.equal(assistantTurn(params).reasoning_content, "");
    assert.deepEqual(params.thinking, { type: "enabled" });
  });

  test("对照：不带这一项时同一段历史没有 reasoning_content（证明上一条断的是这一项的效果）", async () => {
    const [model] = register(["deepseek-v4.1-flash"]);
    assert.ok(model !== undefined);
    const { compat: _compat, ...bare } = model;
    const params = await outgoing(bare as PiModel);
    assert.equal("reasoning_content" in assistantTurn(params), false);
  });
});
