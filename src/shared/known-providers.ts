/**
 * 我们**适配过的** provider 清单 —— 设置面下拉框的真源。
 *
 * 为什么不直接列 pi 的 41 个：pi 的目录是「模型参数」的真源，不是「怎么接入」的真源。
 * 同一个厂商的不同套餐往往是**不同的接入方式**——智谱标准 API 是 OpenAI 兼容，
 * 而 Coding Plan 走 `/api/anthropic` 是 Anthropic 兼容，pi 的目录里只有前者。
 * 把 41 个原样倒出来，用户选中「Z.AI Coding CN」却发现协议不对、模型对不上，
 * 比不给下拉框更坏。
 *
 * 所以这张表只放**我们验证过能接通的**条目，一条一条加。模型参数仍然来自 pi 的目录
 * （`catalogId` 对得上就用它的官方参数）与型号白名单（known-models.ts，按型号 id 记），
 * 这张表只负责「接入方式」。
 *
 * 对照 proma：他们的 `channel.ts` 有 24 个 ProviderType，同样是一张手写表——
 * 这部分是干净的，值得学。不该学的是 `fetchModels` 那个 15 分支 switch。
 */
import type { CatalogPreference } from "./model-defaults.ts";
import type { ProviderApi } from "./provider.ts";

export interface KnownProvider {
  /** 我们的稳定 id，也是用户看到的 identifier */
  id: string;
  /**
   * 显示名 = **厂商名**，不带计费方式的后缀（「Coding Plan」「API」）：目录按分区摆
   * （knownProviderGroup），分区标题已经说了是按量还是套餐。中文厂商用中文名（智谱、
   * 阶跃星辰）——这是厂商的名字，不是界面文案；英文界面的写法在 messages-en 的 KNOWN_LABELS。
   * 同一厂商在两个分区各有一条时 label 相同，实例的默认名靠 knownProviderDefaultName 区分。
   */
  label: string;
  api: ProviderApi;
  /** 预填的 baseUrl。空串表示必须用户自己填（兼容格式的通用入口） */
  baseUrl: string;
  /**
   * **这家网关要求的额外请求头**，随 endpoint 持久化，真实会话与测试 / 发现同源带上。
   * 现在只有 OpenCode Go 的会话头——它的网关缺这个头直接 400（无法高效路由）。
   */
  headers?: Record<string, string>;
  /**
   * 对应 pi 内建目录的 id。有值时模型参数走 pi 的官方目录，且目录里的模型进**候选池**。
   *
   * ⚠ 候选池不等于可用：目录是按厂商 id 组织的，而同一厂商的不同套餐能用的模型并不相同
   * （实例：pi 的 `zai-coding-cn` 含 `glm-5v-turbo`，但智谱 Coding Plan 实际不提供它）。
   * 这正是「发现的结果要用户提升才算数」的理由——目录不必百分百准确，候选池里多一条无害。
   */
  catalogId?: string;
  /**
   * **这家的目录说了算**：本家目录（`catalogId`）收录了的型号，参数全按目录，型号白名单
   * （known-models.ts）不覆盖；目录还没收录的型号仍由白名单补。
   *
   * 给聚合网关用：它们会收窄型号能力，型号的通用口径在它那里不成立。实例：Kimi 官方说
   * kimi-k3 有 low / high / max 三档，OpenCode Go 上只开 max 一档（models.dev 的
   * opencode-go 条目，models.dev 由 OpenCode 团队维护；pi 目录同口径）。白名单按 id
   * 全局生效的话，菜单会给出三档，选 low 实际被 pi 夹回 max（2026-10-24 实测）。
   * 缺省 = 白名单优先于目录（白名单存在的意义就是赶在目录前面纠错）。
   */
  catalogAuthoritative?: boolean;
  /**
   * **这家是按用量计费还是按套餐**。决定用量菜单里该不该有「花了多少钱」那一行。
   *
   * `metered` 说花了多少钱；`plan` 什么都不说——**两句话不能混**。
   * 包月用户看到 `$0.062` 第一反应是「我不是包月吗」（wafo 2026-09-03 实测）：
   * 那个数字是拿 API 价目表算出来的**估价**，跟他这个月的账单毫无关系。
   *
   * 套餐还剩多少（额度 / 到期）要另接厂商接口，**今天不做**：这里只负责不说错话。
   * 缺省 = `metered`：不知道的当按量算，那是绝大多数（自建网关也落在这一档）。
   */
  billing?: "metered" | "plan";
  /** 一句话说明这条什么时候该选 */
  note: string;
  /**
   * 这一条不用 API key，而是浏览器 OAuth 登录（目前只有 Anthropic 一家：
   * Claude Pro / Max 订阅，凭据自动续期，见 main/provider/oauth.ts）。
   * 设置面对这种条目不画密钥框，只给登录按钮；upsert 时 scheme 落 oauth。
   */
  auth?: "oauth";
}

