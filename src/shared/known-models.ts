import type { ThinkingLevel } from "./thinking.ts";

/**
 * 型号白名单 —— **按模型 id 记官方口径**，与它从哪家服务商接进来无关。
 *
 * 为什么按 id 而不是挂在服务商条目下：型号 id 是型号的身份。智谱的 glm-5.3-flash 从
 * 智谱 Coding Plan 接进来、从 Anthropic 兼容网关接进来，窗口都是 1M——按服务商查的
 * 老做法让自建网关吃不到任何补丁（wafo 2026-09-21 实测显示 128k）。这张表以前散在
 * `KNOWN_PROVIDERS[].modelParams` 里，查找时又跨全部条目扫，挂在哪只是代码组织；
 * 同一个 id 写在两个条目下时先到先得、没有任何提示。拆成一张按 id 的表之后，一个 id
 * 只能有一份口径，字面上就写不出两份。
 *
 * **快速适配通道**：pi 的目录只收录它已知的型号，厂商刚上线、或只在官方 `/models`
 * 里拉得到的型号，目录里没有——而用户已经能用了。没这条通道的后果是一个 1M 窗口的
 * 型号被当成 128k，压缩会提前很多轮触发。
 *
 * **优先于 pi 目录**（设置页、底栏菜单与会话三处同一个判定，见 model-defaults 与
 * model-registration）：它存在的意义就是赶在目录前面，顺带纠目录的错。代价是会陈旧——
 * **pi 目录收录且数值正确之后，应当把对应条目删掉**。唯一的例外是「目录说了算」的
 * 服务商（`KnownProvider.catalogAuthoritative`）：本家目录收录了的型号，白名单不覆盖。
 *
 * 只写**确知**的字段（官方口径或实测），其余仍由目录 / 兜底补。
 * 编一个数进去，就是把「1M 显示成 128k」换成「128k 显示成 1M」，更坏。
 */
export interface ModelParams {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /**
   * 这个型号真实支持的思考档。设置页 / 底栏菜单按它显示，会话注册时按它生成 pi 的
   * thinkingLevelMap（不在表里的档标 null，pi 发送前夹走；xhigh / max 映射成同名值）——
   * 菜单里能选的档就是真能发出去的档。
   */
  thinkingLevels?: ThinkingLevel[];
  /**
   * 这个型号的**默认思考档**：新任务、换模型、派子会话时，用户没手选（或手选的档
   * 这个型号不支持）就从这一档起。pi 目录没有这个概念（pi 只有一个全局默认
   * medium），所以它只能住在白名单里。只填官方口径（厂商文档写明的 API 默认 /
   * 自家 CLI 默认）；没填的型号退 medium，再按支持集夹取（见 `defaultThinkingLevel`）。
   * 同时填了 thinkingLevels 时必须落在其中（测试守着）。
   */
  defaultThinkingLevel?: ThinkingLevel;
  /**
   * 这个型号**只收 adaptive 思考**（`thinking: adaptive` + `output_config.effort`，不认
   * budget_tokens）——新 Claude 都是。目录收录的型号，注册链从目录条目的
   * `compat.forceAdaptiveThinking` 借；**目录没收录**（也借不到家族参数）的型号只能在
   * 这里声明，否则 pi 按老规矩发 budget_tokens，官方 API 不接受。只对 anthropic-messages
   * 协议的接入有意义；同时要写 thinkingLevels（注册链据此生成档位表，xhigh / max 才能
   * 作为 effort 原样送到）。
   */
  adaptiveThinking?: boolean;
}

/** DeepSeek 的档位口径：none / low / high / max（none 即 off，没有 medium） */
const DEEPSEEK_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "high", "max"];

/** deepseek-flash 与聚合网关写法 deepseek-v4.1-flash 共用（见 DeepSeek 一节的注释） */
const DEEPSEEK_FLASH: ModelParams = {
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  reasoning: true,
  thinkingLevels: DEEPSEEK_THINKING_LEVELS,
  defaultThinkingLevel: "high",
};

