import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseModelsBody, resolveModelsUrl } from "./discover.ts";

/**
 * 两组用例锁的都是**实测出来的真实行为**（2026-08-25 探测智谱 Coding Plan）：
 * 模型端点的路径按协议走，且有的网关一律返回 HTTP 200、真实状态藏在 body 里。
 */
describe("resolveModelsUrl", () => {
  test("anthropic 兼容：模型端点与对话端点同级，在 /v1 下", () => {
    assert.equal(
      resolveModelsUrl("https://open.bigmodel.cn/api/anthropic", "anthropic-messages"),
      "https://open.bigmodel.cn/api/anthropic/v1/models",
    );
    // 实测：少了 /v1 拿到的是 404 —— 这条用例就是防止再退回去
    assert.notEqual(
      resolveModelsUrl("https://open.bigmodel.cn/api/anthropic", "anthropic-messages"),
      "https://open.bigmodel.cn/api/anthropic/models",
    );
  });

  test("openai 兼容：baseUrl 已含版本段，直接接 /models", () => {
    assert.equal(
      resolveModelsUrl("https://api.deepseek.com", "openai-completions"),
      "https://api.deepseek.com/models",
    );
    assert.equal(
      resolveModelsUrl("https://open.bigmodel.cn/api/paas/v4/", "openai-completions"),
      "https://open.bigmodel.cn/api/paas/v4/models",
    );
  });

  test("用户填了完整对话端点：同级替换成 /models", () => {
    assert.equal(
      resolveModelsUrl("https://gateway.example.com/v1/messages", "anthropic-messages"),
      "https://gateway.example.com/v1/models",
    );
  });
});

describe("parseModelsBody", () => {
  test("「200 包错误」的网关：认 body 里的 code，不认 HTTP 状态", () => {
    // 实测智谱返回的原样形状
    const result = parseModelsBody(
      { code: 401, msg: "令牌已过期或验证不正确", success: false },
      true,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /令牌已过期/);
    assert.match(result.message, /401/);
  });

  test("404 也被包在 200 里——不能当成「成功但没有模型」", () => {
    const result = parseModelsBody({ code: 500, msg: "404 NOT_FOUND", success: false }, true);
    assert.equal(result.ok, false);
    assert.match(result.message, /404 NOT_FOUND/);
  });

  test("正常响应：从 data[] 取 id", () => {
    const result = parseModelsBody({ data: [{ id: "glm-5.3" }, { id: "glm-4.7" }] }, true);
    assert.deepEqual(result.models, ["glm-5.3", "glm-4.7"]);
    assert.equal(result.ok, true);
  });

  test("兼容 models[] 与字符串数组两种形状", () => {
    assert.deepEqual(parseModelsBody({ models: [{ id: "a" }] }, true).models, ["a"]);
    assert.deepEqual(parseModelsBody({ models: ["a", "b"] }, true).models, ["a", "b"]);
  });

  test("空列表不是成功——让用户知道要手填", () => {
    const result = parseModelsBody({ data: [] }, true);
    assert.equal(result.ok, false);
    assert.match(result.message, /empty/i);
  });

  test("没有 code 字段的正常响应不会被误判为失败", () => {
    assert.equal(parseModelsBody({ data: [{ id: "x" }] }, true).ok, true);
    assert.equal(parseModelsBody({ code: 200, data: [{ id: "x" }] }, true).ok, true);
  });

  test("脏条目被跳过，不产生空 id", () => {
    const result = parseModelsBody({ data: [{ id: "a" }, { id: "" }, { id: 42 }, {}] }, true);
    assert.deepEqual(result.models, ["a"]);
  });
});
