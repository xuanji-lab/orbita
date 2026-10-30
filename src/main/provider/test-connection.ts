/**
 * 测试连接 —— **按协议分支，不按厂商分支**。
 *
 * 这是与 proma 最关键的一处分歧。他们的 fetchModels / 测试连接按 ProviderType 分了
 * 15+ 个分支（每加一个厂商就加一段特判，`pi-model-registry.ts` 804 行大半是这个）。
 * 但「怎么发一个请求」只取决于**协议**：OpenAI 兼容的都发 /chat/completions，
 * Anthropic 兼容的都发 /v1/messages。厂商差异属于 baseUrl 与鉴权头，那是数据不是代码。
 *
 * 所以这里按协议分支（Anthropic Messages / OpenAI Chat / OpenAI Responses / Gemini 原生），
 * 它只随**协议**变多，不随支持的厂商变多而增长。
 */
import { anthropicOauthHeaders, isClaudeOauthToken } from "./oauth.ts";
import { discoverModels } from "./discover.ts";

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

interface TestInput {
  api: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 探测请求：发一条最短的「hi」、只要 1 个 token（Responses 协议下限是 16）。
 * 纯函数，按协议给出地址、鉴权头与请求体——测试直接断言它。
 */
export function buildTestRequest(input: {
  api: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  headers?: Record<string, string>;
}): { url: string; headers: Record<string, string>; body: unknown } {
  const base = input.baseUrl.replace(/\/+$/, "");
  const model = input.modelId.trim();
  const json = { "Content-Type": "application/json" };
  const extra = input.headers ?? {};
  if (input.api === "anthropic-messages") {
    return {
      url: `${base}/v1/messages`,
      headers: {
        ...json,
        // OAuth 访问令牌只认 Bearer + oauth beta 头（同 discover 的处理）
        ...(isClaudeOauthToken(input.apiKey)
          ? anthropicOauthHeaders(input.apiKey)
          : { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }),
        ...extra,
      },
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
    };
  }
  if (input.api === "google-generative-ai") {
    // Gemini 原生：型号在路径里，鉴权只认 x-goog-api-key（同 discover）
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { ...json, "x-goog-api-key": input.apiKey, ...extra },
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } },
    };
  }
  if (input.api === "openai-responses") {
    return {
      url: `${base}/responses`,
      headers: { ...json, Authorization: `Bearer ${input.apiKey}`, ...extra },
      // Responses 的 max_output_tokens 下限是 16，填 1 会被 400
      body: { model, input: "hi", max_output_tokens: 16 },
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: { ...json, Authorization: `Bearer ${input.apiKey}`, ...extra },
    body: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
  };
}

export async function testConnection(input: TestInput): Promise<ConnectionTestResult> {
  /**
   * **没填模型也能测**——改去问它的 `/models`。
   *
   * 上一版直接拒绝（「Add at least one model id before testing.」），而模型 id
   * 只能靠 fetch 拿——于是网关一抽风就死锁：fetch 不到 → 加不了模型 →
   * test 也点不了，用户卡在原地连「我这把 key 到底对不对」都问不出来
   * （wafo 2026-09-03，StepFun）。
   *
   * 而「这把 key 能不能用」本来就不需要模型 id：`/models` 同样要鉴权。
   * 拿得到清单就顺便告诉他有几个可选。
   */
  if (input.modelId.trim() === "") {
    const found = await discoverModels({
      baseUrl: input.baseUrl,
      api: input.api,
      apiKey: input.apiKey,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (!found.ok) return { ok: false, message: found.message };
    return found.models.length === 0
      ? { ok: true, message: "Key accepted, but the provider listed no models. Add one by hand." }
      : { ok: true, message: `Key accepted — ${found.models.length} model(s) available.` };
  }
  const { url, headers, body } = buildTestRequest(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, message: `Connected — ${input.modelId} responded.` };

    // 错误体里通常有厂商给的具体原因，比 HTTP 状态码有用得多
    const detail = (await response.text().catch(() => "")).slice(0, 240).trim();
    return {
      ok: false,
      message: `${response.status} ${response.statusText}${detail === "" ? "" : ` — ${detail}`}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { ok: false, message: `Could not reach ${url}: ${code === undefined ? reason : `${reason} (${code})`}` };
  } finally {
    clearTimeout(timer);
  }
}