/** 能关思考的 claude：off + low→max（没有 minimal），API 与 Claude Code 默认都是 high */
const CLAUDE_WITH_OFF: ModelParams = {
  thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
  defaultThinkingLevel: "high",
};

/** 思考恒开的 claude（fable 系）：low→max，没有 off，默认 high */
const CLAUDE_ALWAYS_THINKING: ModelParams = {
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  defaultThinkingLevel: "high",
};

/** Kimi K3：思考恒开，low / high / max，默认 max（k3 与 kimi-k3 共用） */
const KIMI_K3: ModelParams = {
  thinkingLevels: ["low", "high", "max"],
  defaultThinkingLevel: "max",
};

export const KNOWN_MODELS: Readonly<Record<string, ModelParams>> = {
  // ── DeepSeek ──
  /*
   * 快速适配通道（2026-09-03，wafo 指出遗漏）：pi 的 deepseek 目录条目只有 v4-flash /
   * v4-pro 两个，**vision-exp 没收**——但它是官方三模型之一（Models & Pricing 页三模型
   * 共用同一行规格：1M / 384K），且 /models 拉得回。参数另有交叉印证：pi 的 opencode-go
   * 目录收录了同名模型，同为 1M/384K。pi 的 deepseek 条目补上它之后，这条可删。
   *
   * 思考档口径（2026-09-23，源：api-docs.deepseek.com 的 Thinking Mode 指南与 Models &
   * Pricing）：`reasoning_effort` 只认 none / low / high / max（没有 medium），none 即关；
   * 「Thinking mode is enabled by default」，省略时默认 high——全系同一口径。
   *
   * deepseek-flash（2026-09-10 起的官方 id，指向 V4.1-Flash）：1M 上下文、输出上限 384K、
   * 可读图。`deepseek-v4.1-flash` 是聚合网关（OpenRouter 等）对同一型号的写法，官方文档
   * 里没有这个 id——两个键共用一份参数。旧 id deepseek-v4-flash / -vision-exp 已退役但
   * 仍被接受，请求由 V4.1-Flash 承接，所以思考档口径与它相同。
   */
  "deepseek-flash": DEEPSEEK_FLASH,
  "deepseek-v4.1-flash": DEEPSEEK_FLASH,
  "deepseek-v4-flash-vision-exp": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevels: DEEPSEEK_THINKING_LEVELS,
    defaultThinkingLevel: "high",
  },
  // 这两个 pi 目录已收录（窗口 / 档位表走目录），白名单只补目录没有的默认档
  "deepseek-v4-flash": { defaultThinkingLevel: "high" },
  "deepseek-v4-pro": { defaultThinkingLevel: "high" },

  // ── 智谱 ──
  /**
   * pi 的 `zai-coding-cn` 目录里没有 flash（只到 glm-5.3），而官方 `/models` 接口
   * fetch 得到。参数向 glm-5.3 看齐：同代同系，官方口径都是 1M 上下文。
   */
  "glm-5.3-flash": {
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    reasoning: true,
    // 目录查不到这个 id（快速通道）：抄 glm-5.3 家族口径，支持集里连 medium 都没有
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "max",
  },
  /*
   * 默认档（2026-09-23，源：docs.z.ai 的 GLM-5.3 页与 Coding Plan 的 Claude Code 接入页）：
   * 5.3 全系思考强制开启、只认 low / high / max，省略时默认 max；Anthropic 兼容端点把
   * medium 折成 high、xhigh 折成 max。glm-5.3 本体走目录，这里只补默认档。
   */
  "glm-5.3": { defaultThinkingLevel: "max" },

  // ── 阶跃星辰 ──
  /*
   * 快速适配通道（2026-09-03，源：官方模型页，当日实拉）：
   *   step-3.7-flash        256K（198B MoE 旗舰多模态推理）
   *   step-3.5-flash        256K（196B MoE 旗舰语言推理）
   *   step-3.5-flash-2603   256K（3.5 的 Agent 优化变体，官方变体页写明
   *                          「基于 step-3.5-flash」，上下文随基型）
   * 三者官方页都没写输出上限——maxTokens 不填，留给兜底。
   * pi 目录收录 stepfun 之后本块整个可删（目录优先级本来就高于白名单）。
   *
   * 思考档（2026-09-23，源：platform.stepfun.ai 各模型页与 chat-completion API 参考）：
   * 三者都有 `reasoning_effort`、关不掉——所以补 reasoning: true（目录没有它们，
   * 不补就落兜底的 false，一档思考都不发）。3.7 / 3.5 认 low / medium / high，
   * 3.7 默认 medium（官方模型页）；2603 只认 low / high，默认 high——这一条出自
   * StepFun 工程师的发布文，不是文档页，半官方；3.5 默认档官方没写，不填，退 medium
   * （在支持集内）。
   */
  "step-3.7-flash": {
    contextWindow: 256_000,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    defaultThinkingLevel: "medium",
  },
  "step-3.5-flash": {
    contextWindow: 256_000,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
  },
  "step-3.5-flash-2603": {
    contextWindow: 256_000,
    reasoning: true,
    thinkingLevels: ["low", "high"],
    defaultThinkingLevel: "high",
  },

  // ── Claude ──
  // claude 的思考档**按型号**，不按家族一刀切（wafo 2026-09-23；推翻 09-22「claude
  // 没有 off」——那条对 fable 成立，对其余型号不成立）。源：platform.claude.com 的
  // thinking / effort 文档与各型号页（2026-09-23 核对）：
  // - 没有 minimal；xhigh 的显示名叫 Extra。目录按「非显式 null 即支持」会多算出
  //   minimal——这里按官方档位表纠回来。
  // - off：sonnet-5 / opus-5 / opus-4-8 / opus-4-6 能关思考；fable-5 / fable-5-1 /
  //   opus-5-5 思考恒开，关思考的请求被拒。
  // - opus-4-6 没有 xhigh（官方档位表只到 low / medium / high / max）。
  // - 默认档：省略 effort 时 API 默认 high，Claude Code 对这几个型号也落 high；
  //   唯一例外是 opus-5-5，官方默认 medium。
  "claude-sonnet-5": CLAUDE_WITH_OFF,
  "claude-opus-5": CLAUDE_WITH_OFF,
  "claude-opus-4-8": CLAUDE_WITH_OFF,
  "claude-opus-4-6": {
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    defaultThinkingLevel: "high",
  },
  "claude-fable-5": CLAUDE_ALWAYS_THINKING,
  "claude-fable-5-1": CLAUDE_ALWAYS_THINKING,
  /*
   * pi 目录还没收录 opus-5-5（也借不到家族参数：opus-5-5 ≠ opus-5），不补就落
   * 128k 兜底、且被当成不能思考。窗口 / 输出上限取官方型号总览（1M / 128K）。
   */
  "claude-opus-5-5": {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "medium",
    // 只收 adaptive + effort（官方：extended / budget 思考在 4.6 之后的型号上不被接受）；
    // 目录没它，借不到 compat.forceAdaptiveThinking，只能在这里声明
    adaptiveThinking: true,
  },

  // ── Kimi ──
  /*
   * Kimi K3（2026-09-23，源：platform.kimi.ai 的 K3 quickstart 与 Kimi Code 更新日志）：
   * 思考恒开、关不掉，`reasoning_effort` 只认 low / high / max，省略时默认 max（Kimi
   * Code 同为 max）。窗口走目录（kimi-coding 收录了 k3）。官方 API id 是 kimi-k3，
   * 网关常写作 k3——两个键共用一份。
   */
  k3: KIMI_K3,
  "kimi-k3": KIMI_K3,
};

/**
 * 这个型号 id 的白名单口径。**只按模型 id 查**：这张表记的是「这个型号的官方口径」，
 * 与它从哪家网关接进来无关。认不得的 id 返回空对象——调用方据此原样走目录 / 兜底。
 * 「目录说了算」的例外不在这里判（要看本家目录），见 model-defaults 的 `knownParamsFor`。
 */
export function knownModelParams(modelId: string): ModelParams {
  return Object.hasOwn(KNOWN_MODELS, modelId) ? (KNOWN_MODELS[modelId] ?? {}) : {};
}
