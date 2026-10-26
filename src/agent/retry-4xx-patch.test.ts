/**
 * pi patch 的行为守卫（patches/README.md）：错误带明确的 4xx（除 408 / 429）不重试。
 * 未 patch 的 pi 0.84.3 用正则判可重试，`server.?error` 会命中 OpenCode 写在 403 / 400
 * 错误体里的 `"type":"server_error"`——永久错误按指数退避重试到上限（8 次约 4 分钟），
 * 前 5 次界面不显示，用户看到的就是一直「回应中」。
 *
 * pi-coding-agent 的 AgentSession._isRetryableError 与压缩的 retryAssistantCall 都直接调
 * 这一个函数，守住它即守住两条重试路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

function failed(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "opencode-go",
    model: "gpt-5.6-luna",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

const retryable = (errorMessage: string): boolean => isRetryableAssistantError(failed(errorMessage));

test("OpenCode 的永久 4xx（错误体写成 server_error）不重试——两条用户实测原文", () => {
  assert.equal(
    retryable(
      'OpenAI API error (403): {"type":"server_error","message":"Upstream request failed: Model access is disabled"}',
    ),
    false,
  );
  assert.equal(
    retryable('OpenAI API error (400): {"type":"server_error","message":"Upstream request failed: Model is unavailable."}'),
    false,
  );
});

test("其他能确定状态码的 4xx 写法同样不重试", () => {
  for (const message of [
    "401 Unauthorized: invalid api key, internal error",
    '404 {"error":{"type":"server_error","message":"model not found"}}',
    "422: server_error Unprocessable Entity",
    "Request failed with status 403: server error",
    "HTTP 400 server_error",
    "Mistral API error (401): service unavailable",
  ]) {
    assert.equal(retryable(message), false, message);
  }
});

test("408 / 429 仍重试", () => {
  assert.equal(retryable('OpenAI API error (429): {"type":"rate_limit_error","message":"Too many requests"}'), true);
  assert.equal(retryable("OpenAI API error (408): request timeout"), true);
  assert.equal(retryable("429 Too Many Requests"), true);
});

test("5xx、overloaded、网络 / 传输类错误仍重试", () => {
  for (const message of [
    "OpenAI API error (502): Bad Gateway",
    "503 Service Unavailable",
    "HTTP 524: a timeout occurred",
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "fetch failed",
    "getaddrinfo ENOTFOUND api.opencode.ai",
    "socket hang up",
    "Connection error.",
  ]) {
    assert.equal(retryable(message), true, message);
  }
});

test("状态码不能确定就维持 pi 原判（宁可多重试）", () => {
  // 只有 server_error 字样、没有状态码：pi 原判可重试，不动
  assert.equal(retryable('{"type":"server_error","message":"Upstream request failed"}'), true);
  // 正文里随手出现的数字不算状态码
  assert.equal(retryable("server_error while processing 403 items"), true);
  // 外层 4xx 包着上游 5xx：有非 4xx 状态码就交回原判
  assert.equal(retryable("OpenAI API error (400): upstream returned HTTP 502, server_error"), true);
  // 有网关把限流写成 403：文本说的是限流就交回原判
  assert.equal(retryable("OpenAI API error (403): rate limit exceeded"), true);
});

test("OpenCode Go 额度类 429 仍不重试（pi 的 NON_RETRYABLE 名单不变）", () => {
  assert.equal(retryable('OpenAI API error (429): {"type":"GoUsageLimitError","message":"Monthly usage limit reached"}'), false);
  assert.equal(retryable("429 insufficient_quota"), false);
});

test("非 error 的消息与没有错误文本的一律不重试（pi 原行为）", () => {
  assert.equal(isRetryableAssistantError({ ...failed("502"), stopReason: "stop" }), false);
  assert.equal(retryable(""), false);
});

/**
 * 走真 AgentSession 跑一轮：首个回复是给定错误，其后是成功。
 * 证明 pi-coding-agent 加载到的正是打过 patch 的那份 pi-ai（node_modules 里 pi-agent-core
 * 另挂着一份 0.84.4，解析错了这里会露馅）。retry 参数显式给，不吃用户全局 settings。
 */
async function runTurn(errorMessage: string): Promise<{ calls: number; retryEvents: number }> {
  const providerId = "orbita-retry-probe";
  const faux = registerFauxProvider({ provider: providerId });
  const cwd = await mkdtemp(join(tmpdir(), "orbita-retry-4xx-"));
  try {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage }), fauxAssistantMessage("ok")]);
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { noSkills: true, extensionFactories: [] },
    });
    services.settingsManager.applyOverrides({ retry: { maxRetries: 2, baseDelayMs: 1 } });
    services.modelRuntime.registerProvider(providerId, { apiKey: "test" });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model: faux.getModel(),
    });
    let retryEvents = 0;
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") retryEvents++;
    });
    await session.prompt("hi");
    return { calls: faux.state.callCount, retryEvents };
  } finally {
    faux.unregister();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("真会话：OpenCode 403 只发一次、不进重试", async () => {
  const result = await runTurn(
    'OpenAI API error (403): {"type":"server_error","message":"Upstream request failed: Model access is disabled"}',
  );
  assert.deepEqual(result, { calls: 1, retryEvents: 0 });
});

test("真会话对照组：502 照常重试一次后成功（否则上一条什么都没证明）", async () => {
  const result = await runTurn("OpenAI API error (502): Bad Gateway");
  assert.deepEqual(result, { calls: 2, retryEvents: 1 });
});
