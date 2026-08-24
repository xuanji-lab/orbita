/**
 * 「从供应商获取模型」——**只有一条路径**：OpenAI 兼容的 `GET {baseUrl}/models`。
 *
 * 为什么只有一条（这是刻意的设计约束）：内建 provider 的模型清单来自 pi 的目录
 * （41 个 provider，每 4 小时从 pi.dev 刷新），离线就有、不需要网络发现。
 * 网络发现只服务于 pi 目录里没有的**自建网关**，而自建网关几乎都是 OpenAI 兼容的。
 *
 * 对照：proma 的 fetchModels 是个 15+ 分支的 switch（deepseek/kimi 打 /models、
 * 小米走硬编码预设、codex 走 SDK 目录、anthropic 系根本没有 /models 端点……），
 * 那是因为他们不用 pi 的目录、每个供应商的知识都自己维护。我们不复制那条路。
 *
 * 已知不适用：anthropic-messages 协议的网关通常没有 /models。返回结构化错误，
 * 让用户手填 —— 而不是替他猜一张预设表。
 */
export interface DiscoveredModels {
  ok: boolean;
  models: string[];
  message: string;
}

/** OpenAI 的 /models 响应形状（只取 id，其余字段各家不一，不解析）。 */
interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

export async function discoverModels(input: {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<DiscoveredModels> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
        ...(input.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        message: `${url} returned ${response.status}. This gateway may not expose /models — add model ids by hand.`,
      };
    }
    const payload = (await response.json()) as ModelsResponse;
    const models = (payload.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.trim() !== "");
    if (models.length === 0) {
      return { ok: false, models: [], message: "The gateway returned no models." };
    }
    return { ok: true, models, message: `Found ${models.length} models.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, models: [], message: `Could not reach ${url}: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}
