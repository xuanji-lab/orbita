import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_PROVIDERS,
  isPlanBilling,
  knownModelParams,
  knownProviderDefaultName,
  knownProviderOf,
  knownProviderGroup,
} from "./known-providers.ts";
import { defaultThinkingLevel } from "./model-defaults.ts";
import type { ProviderApi } from "./provider.ts";

// 与 validateProvider 的 ID_PATTERN 同一条规则（那边未导出，这里镜像一份；改要同步）
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,64}$/;

test("KNOWN_PROVIDERS：id 合法且不重复——下拉框的 key 与 upsert 的 id 都靠它", () => {
  const ids = KNOWN_PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "id 重复会让下拉框 key 撞车");
  for (const provider of KNOWN_PROVIDERS) {
    assert.match(provider.id, ID_PATTERN, `${provider.id} 过不了 upsert 校验`);
    assert.ok(provider.label !== "", `${provider.id} 缺显示名`);
  }
});

describe("knownProviderGroup —— 添加服务商目录的三个分区", () => {
  const groupOf = (id: string) => {
    const provider = KNOWN_PROVIDERS.find((item) => item.id === id);
    assert.ok(provider !== undefined, id);
    return knownProviderGroup(provider);
  };

  it("按量的官方 API 进 api，套餐进 plan，没有预填地址的兼容入口进 custom", () => {
    assert.equal(groupOf("deepseek"), "api");
    assert.equal(groupOf("zhipu"), "api");
    assert.equal(groupOf("zhipu-coding"), "plan");
    assert.equal(groupOf("kimi-coding"), "plan");
    assert.equal(groupOf("opencode-go"), "plan");
    assert.equal(groupOf("anthropic-compatible"), "custom");
    assert.equal(groupOf("openai-compatible"), "custom");
  });

  it("每个区都不空——空区意味着条目的 billing / baseUrl 写错了", () => {
    const groups = new Set(KNOWN_PROVIDERS.map(knownProviderGroup));
    assert.deepEqual([...groups].sort(), ["api", "custom", "plan"]);
  });
});

describe("命名 —— label 是厂商名，计费方式交给分区", () => {
  it("label 不带 Coding Plan / API 一类的计费后缀", () => {
    for (const provider of KNOWN_PROVIDERS) {
      assert.doesNotMatch(provider.label, /coding plan|\bapi\b|套餐|按量/i, provider.id);
    }
  });

  it("同名的两条（智谱按量 / 套餐）实例默认名带上计费方式，不同名的就是 label", () => {
    const byId = (id: string) => {
      const provider = KNOWN_PROVIDERS.find((item) => item.id === id);
      assert.ok(provider !== undefined, id);
      return provider;
    };
    assert.equal(knownProviderDefaultName(byId("zhipu")), "智谱（按量）");
    assert.equal(knownProviderDefaultName(byId("zhipu-coding")), "智谱（套餐）");
    assert.equal(knownProviderDefaultName(byId("kimi-coding")), "Kimi");
    const names = KNOWN_PROVIDERS.map(knownProviderDefaultName);
    assert.equal(new Set(names).size, names.length, "默认名撞了，服务商列表里分不出来");
  });
});

/** 一个已配置 provider 的最小形状（knownProviderOf 的入参） */
const p = (id: string, extra: { kind?: string; api?: ProviderApi } = {}) => ({
  id,
  ...(extra.kind === undefined ? {} : { kind: extra.kind }),
  endpoint: { api: extra.api ?? ("openai-completions" as ProviderApi) },
});

describe("knownProviderOf —— 同一家的第二个实例也认得出", () => {
  it("显式 kind 优先", () => {
    assert.equal(knownProviderOf(p("my-ds", { kind: "deepseek" })).id, "deepseek");
  });
  it("老数据没有 kind：id 本身、-N 与 -copy 后缀都认回目录条目", () => {
    assert.equal(knownProviderOf(p("deepseek")).id, "deepseek");
    assert.equal(knownProviderOf(p("deepseek-2")).id, "deepseek");
    assert.equal(knownProviderOf(p("kimi-coding-3", { api: "anthropic-messages" })).id, "kimi-coding");
    assert.equal(knownProviderOf(p("zhipu-coding-copy2", { api: "anthropic-messages" })).id, "zhipu-coding");
  });
  it("后缀剥离不误伤：zhipu-coding 不会被认成 zhipu", () => {
    assert.equal(knownProviderOf(p("zhipu-coding", { api: "anthropic-messages" })).id, "zhipu-coding");
  });
  it("认不出的按协议落兼容；不认识的 kind 当没写", () => {
    assert.equal(knownProviderOf(p("proma")).id, "openai-compatible");
    assert.equal(knownProviderOf(p("gw", { api: "anthropic-messages" })).id, "anthropic-compatible");
    assert.equal(knownProviderOf(p("gw", { kind: "nope" })).id, "openai-compatible");
  });
  it("第二个套餐实例同样按套餐计费", () => {
    assert.equal(isPlanBilling(p("kimi-coding-2", { api: "anthropic-messages" })), true);
    assert.equal(isPlanBilling(p("my-kimi", { kind: "kimi-coding", api: "anthropic-messages" })), true);
  });
});

