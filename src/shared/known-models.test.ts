import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_MODELS, knownModelParams } from "./known-models.ts";

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

  test("同一型号的两种写法共用一份口径：deepseek-flash / deepseek-v4.1-flash，k3 / kimi-k3", () => {
    assert.deepEqual(knownModelParams("deepseek-v4.1-flash"), knownModelParams("deepseek-flash"));
    assert.deepEqual(knownModelParams("kimi-k3"), knownModelParams("k3"));
    assert.equal(knownModelParams("k3").defaultThinkingLevel, "max");
  });

  test("claude-opus-4-6 没有 xhigh（官方档位表只到 low/medium/high/max），能关思考", () => {
    assert.deepEqual(knownModelParams("claude-opus-4-6").thinkingLevels, ["off", "low", "medium", "high", "max"]);
    assert.equal(knownModelParams("claude-sonnet-5").defaultThinkingLevel, "high");
  });
});
