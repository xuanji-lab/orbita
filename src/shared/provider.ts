/**
 * Provider 契约 —— IPC 四层契约的第 1 层（唯一真源）。
 * 背景与完整提案见 docs/architecture/orbita_v4.5.1/29-provider-schema-proposal.md。
 *
 * 主权边界（提案 §2.2）：Provider 对象只在主进程构造 / 变更 / 持久化；
 * renderer 拿到的永远是 ProviderDto —— **密钥不过 IPC**，只有 SecretRef 与掩码预览。
 *
 * 本轮只落「配置一个 provider 并持久化」需要的字段。`discovered`（发现的模型缓存）、
 * `capabilities`（能力旗标矩阵）留到有真实调用点时再加——协议加字段是加法
 * （`oauth` 认证方式已随 Claude 订阅登录落地，见 main/provider/oauth.ts）。
 */

import { isThinkingLevel, type ThinkingLevel } from "./thinking.ts";

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

/**
 * OAuth 凭据在密钥库里的落盘形状（JSON 字符串整体加密，永不过 IPC）。
 * 账号邮箱是登录时顺手问 /v1/me 拿的展示信息，失败可空。
 */
export interface OauthCredential {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳，已扣掉安全提前量（过期前该刷新） */
  expiresAt: number;
  accountEmail: string | null;
  /**
   * 登录流程自己要带的其余字段，续期与取请求鉴权时原样还给它：ChatGPT（Codex）的
   * accountId、GitHub Copilot 的 enterpriseUrl 与 availableModelIds。Claude 没有。
   * 形状归流程（pi 的 OAuthCredential 的扩展字段），我们只负责保管，不解读。
   */
  flowData?: Record<string, unknown>;
}

export type ProviderAuth =
  | { scheme: "api_key"; secretRef: SecretRef }
  | { scheme: "oauth"; secretRef: SecretRef }
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
 * `vision` 同语义：留空 = 目录怎么说就怎么（目录没说的当纯文本）；填了 = 用户说了算
 * （厂商刚上线的多模态目录往往没跟上）。runtime 侧由 model-registration 落成 input 模态。
 */
export interface ModelDecl {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCostDecl;
  /** 覆盖声明：true = 可吃图片输入（多模态），false = 强制纯文本；缺省 = 听目录的 */
  vision?: boolean;
  /**
   * 覆盖声明：这个型号在这家服务商上**真能用**的思考档（至少一档，按词汇表顺序存）。
   * 缺省 = 继承（白名单 > 运行时报回 > 目录）。聚合网关的目录常说错——基元律动 25 个型号里
   * 18 个说能关、实际只有 7 个能关——适配不过来，交给用户自己勾（2026-10-25）。
   * 菜单与会话注册都认它：不勾的档在注册时标 null，pi 发送前夹走。
   */
  thinkingLevels?: ThinkingLevel[];
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
  /**
   * 来自哪个目录条目（`KNOWN_PROVIDERS` 的 id）。同一家可以加多个实例（不同账号 / key），
   * 第二个的 id 是 `deepseek-2` 这样的存储主键，光凭 id 认不出它是 DeepSeek——于是目录参数、
   * 套餐计费、设置页的厂商卡片都会把它当成“兼容”。缺席（老数据）时由
   * `knownProviderOf` 按 id 推断，不需要迁移。
   */
  kind?: string;
  displayName: string;
  endpoint: ProviderEndpoint;
  auth: ProviderAuth;
  models: { declared: ModelDecl[] };
}

/** 过 IPC 给 renderer 的形状：与 Provider 同构，但密钥只有掩码预览；OAuth 只有账号与在登状态。 */
export type ProviderDto = Omit<Provider, "auth"> & {
  auth:
    | { scheme: "api_key"; hasSecret: boolean; masked: string | null }
    | { scheme: "oauth"; loggedIn: boolean; account: string | null }
    | { scheme: "env"; envKeys: string[] }
    | { scheme: "none" };
};

/** upsert 入参：新建或改写一个 provider；apiKey 有值时同时写入密钥库。 */
export interface ProviderUpsertInput {
  provider: Omit<Provider, "auth"> & { auth: { scheme: ProviderAuth["scheme"] } };
  /** 明文密钥。只出现在这个方向（renderer → main），main 落库后即丢弃。 */
  apiKey?: string;
  /**
   * true = 新建：id 已被占用时拒绝（issue 落在 `id` 字段），**绝不覆盖已有的那一条**。
   * 缺省 = 按 id 改写（编辑）。新建与编辑不分开时，一个撞了名的新建会悄悄换掉原来那条连同它的密钥。
   */
  create?: boolean;
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
  if (p["kind"] !== undefined && typeof p["kind"] !== "string") {
    push("kind", "kind must be a string");
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
      const vision = model["vision"];
      if (vision !== undefined && typeof vision !== "boolean") {
        push(`models.declared[${index}].vision`, "vision must be a boolean");
      }
      // 空数组不是「继承」：继承就不写这个字段。一档都没有的型号菜单无档可选、注册后 pi 也无档可夹
      const levels = model["thinkingLevels"];
      if (levels !== undefined) {
        if (!Array.isArray(levels) || levels.length === 0) {
          push(`models.declared[${index}].thinkingLevels`, "thinkingLevels must be a non-empty array");
        } else if (!levels.every(isThinkingLevel)) {
          push(`models.declared[${index}].thinkingLevels`, "thinkingLevels has an unknown level");
        } else if (new Set(levels).size !== levels.length) {
          push(`models.declared[${index}].thinkingLevels`, "thinkingLevels has a duplicate level");
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
