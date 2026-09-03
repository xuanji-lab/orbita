/**
 * 「从供应商获取模型」——问供应商本人，拿到的就是**这把 key、这个套餐实际能用**的清单。
 *
 * 两处教训都是实测出来的（2026-08-25，智谱 Coding Plan）：
 *
 * 1. **模型端点的路径按协议走，不是简单地 baseUrl + /models。**
 *    Anthropic 兼容的模型端点在 `{baseUrl}/v1/models`（与对话端点 `/v1/messages` 同级）。
 *    少了 `/v1` 会拿到 404。OpenAI 兼容的才是 `{baseUrl}/models`（baseUrl 已含版本段）。
 *
 * 2. **有的网关一律返回 HTTP 200，真实状态藏在 body 里**（智谱：`{"code":401,...,"success":false}`）。
 *    只看 `response.ok` 会把 404 当成「成功但没有模型」——这正是先前误报的根因。
 *
 * 这两条都是**协议级**的处理，不是按厂商特判：任何 anthropic 兼容网关都适用，
 * 任何「200 包错误」的网关都适用。厂商差异仍然只是 baseUrl 与鉴权头。
 */
export interface DiscoveredModels {
  ok: boolean;
  models: string[];
  message: string;
}

/** 各家 /models 的响应形状不统一，这里只取 id。 */
interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
  models?: Array<{ id?: unknown } | string>;
  /** 「200 包错误」的网关会带这些 */
  code?: unknown;
  msg?: unknown;
  success?: unknown;
  error?: { message?: unknown };
}

/** 模型列表端点。Anthropic 兼容与对话端点同级（都在 /v1 下）。 */
export function resolveModelsUrl(baseUrl: string, api: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // 用户可能直接填了完整对话端点；同级替换即可
  if (/\/v\d+\/messages$/.test(base)) return base.replace(/\/messages$/, "/models");
  if (api === "anthropic-messages") return `${base}/v1/models`;
  return `${base}/models`;
}

/**
 * 从响应体里判断成败。**先看 body 再看 HTTP 状态**——因为「200 包错误」的网关存在，
 * 反过来（先信状态码）会把错误当成空列表。
 */
export function parseModelsBody(payload: ModelsResponse, httpOk: boolean): DiscoveredModels {
  const bodyFailed =
    payload.success === false ||
    (typeof payload.code === "number" && payload.code !== 200) ||
    (typeof payload.code === "string" && payload.code !== "200" && payload.code !== "");
  if (bodyFailed) {
    const reason =
      (typeof payload.msg === "string" && payload.msg) ||
      (typeof payload.error?.message === "string" && payload.error.message) ||
      "the provider rejected the request";
    return { ok: false, models: [], message: `${reason} (code ${String(payload.code ?? "?")})` };
  }

  const raw = payload.data ?? payload.models ?? [];
  const models = raw
    .map((entry) => (typeof entry === "string" ? entry : entry.id))
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");

  if (models.length === 0) {
    return {
      ok: false,
      models: [],
      message: httpOk
        ? "The provider returned an empty model list."
        : "The provider returned no usable model list.",
    };
  }
  return { ok: true, models, message: `${models.length} models available on this key.` };
}

export async function discoverModels(input: {
  baseUrl: string;
  api: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<DiscoveredModels> {
  const url = resolveModelsUrl(input.baseUrl, input.api);
  /**
   * **冷连接超时重试一次。**
   *
   * 实测（wafo 2026-09-03，StepFun）：同一个 URL、同一个进程里连打三次，
   * 第一次 ETIMEDOUT，后两次正常返回 401。`api.stepfun.com` 解析到火山
   * 引擎 WAF，冷连接偶尔被卡住——不是地址错也不是鉴权错，重试就好。
   *
   * 只重试**网络层失败**（fetch 抛异常）；HTTP 回来了就是真实结果，不重试。
   */
  const first = await attemptModelsFetch(url, input);
  if (first.kind === "ok") return first.result;
  const second = await attemptModelsFetch(url, input);
  return second.kind === "ok"
    ? second.result
    : { ok: false, models: [], message: `Could not reach ${url}: ${second.reason}` };
}

type FetchAttempt =
  | { kind: "ok"; result: DiscoveredModels }
  | { kind: "unreachable"; reason: string };

async function attemptModelsFetch(
  url: string,
  input: { api: string; apiKey: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const response = await fetch(url, {
      headers: {
        // 两种鉴权头都带上：不同网关认不同的那一个，而多带一个从不出错
        Authorization: `Bearer ${input.apiKey}`,
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
        ...(input.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: ModelsResponse;
    try {
      payload = JSON.parse(text) as ModelsResponse;
    } catch {
      return {
        kind: "ok",
        result: {
          ok: false,
          models: [],
          message: `${url} did not return JSON (${response.status}). Add model ids by hand.`,
        },
      };
    }
    return { kind: "ok", result: parseModelsBody(payload, response.ok) };
  } catch (error) {
    // "fetch failed" 本身没有信息量——真实原因（ETIMEDOUT / 证书 / 拒连）在 cause 里
    const reason = error instanceof Error ? error.message : String(error);
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { kind: "unreachable", reason: code === undefined ? reason : `${reason} (${code})` };
  } finally {
    clearTimeout(timer);
  }
}
