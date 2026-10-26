import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_MODELS, knownModelParams, modelAvatarOf } from "./known-models.ts";
import { defaultThinkingLevel } from "./model-defaults.ts";

describe("型号白名单 —— 按模型 id 记官方口径", () => {
  it("取得到，且只含确知字段（stepfun 官方页没写输出上限）", () => {
    const params = knownModelParams("step-3.7-flash");
    assert.equal(params.contextWindow, 256_000);
    assert.equal("maxTokens" in params, false);
    // deepseek-v4-flash 目录已有窗口 / 档位表：白名单只补默认档，不重复写窗口
    assert.deepEqual(knownModelParams("deepseek-v4-flash"), { defaultThinkingLevel: "high" });
    assert.equal(knownModelParams("deepseek-v4-flash-vision-exp").contextWindow, 1_000_000);
    assert.equal(knownModelParams("deepseek-v4-flash-vision-exp").maxTokens, 384_000);
  });

  it("只按模型 id 查：自建网关接进来的同一型号照样吃得到白名单", () => {
    // glm-5.3-flash 是智谱的型号，但 anthropic 兼容网关也在用这个 id
    assert.equal(knownModelParams("glm-5.3-flash").contextWindow, 1_000_000);
    assert.deepEqual(knownModelParams("no-such-model"), {});
  });

  it("对象原型上的键不算型号：constructor / toString 查不出东西", () => {
    assert.deepEqual(knownModelParams("constructor"), {});
    assert.deepEqual(knownModelParams("toString"), {});
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
    for (const [modelId, params] of Object.entries(KNOWN_MODELS)) {
      if (params.adaptiveThinking === true) assert.ok(params.thinkingLevels !== undefined, modelId);
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
    for (const [modelId, params] of Object.entries(KNOWN_MODELS)) {
      if (params.thinkingLevels === undefined || params.defaultThinkingLevel === undefined) continue;
      assert.ok(
        params.thinkingLevels.includes(params.defaultThinkingLevel),
        `${modelId} 的默认档 ${params.defaultThinkingLevel} 不在 ${params.thinkingLevels.join("/")} 里`,
      );
    }
  });

  test("声明了不能思考的型号不该有默认档", () => {
    for (const [modelId, params] of Object.entries(KNOWN_MODELS)) {
      if (params.reasoning === false) assert.equal(params.defaultThinkingLevel, undefined, modelId);
    }
  });

  test("同一型号的两种写法共用一份口径：deepseek-flash / deepseek-v4.1-flash，K3.1 Pro 的四个 id", () => {
    assert.deepEqual(knownModelParams("deepseek-v4.1-flash"), knownModelParams("deepseek-flash"));
    for (const id of ["k3.1-pro-highspeed", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
      assert.deepEqual(knownModelParams(id), knownModelParams("k3.1-pro"), id);
    }
  });

  test("K3 两处默认档不同：Kimi Code 的 k3 / k3-256k 默认 high，开放平台的 kimi-k3 默认 max", () => {
    assert.equal(knownModelParams("k3").defaultThinkingLevel, "high");
    assert.equal(knownModelParams("k3-256k").defaultThinkingLevel, "high");
    assert.equal(knownModelParams("kimi-k3").defaultThinkingLevel, "max");
    for (const id of ["k3", "k3-256k", "kimi-k3"]) {
      assert.deepEqual(knownModelParams(id).thinkingLevels, ["low", "high", "max"], id);
    }
  });

  test("claude-opus-4-6 没有 xhigh（官方档位表只到 low/medium/high/max），能关思考", () => {
    assert.deepEqual(knownModelParams("claude-opus-4-6").thinkingLevels, ["off", "low", "medium", "high", "max"]);
    assert.equal(knownModelParams("claude-sonnet-5").defaultThinkingLevel, "high");
  });
});

// ── 以下移植自 #180（@XIAOZF99，2026-10-10），白名单从服务商条目挪到 known-models 后改了取法 ──

describe("claude 5.5（2026-10-10 按官方 effort / thinking 文档）", () => {
  test("都 1M / 128k、五档、adaptive 专用；sonnet 关不掉，haiku 能关且默认 medium", () => {
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

describe("opencode-go 网关上目录还没收录的型号（models.dev 元数据）", () => {
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

  test("模态同样只纠纯文本：hy4-preview 写 [\"text\"]，收图的型号不写（落兜底 image）", () => {
    assert.deepEqual(knownModelParams("hy4-preview").input, ["text"]);
    assert.equal("input" in knownModelParams("mimo-v2.6-flash"), false);
    assert.equal("input" in knownModelParams("longcat-2.5-preview-free"), false);
  });

  test("档位只写有把握的：拿不准的型号不声明 reasoning（声明了就会默认发 medium，可能 400）", () => {
    assert.equal("reasoning" in knownModelParams("mimo-v2.6-pro"), false);
    assert.equal("reasoning" in knownModelParams("hy4-preview"), false);
    assert.deepEqual(knownModelParams("space-bunny").thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    // 默认档落 medium，在支持集内——不会把用户送到一个发不出去的档
    assert.equal(defaultThinkingLevel("space-bunny", knownModelParams("space-bunny").thinkingLevels), "medium");
  });

  test("声明了模态的只能是纯文本：能收图的型号不写 input（写了只会与兜底漂移）", () => {
    for (const [modelId, params] of Object.entries(KNOWN_MODELS)) {
      if (params.input !== undefined) assert.deepEqual(params.input, ["text"], modelId);
    }
  });
});

describe("Kimi K3.1 Pro 与 K2.8 Preview（2026-10-24 按开放平台 quickstart 与 Kimi Code 型号表）", () => {
  test("K3.1 Pro：1M 窗口、输出默认 131072、三档思考默认 max、只收 adaptive", () => {
    const k31 = knownModelParams("k3.1-pro");
    assert.equal(k31.contextWindow, 1_048_576);
    assert.equal(k31.maxTokens, 131_072);
    assert.equal(k31.reasoning, true);
    assert.deepEqual(k31.thinkingLevels, ["low", "high", "max"]);
    assert.equal(k31.defaultThinkingLevel, "max");
    // Kimi 的 Anthropic 端点只认 output_config.effort；不声明 adaptive，选的档发不出去
    assert.equal(k31.adaptiveThinking, true);
    // 原生识图：不写 input，落兜底 image
    assert.equal("input" in k31, false);
  });

  test("kimi-for-coding（K2.8 Preview）：1M、三档默认 max；输出上限官方没写就不写", () => {
    const k28 = knownModelParams("kimi-for-coding");
    assert.equal(k28.contextWindow, 1_048_576);
    assert.deepEqual(k28.thinkingLevels, ["low", "high", "max"]);
    assert.equal(k28.defaultThinkingLevel, "max");
    assert.equal("maxTokens" in k28, false);
  });
});

describe("型号头像三级规则的前两级（原型 4，2026-10-24）", () => {
  test("第一级 · 专属头像按精确 id，不看服务商：K3.1 四个 id 同一枚，MiMo Pro / Flash 各一枚", () => {
    for (const id of ["k3.1-pro", "k3.1-pro-highspeed", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
      assert.deepEqual(modelAvatarOf(id), { kind: "own", key: "kimi-k3.1" }, id);
    }
    assert.deepEqual(modelAvatarOf("mimo-v2.6-pro-ultraspeed"), { kind: "own", key: "mimo-v2.6-pro" });
    // 公众号封面：开放平台与 Kimi Code 的 K3、两种写法的 DeepSeek V4.1 Flash 各共用一枚
    for (const id of ["k3", "k3-256k", "kimi-k3"]) assert.deepEqual(modelAvatarOf(id), { kind: "own", key: "kimi-k3" }, id);
    assert.deepEqual(modelAvatarOf("deepseek-flash"), { kind: "own", key: "deepseek-v4.1-flash" });
    assert.deepEqual(modelAvatarOf("deepseek-v4-pro"), { kind: "own", key: "deepseek-v4-pro" });
    assert.deepEqual(modelAvatarOf("glm-5.3"), { kind: "own", key: "glm-5.3" });
    assert.deepEqual(modelAvatarOf("glm-5.3-flash"), { kind: "own", key: "glm-5.3-flash" });
    // 阶跃官方 id 与 OpenCode Go 的免费档是同一个模型
    for (const id of ["step-5-preview", "step-5-preview-free"]) assert.deepEqual(modelAvatarOf(id), { kind: "own", key: "step-5-preview" }, id);
    assert.deepEqual(modelAvatarOf("mimo-v2.6-flash"), { kind: "own", key: "mimo-v2.6-flash" });
    // 千问模型市场封面：Max / Flash 各一枚
    assert.deepEqual(modelAvatarOf("qwen3.8-max"), { kind: "own", key: "qwen3.8-max" });
    assert.deepEqual(modelAvatarOf("qwen3.8-flash"), { kind: "own", key: "qwen3.8-flash" });
    assert.deepEqual(modelAvatarOf("qwen3.8-27b"), { kind: "own", key: "qwen3.8-27b" });
    // MiniMax 只有 M3.1 Flash 一枚；M3 落家族标（用户 2026-10-25 不要它的专属头像）
    assert.deepEqual(modelAvatarOf("minimax-m3.1-flash"), { kind: "own", key: "minimax-m3.1-flash" });
    for (const id of ["minimax-m3", "MiniMax-M3"]) assert.deepEqual(modelAvatarOf(id), { kind: "family", logo: "minimax" }, id);
  });

  test("GPT 按产品线各一枚（版本号写在前面）：凡是 Astra / Sol / Luna 共用，Terra 与别的落家族标", () => {
    assert.deepEqual(modelAvatarOf("gpt-6-astra"), { kind: "own", key: "gpt-astra" });
    for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]) assert.deepEqual(modelAvatarOf(id), { kind: "own", key: "gpt-sol" }, id);
    for (const id of ["gpt-6-luna", "gpt-5.6-luna", "GPT-6-Luna"]) assert.deepEqual(modelAvatarOf(id), { kind: "own", key: "gpt-luna" }, id);
    // 产品线后面只许连字符或结尾：别把 solar / lunar 认成 Sol / Luna
    assert.deepEqual(modelAvatarOf("gpt-6-solar"), { kind: "family", logo: "openai" });
    assert.deepEqual(modelAvatarOf("gpt-6-lunar-mini"), { kind: "family", logo: "openai" });
    assert.deepEqual(modelAvatarOf("gpt-5.6-terra"), { kind: "family", logo: "openai" });
    assert.deepEqual(modelAvatarOf("gpt-5.5"), { kind: "family", logo: "openai" });
  });

  test("Claude 按产品线各一枚，认前缀——新出的型号不用逐个登记", () => {
    assert.deepEqual(modelAvatarOf("claude-opus-5-5"), { kind: "own", key: "claude-opus" });
    assert.deepEqual(modelAvatarOf("claude-opus-4-6"), { kind: "own", key: "claude-opus" });
    assert.deepEqual(modelAvatarOf("claude-fable-5-1"), { kind: "own", key: "claude-fable" });
    assert.deepEqual(modelAvatarOf("claude-sonnet-5-5"), { kind: "own", key: "claude-sonnet" });
    assert.deepEqual(modelAvatarOf("claude-haiku-5-5"), { kind: "own", key: "claude-haiku" });
  });

  test("第二级 · 家族图标按 id 前缀：认不出产品线的 claude-* 退回 Claude 家族标；GLM 用 Z.ai 的标", () => {
    assert.deepEqual(modelAvatarOf("claude-instant-1"), { kind: "family", logo: "claude" });
    assert.deepEqual(modelAvatarOf("glm-5.3-highspeed"), { kind: "family", logo: "zai" });
    assert.deepEqual(modelAvatarOf("k2.9"), { kind: "family", logo: "kimi" });
    assert.deepEqual(modelAvatarOf("kimi-for-coding"), { kind: "family", logo: "kimi" });
    assert.deepEqual(modelAvatarOf("deepseek-v4-flash"), { kind: "family", logo: "deepseek" });
    assert.deepEqual(modelAvatarOf("qwen3.7-max"), { kind: "family", logo: "qwen" });
    assert.deepEqual(modelAvatarOf("MiniMax-M2.7"), { kind: "family", logo: "minimax" });
    assert.deepEqual(modelAvatarOf("step-3.7-flash"), { kind: "family", logo: "stepfun" });
    assert.deepEqual(modelAvatarOf("o3-mini"), { kind: "family", logo: "openai" });
    for (const id of ["grok-4.7", "grok-4.6"]) assert.deepEqual(modelAvatarOf(id), { kind: "family", logo: "grok" }, id);
    assert.deepEqual(modelAvatarOf("mimo-v2.5"), { kind: "family", logo: "xiaomimimo" });
  });

  test("认不出的 id 交给第三级（服务商图标，由界面层按服务商条目给）", () => {
    assert.equal(modelAvatarOf("beam-free"), undefined);
    assert.equal(modelAvatarOf("my-gateway-model"), undefined);
  });

  test("专属那一层多试一次「去掉末尾的四位日期后缀」（聚合网关带快照日期的 id）", () => {
    // 基元律动目录里的日期后缀型号用上已有头像
    assert.deepEqual(modelAvatarOf("deepseek-v4.1-flash-1017"), { kind: "own", key: "deepseek-v4.1-flash" });
    assert.deepEqual(modelAvatarOf("deepseek-v4-pro-0813"), { kind: "own", key: "deepseek-v4-pro" });
    // 剥掉后缀也命中不了表的，继续往家族 / 服务商那两级走
    assert.deepEqual(modelAvatarOf("deepseek-v4-flash-0731"), { kind: "family", logo: "deepseek" });
    // 防误伤：尾段不是日期的不受影响
    // （qwen3.6-35b 而不是 qwen3.8-27b：后者在头像 PR 里有了专属头像，拿它当「落家族标」的例子会和那边打架）
    assert.deepEqual(modelAvatarOf("qwen3.6-35b"), { kind: "family", logo: "qwen" });
    assert.deepEqual(modelAvatarOf("seed-2.1-pro"), { kind: "family", logo: "doubao-seed" });
    assert.deepEqual(modelAvatarOf("kimi-k2.7-code"), { kind: "family", logo: "kimi" });
    // 白名单里真实存在的 -YYMM 后缀（不是日期，是变体号）：剥不动，仍按原 id 匹配
    assert.deepEqual(modelAvatarOf("step-3.5-flash-2603"), { kind: "family", logo: "stepfun" });
  });

  test("家族图标补豆包（seed-*）与龙猫（longcat-*）；龙猫以外的模型落在原级", () => {
    assert.deepEqual(modelAvatarOf("seed-2.1-turbo"), { kind: "family", logo: "doubao-seed" });
    assert.deepEqual(modelAvatarOf("longcat-2.0"), { kind: "family", logo: "longcat" });
    assert.deepEqual(modelAvatarOf("longcat-2.5-preview-free"), { kind: "family", logo: "longcat" });
    // NeoHorse 没有家族标：交第三级用服务商图标（这里应认不出）
    assert.equal(modelAvatarOf("neohorse-1-9b"), undefined);
  });
});