describe("isPlanBilling —— 两句话不能混", () => {
  it("Coding Plan 与 Step Plan 是订阅制", () => {
    assert.equal(isPlanBilling(p("zhipu-coding")), true);
    assert.equal(isPlanBilling(p("zai")), true);
    assert.equal(isPlanBilling(p("stepfun")), true);
  });

  it("白名单补的参数能取到，且只含确知字段（stepfun 官方页没写输出上限）", () => {
    const params = knownModelParams("step-3.7-flash");
    assert.equal(params.contextWindow, 256_000);
    assert.equal("maxTokens" in params, false);
    // deepseek-v4-flash 目录已有窗口 / 档位表：白名单只补默认档，不重复写窗口
    assert.deepEqual(knownModelParams("deepseek-v4-flash"), { defaultThinkingLevel: "high" });
    assert.equal(knownModelParams("deepseek-v4-flash-vision-exp").contextWindow, 1_000_000);
    assert.equal(knownModelParams("deepseek-v4-flash-vision-exp").maxTokens, 384_000);
  });

  it("只按模型 id 查：自建网关接进来的同一型号照样吃得到白名单", () => {
    // glm-5.3-flash 挂在 zhipu-coding 名下，但 anthropic 兼容网关也在用这个型号
    assert.equal(knownModelParams("glm-5.3-flash").contextWindow, 1_000_000);
    assert.deepEqual(knownModelParams("no-such-model"), {});
  });

  it("标准 API 按量计费", () => {
    assert.equal(isPlanBilling(p("zhipu")), false);
    assert.equal(isPlanBilling(p("deepseek")), false);
  });

  it("认不得的 id（自建网关）一律当按量算——藏起真实花费比多一行估价更坏", () => {
    assert.equal(isPlanBilling(p("my-own-gateway")), false);
    assert.equal(isPlanBilling(p("")), false);
  });
});

