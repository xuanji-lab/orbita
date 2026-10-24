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
   * 这个型号收不收图片输入（pi 只有 text / image 两档）。
   *
   * **只在一个方向上写才有意义：知道它是纯文本时写 `["text"]`。** 不写落兜底的
   * `["text","image"]`——那是给「不知道」的型号下的赌注（见 model-defaults 的
   * FALLBACK_MODEL）；能收图的型号不用写（兜底本来就是 image），写了只是多一份会
   * 与兜底漂移的重复声明。step-3.5-flash 系就是必须写的那类：它是纯文本，不写就
   * 会把每一次附图都送上去换一个网关 400。
   */
  input?: ("text" | "image")[];
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

/**
 * Step 5 Preview：阶跃官方的 `step-5-preview` 与 OpenCode Go 的免费档
 * `step-5-preview-free` 是同一个模型（后者的模型页写的也是「同一模型的限时免费」），
 * 口径一份。
 */
const STEP_5_PREVIEW: ModelParams = {
  contextWindow: 1_000_000,
  maxTokens: 65_536,
  reasoning: true,
  thinkingLevels: ["low", "medium", "high"],
  defaultThinkingLevel: "medium",
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

/** Kimi 的思考档：恒开，只认 low / high / max（Kimi Code 与开放平台同一口径） */
const KIMI_THINKING_LEVELS: ThinkingLevel[] = ["low", "high", "max"];

/**
 * Kimi K3.1 Pro（含 Highspeed）：Kimi Code 的 k3.1-pro* 与开放平台的 kimi-k3.1-pro* 同一个模型，
 * 口径一份。1M 窗口、输出默认 131072（上限 1048576，我们按默认值记——会话真要的就是
 * 默认上限）、思考恒开、默认 max。
 * 目录还没收录（pi.dev 的 kimi-coding / moonshotai 都没有），所以 adaptive 只能在这里声明：
 * Kimi 的 Anthropic 协议端点只认 `output_config.effort`，不认 budget_tokens——不声明的话
 * pi 发 budget_tokens，选的档被无视，永远按默认 max 跑。
 */
const KIMI_K31_PRO: ModelParams = {
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  reasoning: true,
  thinkingLevels: KIMI_THINKING_LEVELS,
  defaultThinkingLevel: "max",
  adaptiveThinking: true,
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
   * 快速适配通道（2026-10-10 按官方文档核对，源：platform.stepfun.com 的
   * guides/models/* 模型页、step-plan/integrations/reasoning-api 与
   * api-reference/chat/chat-completion-create）：
   *   step-5-preview        1M / 最大输出 64k（模型页的「规格速览」两行：
   *                          最大输入 1M、最大输出 64k——输入与输出共用 1M 窗口）
   *   step-3.7-flash        256K（198B MoE 旗舰多模态推理）
   *   step-3.5-flash        256K（196B MoE 旗舰语言推理）
   *   step-3.5-flash-2603   256K（3.5 的 Agent 优化变体，官方变体页写明
   *                          「基于 step-3.5-flash」，上下文随基型）
   * 只有 5-preview 的模型页写了输出上限；3.7 / 3.5 三者的输出侧是「`max_tokens` 默认 INF，
   * 由上下文封顶」——没有可写的数字，maxTokens 留空（落 8192 兜底，见 FALLBACK_MODEL）。
   * pi 目录收录 stepfun 之后本块整个可删（目录优先级本来就高于白名单）。
   *
   * 思考档（同上）：5-preview 与 3.7-flash 支持 low / medium / high 三档（官方写明 medium
   * 是「默认推荐」），3.5-flash-2603 只兼容 low / high；**四者都关不掉思考**（没有 off 档），
   * 所以补 reasoning: true——目录没有它们，不补就落兜底的 false，一档思考都不发。
   * 3.5-flash（基型）的默认档官方没写，不填，退 medium（在支持集内）；2603 的默认 high
   * 出自 StepFun 工程师的发布文，不是文档页，半官方。
   *
   * 识图（官方模型页的「输入类型」逐字）：5-preview 是文本 / 图片 / 视频，3.7-flash 是
   * 图片 / 视频，**3.5-flash 与 2603 是纯文本**——后两者写 ["text"] 纠掉兜底的 image，
   * 否则每一次附图都会被网关 400；前两者收图，不写（兜底就是 image）。
   *
   * （step-5-preview 与 input 字段由 @XIAOZF99 在 #180 补，移植到本表。）
   */
  "step-5-preview": STEP_5_PREVIEW,
  "step-3.7-flash": {
    contextWindow: 256_000,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    defaultThinkingLevel: "medium",
  },
  "step-3.5-flash": {
    contextWindow: 256_000,
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["low", "medium", "high"],
  },
  "step-3.5-flash-2603": {
    contextWindow: 256_000,
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["low", "high"],
    defaultThinkingLevel: "high",
  },

  // ── OpenCode Go 网关上、pi 目录还没收录的型号 ──
  /*
   * 快速适配通道（2026-10-10，@XIAOZF99 在 #180 补，移植到本表）：网关自己的模型清单是
   * `GET https://opencode.ai/zen/go/v1/models`（当日 45 条，不需要 key），pi 目录只收
   * 到其中一部分——这里补目录没有、且**走 /chat/completions**（OpenCode Go 条目声明的协议）
   * 的那几条。数字的源是 models.dev 的 opencode-go 元数据（OpenCode 团队自己维护的
   * 注册表），**不是各家厂商的官方页**——比 stepfun 那块弱一档，但窗口写偏的代价
   * 只是压缩时机，不写就是 128k 兜底（对 1M 的型号提前 8 倍触发压缩）。
   *
   * OpenCode Go 是「目录说了算」的服务商（KnownProvider.catalogAuthoritative）：pi 目录
   * 收录了的型号以目录为准，这几条自动失效；收录之后逐条可删。
   *
   * **档位只写有把握的**：声明了 `reasoning: true` 而没写档位时，默认档会落 medium
   * 并**真的把 reasoning_effort=medium 发出去**——对只认 none / high 之类的模型就是
   * 400。所以拿不准的宁可只写窗口 / 输出（模型按自己的默认档跑，思考菜单不谎报支持集）。
   *
   * 2026-10-10 当日 #180 在 Windows 用 Go 订阅真打过：space-bunny 的 medium / xhigh / max、
   * longcat / mimo×2 / hy4 的默认档均 200；step-5-preview-free 撞免费档容量 429（同一模型
   * 的官方付费档三档全过）。
   */
  // 与 stepfun 的 step-5-preview 同一条（同一个模型的免费档，见 STEP_5_PREVIEW 的注释）
  "step-5-preview-free": STEP_5_PREVIEW,
  "space-bunny": {
    contextWindow: 1_048_576,
    maxTokens: 524_288,
    reasoning: true,
    // models.dev 的档位表就是 low → max 五档，medium 在集内（默认档落它，安全）
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  // 这四条 models.dev 没给档位：只写数字，不碰思考（档位只写有把握的，见上）。
  // longcat 与 mimo 收图（兜底 image 正好），不用写模态；hy4-preview 是**纯文本**
  // （models.dev 上 4 家 provider 的输入类型一致），写 ["text"] 纠掉兜底的 image——
  // 不写的话每一次附图都会被网关 400
  "longcat-2.5-preview-free": { contextWindow: 1_000_000, maxTokens: 131_072 },
  "mimo-v2.6-flash": { contextWindow: 1_048_576, maxTokens: 131_072 },
  "mimo-v2.6-pro": { contextWindow: 1_048_576, maxTokens: 131_072 },
  "hy4-preview": { contextWindow: 1_024_000, maxTokens: 64_000, input: ["text"] },

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
  //   例外是 opus-5-5（官方默认 medium，2026-09-23 核对）。
  // 2026-10-10 补（#180）：effort 文档写的是「多数型号默认 high，**opus-5-5 与 haiku-5-5**
  // 默认 medium」——新加的两条照此，其余不动。
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
  /*
   * claude 5.5 两兄弟（2026-10-10，@XIAOZF99 在 #180 补，源：platform.claude.com 的
   * build-with-claude/effort 与 thinking 文档、models/sonnet-5-5 与 haiku-5-5 页；
   * pi 目录（0.84.3）只到 claude-sonnet-5，两条都得自己声明——窗口 / 输出 / 档位
   * 也就都写在这里）：
   * - 都是 1M 窗口 / 单请求最大 128k 输出、都吃图（图随兜底，不重复声明）；
   *   effort 五档 low → max，没有 minimal（与其余 claude 同）。
   * - 都是 adaptive 专用：`thinking: enabled` 带 budget_tokens 直接 400，所以带
   *   adaptiveThinking（目录没它们，借不到 compat.forceAdaptiveThinking）。
   * - off：haiku-5-5 能关（官方：`disabled` 在 effort high 及以下有效，xhigh / max
   *   搭配会 400）；sonnet-5-5 关不掉（`disabled` 400，官方给的最低档是
   *   `between_tools`「不做前置思考」）——所以前者 off + low→max，后者 low→max。
   *   pi 的 agent 在 off 时不传 reasoning，请求体是 `thinking: disabled`、不带 effort，
   *   不会组合出 disabled + xhigh。
   * - 默认档：sonnet-5-5 是 high（官方：high 是 Claude API 的默认），
   *   haiku-5-5 是 medium（官方 effort 文档写明）。
   */
  "claude-sonnet-5-5": {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "high",
    adaptiveThinking: true,
  },
  "claude-haiku-5-5": {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "medium",
    adaptiveThinking: true,
  },

  // ── Kimi ──
  /*
   * 源（2026-10-24 核对）：
   * - 开放平台：platform.kimi.ai 的 K3 / K3.1 Pro quickstart（「Important limits」一节）——
   *   思考恒开，reasoning_effort 只认 low / high / max，默认 max；max_completion_tokens 默认
   *   131072、上限 1048576；1M 窗口。
   * - Kimi Code 会员：kimi.com/en/help/kimi-code/models 的型号表与「Effort mapping」——
   *   k3 / k3-256k 默认 **high**，kimi-for-coding（K2.8 Preview）默认 max、1M 窗口。
   * 同一个 K3，两处默认档不同：Kimi Code 用 k3 这个 id，开放平台用 kimi-k3，正好按 id 分开记。
   * K3 的窗口走目录（kimi-coding 收录了 k3 = 1M、k3-256k = 256K）。注意 Kimi Code 的 Plus
   * 会员 k3 实际只给 256K（1M 要 Pro 及以上），这是账号层面的限制，型号口径仍记 1M。
   */
  k3: { thinkingLevels: KIMI_THINKING_LEVELS, defaultThinkingLevel: "high" },
  "k3-256k": { thinkingLevels: KIMI_THINKING_LEVELS, defaultThinkingLevel: "high" },
  "kimi-k3": { thinkingLevels: KIMI_THINKING_LEVELS, defaultThinkingLevel: "max" },
  "k3.1-pro": KIMI_K31_PRO,
  "k3.1-pro-highspeed": KIMI_K31_PRO,
  "kimi-k3.1-pro": KIMI_K31_PRO,
  "kimi-k3.1-pro-highspeed": KIMI_K31_PRO,
  /*
   * K2.8 Preview（Kimi Code 里原地升级了 kimi-for-coding 这个 id）：1M、三档、默认 max。
   * pi 0.84.3 的内建目录还是 256K、没有档位表——目录联网刷新之前，白名单先纠过来。
   * 输出上限官方没写（pi.dev 目录记 32768），不确知就不写，交给目录。
   */
  "kimi-for-coding": {
    contextWindow: 1_048_576,
    thinkingLevels: KIMI_THINKING_LEVELS,
    defaultThinkingLevel: "max",
  },
};

// ── 显示名与头像（2026-10-24，原型 4「显示名与头像」）──────────────────────────────
// 与上面的参数表分开放：参数口径在目录跟上之后要删（见文件头），名字和头像是我们自己定的，
// 不随目录删；放在一张表里，「该删的」和「该留的」就分不开了。

/**
 * 型号显示名：模型菜单与设置页模型列表的主文字（id 降到次行）。生效顺序见 model-defaults 的
 * `modelDisplayName`：声明里的名字 > 这里 > 目录名 > id。
 * **只写目录给不了、或目录写错的**：K3.1 目录还没收录；kimi-for-coding 在 Kimi Code 里早已
 * 原地升级成 K2.8 Preview，目录还叫它「Kimi K2.7 Code」/ 直接写 id；deepseek-flash 与
 * step-5-preview 是厂商官方 id，目录只收了网关的写法。
 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "k3.1-pro": "Kimi K3.1 Pro",
  "k3.1-pro-highspeed": "Kimi K3.1 Pro Highspeed",
  "kimi-k3.1-pro": "Kimi K3.1 Pro",
  "kimi-k3.1-pro-highspeed": "Kimi K3.1 Pro Highspeed",
  "kimi-for-coding": "Kimi K2.8 Preview",
  "kimi-for-coding-highspeed": "Kimi K2.7 Code HighSpeed",
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "step-5-preview": "Step 5 Preview",
};

/** 这个型号 id 在白名单里的显示名；没写返回 undefined（调用方接着查目录） */
export function knownDisplayName(modelId: string): string | undefined {
  return Object.hasOwn(MODEL_DISPLAY_NAMES, modelId) ? MODEL_DISPLAY_NAMES[modelId] : undefined;
}

/**
 * 型号专属头像的素材键。素材本身在 renderer（design-system/assets/model-avatars/，
 * ModelAvatar.tsx 登记）——shared 不碰图片文件，这里只说「哪个型号用哪一枚」。
 * 来源与拍板记录在本地的头像登记页（docs/model-avatars/registry.json，不进仓）。
 */
export type ModelAvatarKey =
  | "kimi-k3.1"
  | "kimi-k3"
  | "glm-5.3"
  | "glm-5.3-flash"
  | "deepseek-v4-pro"
  | "deepseek-v4.1-flash"
  | "step-5-preview"
  | "claude-fable"
  | "claude-opus"
  | "claude-sonnet"
  | "claude-haiku"
  | "mimo-v2.6-pro"
  | "mimo-v2.6-flash"
  | "gpt-astra"
  | "gpt-sol"
  | "gpt-luna"
  | "qwen3.8-max"
  | "qwen3.8-flash"
  | "qwen3.8-27b"
  | "minimax-m3.1-flash";

/** 第一级 · 型号专属头像，按精确 id。按 id 生效、不看服务商：OpenCode Go 上的 kimi-k3.1-pro 一样是它 */
const MODEL_AVATAR_IDS: Readonly<Record<string, ModelAvatarKey>> = {
  "k3.1-pro": "kimi-k3.1",
  "k3.1-pro-highspeed": "kimi-k3.1",
  "kimi-k3.1-pro": "kimi-k3.1",
  "kimi-k3.1-pro-highspeed": "kimi-k3.1",
  // 以下取自各家公众号发布推文的封面（2026-10-24 用户：「从封面里面截图对应模型的背景」）
  k3: "kimi-k3",
  "k3-256k": "kimi-k3",
  "kimi-k3": "kimi-k3",
  "glm-5.3": "glm-5.3",
  "glm-5.3-flash": "glm-5.3-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "deepseek-flash": "deepseek-v4.1-flash",
  "step-5-preview": "step-5-preview",
  "step-5-preview-free": "step-5-preview",
  "mimo-v2.6-pro": "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed": "mimo-v2.6-pro",
  "mimo-v2.6-flash": "mimo-v2.6-flash",
  // 千问 AI 平台模型市场（qianwenai.com/models）顶部轮播里两个型号各自的封面
  "qwen3.8-max": "qwen3.8-max",
  "qwen3.8-flash": "qwen3.8-flash",
  // 公众号推文封面：千问「Qwen3.8-27B 开源」、MiniMax「M3.1 Flash 开源」（M3 用户不要专属头像，落家族标）
  "qwen3.8-27b": "qwen3.8-27b",
  "minimax-m3.1-flash": "minimax-m3.1-flash",
};

/**
 * 第一级（续）· 按产品线各一枚：新出的版本不用逐个登记。
 * - Claude 认前缀（claude-opus-*）。
 * - GPT 的产品线写在版本号后面（gpt-6-luna、gpt-5.6-luna、gpt-6.1-sol），按「gpt-版本-产品线」整段认；
 *   产品线后面只许跟连字符或结尾——gpt-6-solar 这类不会被认成 Sol。Terra 官方只有带字的小图标、
 *   没有无字原图（2026-10-24），不做专属头像，落到 OpenAI 家族标。
 */
const MODEL_AVATAR_LINES: readonly (readonly [pattern: RegExp, avatar: ModelAvatarKey])[] = [
  [/^claude-fable-/, "claude-fable"],
  [/^claude-opus-/, "claude-opus"],
  [/^claude-sonnet-/, "claude-sonnet"],
  [/^claude-haiku-/, "claude-haiku"],
  [/^gpt-\d+(?:\.\d+)?-astra(?:-|$)/, "gpt-astra"],
  [/^gpt-\d+(?:\.\d+)?-sol(?:-|$)/, "gpt-sol"],
  [/^gpt-\d+(?:\.\d+)?-luna(?:-|$)/, "gpt-luna"],
];

/** 家族图标的厂商标键（renderer 的 VendorLogo 按它取 svg，类型保证一个都不缺） */
export type ModelFamilyLogo =
  | "kimi"
  | "zai"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "stepfun"
  | "claude"
  | "openai"
  | "xiaomimimo"
  | "grok";

/**
 * 第二级 · 家族图标，按 id 前缀（小写比）。聚合网关与自建网关里最有用的一级：一家网关里的
 * 多家型号各用各的标。GLM 用 Z.ai 的标——那是现在 GLM 系列的标，lobe-icons 的 chatglm 是
 * ChatGLM 时代的旧标（2026-10-24 用户指出）。
 */
const MODEL_FAMILY_PREFIXES: readonly (readonly [pattern: RegExp, logo: ModelFamilyLogo])[] = [
  [/^(kimi-|k\d)/, "kimi"],
  [/^glm-/, "zai"],
  [/^deepseek-/, "deepseek"],
  [/^qwen/, "qwen"],
  [/^minimax-/, "minimax"],
  [/^step-/, "stepfun"],
  [/^claude-/, "claude"],
  [/^(gpt-|o\d)/, "openai"],
  [/^mimo-/, "xiaomimimo"],
  // Grok 用 xAI 的斜线标（与 xAI 服务商同一枚）
  [/^grok-/, "grok"],
];

export type ModelAvatarRef = { kind: "own"; key: ModelAvatarKey } | { kind: "family"; logo: ModelFamilyLogo };

/**
 * 头像三级规则的前两级，先到先得：专属头像 > 家族图标。认不出返回 undefined——第三级是
 * 服务商图标，要看服务商条目，由界面层给（每个服务商都有图标，所以第三级必有结果）。
 * 只看型号 id，不联网。
 */
export function modelAvatarOf(modelId: string): ModelAvatarRef | undefined {
  const exact = Object.hasOwn(MODEL_AVATAR_IDS, modelId) ? MODEL_AVATAR_IDS[modelId] : undefined;
  if (exact !== undefined) return { kind: "own", key: exact };
  const id = modelId.toLowerCase();
  const line = MODEL_AVATAR_LINES.find(([pattern]) => pattern.test(id));
  if (line !== undefined) return { kind: "own", key: line[1] };
  const family = MODEL_FAMILY_PREFIXES.find(([pattern]) => pattern.test(id));
  return family === undefined ? undefined : { kind: "family", logo: family[1] };
}

/**
 * 这个型号 id 的白名单口径。**只按模型 id 查**：这张表记的是「这个型号的官方口径」，
 * 与它从哪家网关接进来无关。认不得的 id 返回空对象——调用方据此原样走目录 / 兜底。
 * 「目录说了算」的例外不在这里判（要看本家目录），见 model-defaults 的 `knownParamsFor`。
 */
export function knownModelParams(modelId: string): ModelParams {
  return Object.hasOwn(KNOWN_MODELS, modelId) ? (KNOWN_MODELS[modelId] ?? {}) : {};
}
