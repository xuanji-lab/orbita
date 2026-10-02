/**
 * pi patch 的行为守卫（patches/README.md）：api.kimi.com 认作 Moonshot 端点。
 * 未 patch 的 pi 0.84.3 只认 `api.moonshot.*`，Kimi 官方 coding 端点（新域名）会被
 * 当标准 OpenAI 端点——推理模型的系统提示词以 `developer` 角色发出，Moonshot
 * 服务端当场 400「role 'developer' is not allowed」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Context, FetchFunction, Model } from "@earendil-works/pi-ai";

/** 与用户真实配置同形：自定义网关 id + openai-completions。reasoning 是触发 developer 角色的前提 */
function model(baseUrl: string): Model<"openai-completions"> {
  return {
    id: "k3",
    name: "k3",
    api: "openai-completions",
    provider: "openai-compatible-2",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  };
}

const context: Context = {
  systemPrompt: "You are a test.",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
};

/** 假 fetch：截下请求体，回一段最小 SSE（delta、finish+usage、[DONE]） */
function sseFetch(captured: { body?: { messages?: Array<{ role: string }> } }): FetchFunction {
  return async (_input, init) => {
    captured.body = JSON.parse(String(init?.body));
    const chunk = (payload: Record<string, unknown>) =>
      `data: ${JSON.stringify(payload)}\n\n`;
    const body =
      chunk({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "k3",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      }) +
      chunk({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "k3",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }) +
      "data: [DONE]\n\n";
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

/** 走完整条 stream（确保请求真的发出），返回请求里第一条消息的角色 */
async function firstInstructionRole(baseUrl: string): Promise<string> {
  const captured: { body?: { messages?: Array<{ role: string }> } } = {};
  const events = stream(model(baseUrl), context, { apiKey: "test-key", fetch: sseFetch(captured) });
  let eventCount = 0;
  for await (const _event of events) eventCount += 1;
  assert.ok(eventCount > 0, "stream 没产出任何事件——假 SSE 可能没被解析");
  const role = captured.body?.messages?.[0]?.role;
  assert.ok(role !== undefined, "假 fetch 没截到请求体");
  return role;
}

test("api.kimi.com 走 Moonshot compat：系统提示词用 system 角色（patch 守卫）", async () => {
  assert.equal(await firstInstructionRole("https://api.kimi.com/coding/v1"), "system");
});

test("标准 OpenAI 端点不受影响：推理模型仍用 developer 角色", async () => {
  assert.equal(await firstInstructionRole("https://api.openai.com/v1"), "developer");
});
