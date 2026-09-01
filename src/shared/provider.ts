/**
 * Provider 契约 —— IPC 四层契约的第 1 层（唯一真源）。
 * 背景与完整提案见 docs/architecture/orbita_v4.5.1/29-provider-schema-proposal.md。
 *
 * 主权边界（提案 §2.2）：Provider 对象只在主进程构造 / 变更 / 持久化；
 * renderer 拿到的永远是 ProviderDto —— **密钥不过 IPC**，只有 SecretRef 与掩码预览。
 *
 * 本轮只落「配置一个 provider 并持久化」需要的字段。`discovered`（发现的模型缓存）、
 * `capabilities`（能力旗标矩阵）、`oauth` 都留到有真实调用点时再加——协议加字段是加法。
 */

/** provider 稳定标识；用户可改 displayName，id 不变 */
export type ProviderId = string;

/**
 * 端点协议。**六种 api 名只在这里定义一份**（提案 §2.2「一份 api 枚举」）——
 * 旧实现散落三份且把 google / mistral / codex 静默折叠成 openai-completions。
 * 内核不支持的种类应在装配时显式报错，不再静默降级。
 */
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** 密钥引用。明文永不进 Provider 对象，也永不过 IPC。 */
export type SecretRef = { kind: "keychain"; account: string };

export type ProviderAuth =
  | { scheme: "api_key"; secretRef: SecretRef }
  | { scheme: "env"; envKeys: string[] }
  | { scheme: "none" };

/**
 * 模型费率，单位 **$ 每百万 token**（与 pi 的 ModelCost 同形；`tiers` 分段计价不抄——无消费者）。
 * 四档全零 = 明确声明不计费；字段缺省（整个 cost 不存在）= 未表态，交给 pi 目录或兜底。
 */
export interface ModelCostDecl {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 声明的模型。用户输入或导入产生，持久化。
 *
 * 可选参数字段是**覆盖声明**，不是 pi 目录的快照：留空 = 用目录官方值（目录不认识则落
 * 128k / 8k / 零价的兜底）；填了 = 用户说了算（目录会过时或缺失，实测 glm-5.3 目录定价全零）。
 */
export interface ModelDecl {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCostDecl;
}

export interface ProviderEndpoint {
  /** 已规范化的 base URL（主进程负责归一，renderer 不再自动改写） */
  baseUrl: string;
  api: ProviderApi;
  /** 测试连接与真实会话用**同一份** headers（旧实现只把它带进测试） */
  headers?: Record<string, string>;
}

export interface Provider {
  id: ProviderId;
  displayName: string;
  endpoint: ProviderEndpoint;
  auth: ProviderAuth;
  models: { declared: ModelDecl[] };
}

/** 过 IPC 给 renderer 的形状：与 Provider 同构，但密钥只有掩码预览。 */
export type ProviderDto = Omit<Provider, "auth"> & {
  auth:
    | { scheme: "api_key"; hasSecret: boolean; masked: string | null }
    | { scheme: "env"; envKeys: string[] }
    | { scheme: "none" };
};

/** upsert 入参：新建或改写一个 provider；apiKey 有值时同时写入密钥库。 */
export interface ProviderUpsertInput {
  provider: Omit<Provider, "auth"> & { auth: { scheme: ProviderAuth["scheme"] } };
  /** 明文密钥。只出现在这个方向（renderer → main），main 落库后即丢弃。 */
  apiKey?: string;
}

/** 校验失败项：field 用点号路径，便于表单逐项标红。 */
export interface ValidationIssue {
  field: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 边界校验（提案 §2.2「边界校验」）：`provider:upsert` 入口调用，非法则结构化报错、**不落盘**。
 * 纯函数、零依赖，main 与 renderer 表单共用同一份判定，避免两端规则漂移。
 *
 * 暂用手写校验而非 schema 库：字段只有五个，手写可被用例穷尽，也不欠一个依赖。
 * 待 `discovered` / `capabilities` 加入、规则超出手写可读范围时再换 schema 库。
 */
export function validateProvider(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  if (typeof input !== "object" || input === null) {
    return [{ field: "", message: "provider must be an object" }];
  }
  const p = input as Record<string, unknown>;

  if (typeof p["id"] !== "string" || !ID_PATTERN.test(p["id"])) {
    push("id", "id must be lowercase letters, digits or dashes (1–64 chars)");
  }
  if (typeof p["displayName"] !== "string" || p["displayName"].trim() === "") {
    push("displayName", "display name is required");
  }

  const endpoint = p["endpoint"];
  if (typeof endpoint !== "object" || endpoint === null) {
    push("endpoint", "endpoint is required");
  } else {
    const e = endpoint as Record<string, unknown>;
    const baseUrl = e["baseUrl"];
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      push("endpoint.baseUrl", "base URL is required");
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      push("endpoint.baseUrl", "base URL must start with http:// or https://");
    }
    if (!PROVIDER_APIS.includes(e["api"] as ProviderApi)) {
      push("endpoint.api", `api must be one of: ${PROVIDER_APIS.join(", ")}`);
    }
    const headers = e["headers"];
    if (headers !== undefined) {
      if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
        push("endpoint.headers", "headers must be an object of string values");
      } else if (Object.values(headers).some((v) => typeof v !== "string")) {
        push("endpoint.headers", "every header value must be a string");
      }
    }
  }

  const models = p["models"];
  const declared =
    typeof models === "object" && models !== null
      ? (models as Record<string, unknown>)["declared"]
      : undefined;
  if (!Array.isArray(declared)) {
    push("models.declared", "declared models must be an array (may be empty)");
  } else {
    const seen = new Set<string>();
    declared.forEach((m, index) => {
      if (typeof m !== "object" || m === null) {
        push(`models.declared[${index}]`, "model must be an object");
        return;
      }
      const model = m as Record<string, unknown>;
      const id = model["id"];
      if (typeof id !== "string" || id.trim() === "") {
        push(`models.declared[${index}].id`, "model id is required");
        return;
      }
      if (seen.has(id)) push(`models.declared[${index}].id`, `duplicate model id "${id}"`);
      seen.add(id);
      // 参数是覆盖声明：只校验「填了的」，留空完全合法。isFinite 拦住表单 Number("…") 产出的 NaN
      for (const field of ["contextWindow", "maxTokens"] as const) {
        const value = model[field];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          push(`models.declared[${index}].${field}`, `${field} must be a positive number`);
        }
      }
      const cost = model["cost"];
      if (cost !== undefined) {
        if (typeof cost !== "object" || cost === null) {
          push(`models.declared[${index}].cost`, "cost must be an object");
        } else {
          for (const rate of ["input", "output", "cacheRead", "cacheWrite"] as const) {
            const value = (cost as Record<string, unknown>)[rate];
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
              push(`models.declared[${index}].cost.${rate}`, `cost.${rate} must be a number ≥ 0`);
            }
          }
        }
      }
    });
  }

  return issues;
}

/** base URL 归一：去尾斜杠。主进程独占（提案：renderer 不再自动改写 URL）。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** 掩码预览：只保留前 3 后 4，中间省略。密钥本身永不离开主进程。 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "…";
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}
