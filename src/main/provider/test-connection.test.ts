import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestRequest } from "./test-connection.ts";

/** 探测请求按协议分：地址、鉴权头、请求体各一套口径（厂商差异只是 baseUrl 与 headers） */
describe("buildTestRequest", () => {
  const base = { apiKey: "sk-x", modelId: " m-1 " };

  test("Anthropic Messages：/v1/messages + x-api-key", () => {
    const req = buildTestRequest({ ...base, api: "anthropic-messages", baseUrl: "https://api.anthropic.com/" });
    assert.equal(req.url, "https://api.anthropic.com/v1/messages");
    assert.equal(req.headers["x-api-key"], "sk-x");
    assert.deepEqual(req.body, { model: "m-1", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  });

  test("OpenAI Chat：/chat/completions + Bearer；网关要求的额外头原样带上", () => {
    const req = buildTestRequest({
      ...base,
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      headers: { "x-opencode-session": "s" },
    });
    assert.equal(req.url, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(req.headers.Authorization, "Bearer sk-x");
    assert.equal(req.headers["x-opencode-session"], "s");
  });

  test("OpenAI Responses：/responses，max_output_tokens 取下限 16（填 1 会被 400）", () => {
    const req = buildTestRequest({ ...base, api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    assert.equal(req.url, "https://api.openai.com/v1/responses");
    assert.equal(req.headers.Authorization, "Bearer sk-x");
    assert.deepEqual(req.body, { model: "m-1", input: "hi", max_output_tokens: 16 });
  });

  test("Gemini 原生：型号进路径，只带 x-goog-api-key", () => {
    const req = buildTestRequest({
      ...base,
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    assert.equal(req.url, "https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent");
    assert.equal(req.headers["x-goog-api-key"], "sk-x");
    assert.equal("Authorization" in req.headers, false);
  });
});
