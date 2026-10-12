/**
 * 测试连接 —— **按协议分支，不按厂商分支**。
 *
 * 这是与 proma 最关键的一处分歧。他们的 fetchModels / 测试连接按 ProviderType 分了
 * 15+ 个分支（每加一个厂商就加一段特判，`pi-model-registry.ts` 804 行大半是这个）。
 * 但「怎么发一个请求」只取决于**协议**：OpenAI 兼容的都发 /chat/completions，
 * Anthropic 兼容的都发 /v1/messages。厂商差异属于 baseUrl 与鉴权头，那是数据不是代码。
 *
 * 所以这里只有两个分支，而且它不会随支持的厂商变多而增长。
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
  const base = input.baseUrl.replace(/\/+$/, "");
  const anthropic = input.api === "anthropic-messages";
  const url = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(anthropic
      ? // OAuth 访问令牌只认 Bearer + oauth beta 头（同 discover 的处理）
        isClaudeOauthToken(input.apiKey)
        ? anthropicOauthHeaders(input.apiKey)
        : { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${input.apiKey}` }),
    ...(input.headers ?? {}),
  };
  const body = anthropic
    ? { model: input.modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }
    : { model: input.modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

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