export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    catalogId: "deepseek",
    note: "DeepSeek 官方 API",
  },
  {
    id: "zhipu",
    label: "智谱",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    catalogId: "zai-coding-cn",
    note: "智谱开放平台标准 API（按 token 计费）",
  },
  {
    id: "claude",
    label: "Claude",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    catalogId: "anthropic",
    billing: "plan",
    auth: "oauth",
    // claude 各型号的档位 / 默认档在型号白名单里（known-models.ts，按 id 生效），这里不用声明
    note: "Claude Pro / Max 订阅，浏览器登录授权，令牌自动续期",
  },
  {
    id: "zhipu-coding",
    label: "智谱",
    api: "anthropic-messages",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    catalogId: "zai-coding-cn",
    billing: "plan",
    note: "GLM Coding Plan 订阅，走 Anthropic 兼容端点",
  },
  {
    id: "zai",
    label: "Z.AI",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    catalogId: "zai",
    // 端点就是 `/coding/paas/`——与国内站 Coding Plan 同一套餐制
    billing: "plan",
    note: "智谱国际站的 GLM Coding Plan，与国内站账号不通用",
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    api: "openai-completions",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    // pi 目录未收录 stepfun：参数靠型号白名单（known-models.ts）或手填，行摘要会如实标注走兜底
    // **Step Plan 是订阅制**（Credit 月池，platform.stepfun.com/docs/zh/step-plan）
    billing: "plan",
    note: "Step Plan 订阅（地址要带到 /v1）",
  },
  {
    id: "kimi-coding",
    label: "Kimi",
    /*
     * Kimi 会员（Kimi Code）的编程端点。走 Anthropic 兼容协议——与 pi 内建的 kimi-coding
     * 条目同一个 baseUrl 与协议（客户端接 /v1/messages），模型参数（k3 / k3-256k /
     * kimi-for-coding）直接继承它的目录。不走 OpenAI 兼容的 /coding/v1：那条路要靠
     * pi-ai 补丁把 api.kimi.com 认成 Moonshot 才不发 developer 角色，Anthropic 协议
     * 没有这个问题。
     */
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding",
    catalogId: "kimi-coding",
    billing: "plan",
    note: "Kimi Code 会员订阅，走 Anthropic 兼容端点",
  },
  {
    id: "opencode-go",
    label: "OpenCode",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    catalogId: "opencode-go",
    // 聚合网关会收窄型号能力（kimi-k3 只开 max）：目录收录的型号以目录为准，理由见字段注释
    catalogAuthoritative: true,
    // 网关硬要求（缺了 400 MissingSessionID）：这是**探活兜底**的占位值——真实会话
    // 在开轮 / 换模型时由 opencode-session.ts 按会话 id 覆盖它（OpenCode 要求每个会话
    // 一个稳定 id，共用常量会让路由与前缀缓存失去意义）。
    headers: { "x-opencode-session": "orbita" },
    // OpenCode Go 是月费订阅（opencode.ai/go：$10/月，额度制）；按量计费的是 Zen，不是这个端点
    billing: "plan",
    note: "OpenCode Go 订阅——一个 key 调用多家开源模型（DeepSeek / MiniMax…）",
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic 兼容",
    api: "anthropic-messages",
    baseUrl: "",
    note: "自建网关 / 私有部署，客户端会在你填的地址后接 /v1/messages",
  },
  {
    id: "openai-compatible",
    label: "OpenAI 兼容",
    api: "openai-completions",
    baseUrl: "",
    note: "自建网关 / 私有部署，地址要带到版本段，客户端接 /chat/completions",
  },
];