describe("claude 的思考档按型号（白名单纠目录的「缺键默认支持」）", () => {
  test("claude-opus-5 能关思考：off + low→max，没有 minimal", () => {
    const params = knownModelParams("claude-opus-5");
    assert.deepEqual(params.thinkingLevels, ["off", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(params.reasoning, undefined); // reasoning 归目录（true），白名单不重复声明
  });

  test("fable 系与 opus-5-5 思考恒开：没有 off", () => {
    assert.equal(knownModelParams("claude-fable-5").thinkingLevels?.includes("off"), false);
    assert.equal(knownModelParams("claude-fable-5-1").thinkingLevels?.includes("off"), false);
    assert.equal(knownModelParams("claude-opus-5-5").thinkingLevels?.includes("off"), false);
  });

  test("opus-5-5 是唯一默认 medium 的 claude（官方 effort 文档）", () => {
    assert.equal(knownModelParams("claude-opus-5-5").defaultThinkingLevel, "medium");
    assert.equal(knownModelParams("claude-opus-5-5").contextWindow, 1_000_000);
  });

  test("声明 adaptiveThinking 的型号必须同时写档位表——注册链靠它生成 effort 档位表", () => {
    assert.equal(knownModelParams("claude-opus-5-5").adaptiveThinking, true);
    for (const provider of KNOWN_PROVIDERS) {
      for (const [modelId, params] of Object.entries(provider.modelParams ?? {})) {
        if (params.adaptiveThinking === true) assert.ok(params.thinkingLevels !== undefined, modelId);
      }
    }
  });

  test("自建网关的 claude 同样吃到口径（knownModelParams 只按模型 id 查）", () => {
    assert.deepEqual(knownModelParams("claude-fable-5-1").thinkingLevels, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("默认思考档（wafo 2026-09-23：重启落模型默认档）", () => {
  test("同时写了档位表与默认档的，默认档必须在档位表里——否则默认就是一个发不出去的档", () => {
    for (const provider of KNOWN_PROVIDERS) {
      for (const [modelId, params] of Object.entries(provider.modelParams ?? {})) {
        if (params.thinkingLevels === undefined || params.defaultThinkingLevel === undefined) continue;
        assert.ok(
          params.thinkingLevels.includes(params.defaultThinkingLevel),
          `${modelId} 的默认档 ${params.defaultThinkingLevel} 不在 ${params.thinkingLevels.join("/")} 里`,
        );
      }
    }
  });

  test("声明了不能思考的型号不该有默认档", () => {
    for (const provider of KNOWN_PROVIDERS) {
      for (const [modelId, params] of Object.entries(provider.modelParams ?? {})) {
        if (params.reasoning === false) assert.equal(params.defaultThinkingLevel, undefined, modelId);
      }
    }
  });

  test("同一型号的两种写法共用一份口径：deepseek-flash / deepseek-v4.1-flash，k3 / kimi-k3", () => {
    assert.deepEqual(knownModelParams("deepseek-v4.1-flash"), knownModelParams("deepseek-flash"));
    assert.deepEqual(knownModelParams("kimi-k3"), knownModelParams("k3"));
    assert.equal(knownModelParams("k3").defaultThinkingLevel, "max");
  });

  test("claude-opus-4-6 没有 xhigh（官方档位表只到 low/medium/high/max），能关思考", () => {
    assert.deepEqual(knownModelParams("claude-opus-4-6").thinkingLevels, ["off", "low", "medium", "high", "max"]);
    assert.equal(knownModelParams("claude-sonnet-5").defaultThinkingLevel, "high");
  });

  test("claude 5.5 两条：都 1M / 128k、五档、adaptive 专用；sonnet 关不掉，haiku 能关且默认 medium", () => {
    const sonnet = knownModelParams("claude-sonnet-5-5");
    assert.equal(sonnet.contextWindow, 1_000_000);
    assert.equal(sonnet.maxTokens, 128_000);
    assert.equal(sonnet.reasoning, true);
    assert.equal(sonnet.adaptiveThinking, true);
    assert.deepEqual(sonnet.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(sonnet.defaultThinkingLevel, "high");

    const haiku = knownModelParams("claude-haiku-5-5");
    assert.equal(haiku.contextWindow, 1_000_000);
    assert.equal(haiku.adaptiveThinking, true);
    assert.equal(haiku.thinkingLevels?.includes("off"), true);
    assert.equal(haiku.defaultThinkingLevel, "medium");
  });
});

describe("step 的型号口径（2026-10-10 按官方模型页与 API 参考核对）", () => {
  test("step-5-preview：1M 窗口、最大输出 64k、三档思考", () => {
    const params = knownModelParams("step-5-preview");
    assert.equal(params.contextWindow, 1_000_000);
    assert.equal(params.maxTokens, 65_536);
    assert.equal(params.reasoning, true);
    assert.deepEqual(params.thinkingLevels, ["low", "medium", "high"]);
    assert.equal(params.defaultThinkingLevel, "medium");
  });

  test("识图只纠纯文本：3.5 系（含 2603）写 [\"text\"]，能收图的型号不写（落兜底 image）", () => {
    assert.deepEqual(knownModelParams("step-3.5-flash").input, ["text"]);
    assert.deepEqual(knownModelParams("step-3.5-flash-2603").input, ["text"]);
    assert.equal("input" in knownModelParams("step-3.7-flash"), false);
    assert.equal("input" in knownModelParams("step-5-preview"), false);
  });

  test("档位按型号：2603 只兼容 low / high，其余三条是 low / medium / high", () => {
    assert.deepEqual(knownModelParams("step-3.5-flash-2603").thinkingLevels, ["low", "high"]);
    assert.deepEqual(knownModelParams("step-3.7-flash").thinkingLevels, ["low", "medium", "high"]);
    assert.deepEqual(knownModelParams("step-5-preview").thinkingLevels, ["low", "medium", "high"]);
  });
});

describe("opencode-go 的模型口径（2026-10-10 按网关自己的 /v1/models 清单与 models.dev 元数据）", () => {
  test("step-5-preview-free 与 stepfun 的 step-5-preview 同一条口径（同一个模型的免费档）", () => {
    assert.deepEqual(knownModelParams("step-5-preview-free"), knownModelParams("step-5-preview"));
    assert.equal(knownModelParams("step-5-preview-free").defaultThinkingLevel, "medium");
  });

  test("目录没收的新型号拿到窗口 / 输出——不再是 128k / 8k 兜底", () => {
    assert.equal(knownModelParams("space-bunny").contextWindow, 1_048_576);
    assert.equal(knownModelParams("space-bunny").maxTokens, 524_288);
    assert.equal(knownModelParams("mimo-v2.6-pro").contextWindow, 1_048_576);
    assert.equal(knownModelParams("longcat-2.5-preview-free").maxTokens, 131_072);
    assert.equal(knownModelParams("hy4-preview").maxTokens, 64_000);
  });

  test("档位只写有把握的：拿不准的型号不声明 reasoning（声明了就会默认发 medium，可能 400）", () => {
    assert.equal("reasoning" in knownModelParams("mimo-v2.6-pro"), false);
    assert.equal("reasoning" in knownModelParams("hy4-preview"), false);
    assert.deepEqual(knownModelParams("space-bunny").thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    // 默认档落 medium，在支持集内——不会把用户送到一个发不出去的档
    assert.equal(defaultThinkingLevel("space-bunny", knownModelParams("space-bunny").thinkingLevels), "medium");
  });
});
