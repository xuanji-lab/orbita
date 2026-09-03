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
    note: "StepFun 官方 API（Step 套餐端点，地址要带到 /v1）",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    catalogId: "opencode-go",
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