/**
 * 「添加服务商」目录的三个分区：按量计费的官方 API / 套餐订阅 / 自建的兼容网关。
 * **从条目已有的字段推出来，不另立字段**：没有预填地址（baseUrl 为空）= 兼容入口；
 * 套餐计费 = 订阅；其余 = API。新加条目只要 billing 与 baseUrl 写对，分区自动跟着对。
 */
export type KnownProviderGroup = "api" | "plan" | "custom";

export function knownProviderGroup(provider: KnownProvider): KnownProviderGroup {
  if (provider.baseUrl === "") return "custom";
  return provider.billing === "plan" ? "plan" : "api";
}

/**
 * 新建实例时预填的名字。label 在目录里有分区标题兜着；出了目录（服务商列表、模型菜单）
 * 就没有分区可看，所以 label 撞名的条目（智谱的按量与套餐）在名字里补上计费方式。
 */
export function knownProviderDefaultName(provider: KnownProvider): string {
  const collides = KNOWN_PROVIDERS.some((item) => item.id !== provider.id && item.label === provider.label);
  if (!collides) return provider.label;
  return `${provider.label}（${knownProviderGroup(provider) === "plan" ? "套餐" : "按量"}）`;
}

/** knownProviderOf 要的最小形状：Provider / ProviderDto 天然满足 */
export interface ProviderKindSource {
  id: string;
  kind?: string;
  endpoint: { api: ProviderApi };
}

function knownById(id: string): KnownProvider | undefined {
  return KNOWN_PROVIDERS.find((item) => item.id === id);
}

/**
 * 一个已配置的 provider 来自哪个目录条目。三档，先到先得：
 *   1. 显式的 `kind`（新建 / 复制时写入）；
 *   2. id 本身就是条目 id（第一个实例），或去掉 `-2` / `-copy` / `-copy3` 后缀后是——
 *      老数据没有 kind，第二个实例与副本只能靠 id 的生成规则（nextFreeId / nextCopyId）认回来；
 *   3. 都不是：按协议落到两个「兼容」条目之一。
 * 永远有答案：调用方不必再处理「认不出来」。
 */
export function knownProviderOf(provider: ProviderKindSource): KnownProvider {
  const explicit = provider.kind === undefined ? undefined : knownById(provider.kind);
  if (explicit !== undefined) return explicit;
  const byId = knownById(provider.id) ?? knownById(provider.id.replace(/-(?:\d+|copy\d*)$/, ""));
  if (byId !== undefined) return byId;
  const compatible = knownById(
    provider.endpoint.api === "anthropic-messages" ? "anthropic-compatible" : "openai-compatible",
  );
  if (compatible === undefined) throw new Error("KNOWN_PROVIDERS 缺少兼容条目");
  return compatible;
}

/**
 * 这家是不是包月制。**认不得的（自建网关）一律当按量算**——
 * 误报成包月会把真实花费藏起来，比多显示一行估价更坏。按条目判而不是按 id：
 * 第二个 Kimi 实例（kimi-coding-2）一样是套餐。
 */
export function isPlanBilling(provider: ProviderKindSource): boolean {
  return knownProviderOf(provider).billing === "plan";
}

/**
 * 这家服务商在查型号参数时的偏好（model-defaults 的 `CatalogPreference`）：去哪家目录查、
 * 接入协议、目录说不说了算。设置页、底栏菜单与主进程装配会话载荷**从同一个函数取**——
 * 三处各拼一份，迟早有一处漏了 catalogAuthoritative，菜单与会话就又对同一个型号说两套话。
 *
 * `api` 取实例自己的协议（新建表单里还没有实例时退条目的）：会话注册按实例协议走。
 */
export function catalogPreferenceOf(known: KnownProvider, api: string = known.api): CatalogPreference {
  return {
    api,
    ...(known.catalogId === undefined ? {} : { catalogId: known.catalogId }),
    ...(known.catalogAuthoritative === true ? { catalogAuthoritative: true } : {}),
  };
}
