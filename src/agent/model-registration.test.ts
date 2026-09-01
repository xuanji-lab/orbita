import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_MODEL,
  toAuthConfig,
  toFallbackModels,
  toFallbackRegistration,
  type PiModel,
} from "./model-registration.ts";

/** 目录条目的最小替身：只填断言要看的字段，其余靠结构断言不需要 */
function catalogModel(id: string, contextWindow: number, inputCost: number): PiModel {
  return {
    id,
    name: id,
    contextWindow,
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

describe("toFallbackModels —— 补注册的保留合并", () => {
  test("目录认识的 id 原样保留：官方窗口与单价不被兜底覆盖", () => {
    const glm = catalogModel("glm-4.7", 204_800, 0.6);
    const result = toFallbackModels([glm], ["glm-4.7"]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.contextWindow, 204_800);
    assert.equal(result[0]?.cost.input, 0.6);
  });

  test("目录没有的 id 落保守默认：128k 窗口、零单价（未知定价不冒充免费之外的数）", () => {
    const result = toFallbackModels([], ["my-gateway-model"]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.contextWindow, FALLBACK_MODEL.contextWindow);
    assert.equal(result[0]?.cost.input, 0);
  });

  test("混着来：一个目录条目保官方参数，一个新 id 拿兜底——补一个不砸另一个", () => {
    const glm = catalogModel("glm-4.7", 204_800, 0.6);
    const result = toFallbackModels([glm], ["glm-4.7", "glm-future-99"]);
    assert.equal(result[0]?.contextWindow, 204_800);
    assert.equal(result[1]?.contextWindow, FALLBACK_MODEL.contextWindow);
  });
});

describe("toFallbackRegistration —— 补注册必须带完整 auth 面", () => {
  const gateway = {
    apiKey: "sk-gw",
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    models: ["step-3.7-flash"],
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
