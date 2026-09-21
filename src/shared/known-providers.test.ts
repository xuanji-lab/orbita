import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_PROVIDERS, isPlanBilling, knownModelParams } from "./known-providers.ts";

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

describe("isPlanBilling —— 两句话不能混", () => {
  it("Coding Plan 与 Step Plan 是订阅制", () => {
    assert.equal(isPlanBilling("zhipu-coding"), true);
    assert.equal(isPlanBilling("zai"), true);
    assert.equal(isPlanBilling("stepfun"), true);
  });

  it("白名单补的参数能取到，且只含确知字段（stepfun 官方页没写输出上限）", () => {
    const params = knownModelParams("step-3.7-flash");
    assert.equal(params.contextWindow, 256_000);
    assert.equal("maxTokens" in params, false);
    // deepseek 只有 vision-exp 走白名单（pi 目录没收它）；其余两个目录已有
    assert.deepEqual(knownModelParams("deepseek-v4-flash"), {});
    assert.deepEqual(knownModelParams("deepseek-v4-flash-vision-exp"), {
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
  });

  it("只按模型 id 查：自建网关接进来的同一型号照样吃得到白名单", () => {
    // glm-5.3-flash 挂在 zhipu-coding 名下，但 anthropic 兼容网关也在用这个型号
    assert.equal(knownModelParams("glm-5.3-flash").contextWindow, 1_000_000);
    assert.deepEqual(knownModelParams("no-such-model"), {});
  });

  it("标准 API 按量计费", () => {
    assert.equal(isPlanBilling("zhipu"), false);
    assert.equal(isPlanBilling("deepseek"), false);
  });

  it("认不得的 id（自建网关）一律当按量算——藏起真实花费比多一行估价更坏", () => {
    assert.equal(isPlanBilling("my-own-gateway"), false);
    assert.equal(isPlanBilling(""), false);
  });
});

describe("claude 家族的思考档口径（白名单纠目录的「缺键默认支持」）", () => {
  test("claude-opus-5：low→max 五档，无 off 无 minimal；xhigh 是用户认识的 Extra", () => {
    const params = knownModelParams("claude-opus-5");
    assert.deepEqual(params.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(params.reasoning, undefined); // reasoning 归目录（true），白名单不重复声明
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
