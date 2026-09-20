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
 * （`catalogId` 对得上就用它的官方参数），这张表只负责「接入方式」。
 *
 * 对照 proma：他们的 `channel.ts` 有 24 个 ProviderType，同样是一张手写表——
 * 这部分是干净的，值得学。不该学的是 `fetchModels` 那个 15 分支 switch。
 */
import type { ProviderApi } from "./provider.ts";

export interface KnownProvider {
  /** 我们的稳定 id，也是用户看到的 identifier */
  id: string;
  /** 显示名。中文厂商保留中文——这是厂商的名字，不是界面文案 */
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
  /**
   * **快速适配通道：我们自己补的模型参数。**
   *
   * pi 的目录每 4 小时从 pi.dev 刷新，但**只能刷到 pi 已经收录的模型**。
   * 厂商刚上线、或者只在官方 `/models` 里 fetch 得到的型号，目录里没有——
   * 而用户已经能用了。没这条通道的后果是一个 1M 窗口的模型被当成 128k，
   * 压缩会提前很多轮就触发。
   *
   * **优先于 pi 目录**：它存在的意义就是赶在目录前面，顺带也能纠目录的错。
   * 代价是它会陈旧——**pi 目录收录且数值正确之后，应当把对应条目删掉**。
   *
   * 只写**确知**的字段（官方口径或实测），其余仍由目录 / 兑底补。
   * 编一个数进去，就是把「1M 显示成 128k」换成「128k 显示成 1M」，更坏。
   */
  modelParams?: Record<string, { contextWindow?: number; maxTokens?: number }>;
  /** 一句话说明这条什么时候该选 */
  note: string;
}

export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    catalogId: "deepseek",
    /**
     * 快速适配通道（2026-09-03，wafo 指出遗漏）：pi 的 deepseek 目录条目
     * 只有 v4-flash / v4-pro 两个，**vision-exp 没收**——但它是官方三模型之一
     * （Models & Pricing 页三模型共用同一行规格：1M / 384K），且 /models 拉得回。
     * 参数另有交叉印证：pi 的 opencode-go 目录收录了同名模型，同为 1M/384K。
     * pi 的 deepseek 条目补上它之后，这条可删。
     */
    modelParams: {
      "deepseek-v4-flash-vision-exp": { contextWindow: 1_000_000, maxTokens: 384_000 },
    },
    note: "DeepSeek 官方 API",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    catalogId: "zai-coding-cn",
    note: "智谱开放平台标准 API（按 token 计费）",
  },
  {
    id: "zhipu-coding",
    label: "智谱 Coding Plan",
    api: "anthropic-messages",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    catalogId: "zai-coding-cn",
    billing: "plan",
    modelParams: {
      /**
       * pi 的 `zai-coding-cn` 目录里没有 flash（只到 glm-5.3），
       * 而官方 `/models` 接口 fetch 得到。参数向 glm-5.3 看齐：
       * 同代同系，官方口径都是 1M 上下文。
       */
      "glm-5.3-flash": { contextWindow: 1_000_000, maxTokens: 131_072 },
    },
    note: "Coding Plan 订阅，走 Anthropic 兼容端点",
  },
  {
    id: "zai",
    label: "Z.AI (国际)",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    catalogId: "zai",
    // 端点就是 `/coding/paas/`——与国内站 Coding Plan 同一套餐制
    billing: "plan",
    note: "智谱国际站，与国内站账号不通用",
  },
  {
    id: "stepfun",
    label: "StepFun",
    api: "openai-completions",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    // pi 目录未收录 stepfun：参数靠网关 Fetch 或手填，行摘要会如实标注走兜底
    // **Step Plan 是订阅制**（Credit 月池，platform.stepfun.com/docs/zh/step-plan）
    billing: "plan",
    /**
     * 快速适配通道（2026-09-03，源：官方模型页，当日实拉）：
     *   step-3.7-flash        256K（198B MoE 旗舰多模态推理）
     *   step-3.5-flash        256K（196B MoE 旗舰语言推理）
     *   step-3.5-flash-2603   256K（3.5 的 Agent 优化变体，官方变体页写明
     *                          「基于 step-3.5-flash」，上下文随基型）
     * 三者官方页都没写输出上限——maxTokens 不填，留给兜底。
     * pi 目录收录 stepfun 之后本块整个可删（目录优先级本来就高于白名单）。
     */
    modelParams: {
      "step-3.7-flash": { contextWindow: 256_000 },
      "step-3.5-flash": { contextWindow: 256_000 },
      "step-3.5-flash-2603": { contextWindow: 256_000 },
    },
    note: "StepFun 官方 API（Step 套餐端点，地址要带到 /v1）",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    catalogId: "opencode-go",
    // 网关硬要求（缺了 400 MissingSessionID）：会话头用于前缀缓存路由，任意稳定值即可
    headers: { "x-opencode-session": "orbita" },
    note: "OpenCode Zen 聚合网关——一个 key 调用多家模型（DeepSeek / MiniMax…）",
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
 * 这家是不是包月制。**认不得的 id（自建网关、以后新加的）一律当按量算**——
 * 误报成包月会把真实花费藏起来，比多显示一行估价更坏。
 */
export function isPlanBilling(providerId: string): boolean {
  return KNOWN_PROVIDERS.find((item) => item.id === providerId)?.billing === "plan";
}

/**
 * 我们自己补的模型参数。**优先于 pi 目录**（见 `modelParams` 的说明）。
 * 认不得的 id 返回空对象——调用方据此原样走目录 / 兜底。
 *
 * **只按模型 id 查，跨全部条目**：这张表记的是「这个型号的官方口径」，
 * 与它从哪家网关接进来无关。按 (provider, model) 查的老签名会让自建网关
 * （`anthropic-compatible`）吃不到任何补丁——glm-5.3-flash 的 1M 明明在表里，
 * 却因为不是从 `zhipu-coding` 接进来的而显示 128k（wafo 2026-09-21 实测）。
 * 代价是同名 id 只能有一份口径；表里都是确知的官方参数，本就不该分叉。
 */
export function knownModelParams(modelId: string): { contextWindow?: number; maxTokens?: number } {
  for (const item of KNOWN_PROVIDERS) {
    const params = item.modelParams?.[modelId];
    if (params !== undefined) return params;
  }
  return {};
}
