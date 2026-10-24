/**
 * 我们**适配过的** provider 清单 —— 设置面下拉框的真源。
 *
 * 为什么不直接列 pi 的 41 个：pi 的目录是「模型参数」的真源，不是「怎么接入」的真源。
 * 同一个厂商的不同套餐往往是**不同的接入方式**——智谱标准 API 是 OpenAI 兼容，
 * 而 Coding Plan 走 `/api/anthropic` 是 Anthropic 兼容，pi 的目录里只有前者。
 * 把 41 个原样倒出来，用户选中「Z.AI Coding CN」却发现协议不对、模型对不上，
 * 比不给下拉框更坏。
 *
 * 所以这张表一条一条手写「接入方式」：协议、预填地址、计费口径。模型参数仍然来自 pi 的目录
 * （`catalogId` 对得上就用它的官方参数）与型号白名单（known-models.ts，按型号 id 记）。
 * 我们用真实账号跑通过的条目不带标记；照厂商文档与 Proma 开源版的默认端点补齐、还没有账号
 * 验证过的条目标 `untested`，界面上如实写「未实测」，欢迎有账号的人提 PR 摘掉它。
 *
 * 对照 proma：他们的 `channel.ts` 有 24 个 ProviderType，同样是一张手写表——
 * 这部分是干净的，值得学。不该学的是 `fetchModels` 那个 15 分支 switch。
 */
import type { CatalogPreference } from "./model-defaults.ts";
import type { ProviderApi } from "./provider.ts";

/**
 * 一种接入方式：协议 + 这家在这个协议下的地址。同一家常同时开着几种协议（智谱 Coding Plan
 * 的文档就并列了 Anthropic Messages / OpenAI Chat / OpenAI Responses 三个 Base URL），
 * 我们不替用户把它绑死在其中一个上（2026-10-24 用户：「根据官方的 doc 去，允许两种多种协议
 * 才对，而不是你非要把它绑在其中一个端点上」）。
 */
export interface KnownAccess {
  api: ProviderApi;
  baseUrl: string;
}

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
   * **官方支持的全部接入方式**（含默认那一种，即上面的 `api` + `baseUrl`）。只收厂商文档
   * 写明、且 pi 有对应 api 实现的；每条在注释里写出处 URL 与查证日期。缺省 = 只有默认一种。
   *
   * 默认取哪一种：有 catalogId 的跟 pi 内建目录里这家的协议走（2026-10-24 用户：「协议就跟
   * pi 对齐吧」）——pi 的型号参数与思考回传格式是按那条路调的。只影响**新建**实例：已存的
   * 实例协议与地址落在 providers.json 里，原样保留，不迁移。
   */
  access?: readonly KnownAccess[];
  /**
   * **同一组端点的其他写法**：每组是与 `access` 同一套协议的另一套地址（网关改过域名 / 路径、
   * 文档与目录各写一种）。用户存的地址落在哪一组，换协议时就给哪一组的地址；已存旧写法的实例
   * 照旧能用，不迁移。不在任何一组里的地址是用户自己改的（自建网关 / 镜像），协议与地址全听条目的。
   */
  accessAliases?: readonly (readonly KnownAccess[])[];
  /**
   * **型号各走各的协议**（多协议网关）：一个 key、一个网关，每个型号只开一种协议（OpenCode Go 的
   * minimax-m3 只走 Anthropic Messages、kimi-k3 只走 OpenAI Chat）。本家目录收录的型号用目录给它的
   * 协议，地址从 `access`（或用户所在那组别名）里取该协议的；目录没收录的型号走条目自己的协议。
   *
   * 缺省 = 条目的协议对这家所有型号都成立（智谱 / DeepSeek 选了 Anthropic，所有型号就走 Anthropic）。
   * 只看这个声明，不看目录里型号的地址长什么样：目录地址会随上游改名漂移（2026-10 pi.dev 在线目录
   * 把 opencode-go 从 zen/go 整体换到 inference/go，旧判定「目录里有一条地址与条目逐字相等」就失效了）。
   */
  protocolPerModel?: true;
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
   * 这一条不用 API key，而是浏览器登录订阅：Claude（我们手写的流程，main/provider/oauth.ts）
   * 与 ChatGPT（Codex）/ GitHub Copilot / xAI（复用 pi 自带的流程，main/provider/oauth-flows.ts）。
   * 凭据落我们自己的密钥库，自动续期。设置面对这种条目不画密钥框，只给登录按钮；
   * upsert 时 scheme 落 oauth。
   */
  auth?: "oauth";
  /**
   * **还没用真实账号验证过**：地址、协议与登录流程只照厂商文档与 Proma 开源版的默认值填，
   * 我们手里没有账号跑通过一轮。设置页据此给卡片挂「未实测」徽标、详情页顶部写一句说明。
   * 实测通过后删掉这一行即可——徽标与说明跟着消失。
   */
  untested?: true;
}

export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    // 出处：https://api-docs.deepseek.com/（Your First API Call 表格：base_url (OpenAI) 与
    // base_url (Anthropic)），2026-10-24 查证
    access: [
      { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
    ],
    catalogId: "deepseek",
    note: "DeepSeek 官方 API",
  },
  {
    id: "zhipu",
    label: "智谱",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    // 出处（2026-10-24 查证）：OpenAI 兼容 https://docs.bigmodel.cn/cn/guide/develop/openai/introduction.md、
    // Claude API 兼容 https://docs.bigmodel.cn/cn/guide/develop/claude/introduction.md、
    // Response API 兼容 https://docs.bigmodel.cn/cn/guide/develop/responses/introduction.md
    // （「Response API 的基址是 /api/v1，不是对话补全使用的 /api/paas/v4」）
    access: [
      { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      { api: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
      { api: "openai-responses", baseUrl: "https://open.bigmodel.cn/api/v1" },
    ],
    catalogId: "zai-coding-cn",
    note: "智谱开放平台标准 API（按 token 计费）",
  },
  /*
   * ── 以下 API 条目对齐 Proma 开源版的厂商清单（只取事实：厂商与端点），全部 `untested`。
   *
   * **协议跟 pi 的目录走，不跟 Proma 走。** Proma 的 Agent 内核是 Claude Agent SDK，只会说
   * Anthropic 协议，所以它把能接的厂商都接在 `/anthropic` 端点上；我们跑的是 pi，pi 的目录
   * 给这几家维护的是 OpenAI 兼容端点（型号参数、思考回传格式都按那条路调过）。而且协议
   * 对不上会真出事：目录模型在会话里带着自己的 api / baseUrl 注册（agent/model-registration
   * 的保留合并），我们的 id 又常与 pi 内建 id 同名（xiaomi、qwen-token-plan）——挂了一个
   * 协议不同的 catalogId，请求就被悄悄改道到目录的协议上。一致性测试
   * （agent/whitelist-consistency.test.ts）对每条都核对「会话里的协议与地址就是条目自己的」。
   *
   * pi 目录里没有的厂商（通义千问 DashScope、火山方舟）照 Proma 的默认端点与协议填，不挂
   * catalogId，型号参数照样能按型号 id 跨目录借。
   */
  {
    id: "anthropic",
    label: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    catalogId: "anthropic",
    untested: true,
    note: "Anthropic 官方 API，按 key 计费（订阅登录见下方 Claude）",
  },
  {
    id: "openai",
    label: "OpenAI",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    catalogId: "openai",
    untested: true,
    note: "OpenAI 官方 API，走 Responses 协议",
  },
  {
    id: "google",
    label: "Google",
    api: "google-generative-ai",
    // pi 的 Gemini 客户端直接在 baseUrl 后接 /models/<id>:streamGenerateContent，版本段要带上
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    catalogId: "google",
    untested: true,
    note: "Gemini API（AI Studio 的 key）",
  },
  {
    id: "kimi-api",
    label: "Kimi",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    // 出处：https://platform.kimi.com/docs/api/overview「协议兼容性」表（Chat Completions 与
    // Responses 同在 /v1，Messages 在 /anthropic），2026-10-24 查证
    access: [
      { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
      { api: "openai-responses", baseUrl: "https://api.moonshot.cn/v1" },
      { api: "anthropic-messages", baseUrl: "https://api.moonshot.cn/anthropic" },
    ],
    catalogId: "moonshotai-cn",
    untested: true,
    note: "Kimi 开放平台按量 API",
  },
  {
    id: "minimax",
    label: "MiniMax",
    api: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    /*
     * 出处（2026-10-24 查证）：Anthropic SDK https://platform.minimaxi.com/docs/api-reference/text-anthropic-api.md、
     * OpenAI SDK https://platform.minimaxi.com/docs/api-reference/text-openai-api.md、
     * Responses https://platform.minimaxi.com/docs/api-reference/responses-create.md（POST /v1/responses）。
     * 文档现在写的主机是 api.minimax.cn（文档站也从 platform.minimaxi.com 跳到 platform.minimax.cn）；
     * 这里沿用 pi 目录（minimax-cn）的 api.minimaxi.com——两个主机同一套路径，当天都应答（无 key 回 401）。
     */
    access: [
      { api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic" },
      { api: "openai-completions", baseUrl: "https://api.minimaxi.com/v1" },
      { api: "openai-responses", baseUrl: "https://api.minimaxi.com/v1" },
    ],
    catalogId: "minimax-cn",
    untested: true,
    // 按量与编程包共用这个端点（计费跟着 key 走），放 API 区、按量口径：不确定时宁可多显示一行估价
    note: "API 与编程包共用一个端点，计费跟着 key 走",
  },
  {
    id: "xiaomi",
    label: "小米 MiMo",
    api: "openai-completions",
    baseUrl: "https://api.xiaomimimo.com/v1",
    catalogId: "xiaomi",
    untested: true,
    note: "小米 MiMo 开放平台 API，走 OpenAI 兼容端点",
  },
  {
    id: "qwen",
    label: "通义千问",
    api: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    untested: true,
    note: "阿里云百炼 DashScope，OpenAI 兼容模式",
  },
  {
    id: "doubao-api",
    label: "火山方舟",
    api: "openai-completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    untested: true,
    note: "火山引擎方舟模型 API（按 token 计费）",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    catalogId: "openrouter",
    untested: true,
    note: "聚合网关，一个 key 调用多家模型",
  },
  {
    id: "zhipu-coding",
    label: "智谱",
    // 默认跟 pi 的 zai-coding-cn 走 OpenAI Chat（/api/coding/paas/v4）。2026-10-24 之前默认是
    // Anthropic（/api/anthropic）——那时建的实例照旧走 Anthropic，不迁移
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    // 出处：https://docs.bigmodel.cn/cn/coding-plan/quick-start.md 第 5 节「接入端点说明」，
    // 2026-10-24 查证
    access: [
      { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
      { api: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
      { api: "openai-responses", baseUrl: "https://open.bigmodel.cn/api/v1" },
    ],
    catalogId: "zai-coding-cn",
    billing: "plan",
    note: "GLM Coding Plan 订阅",
  },
  {
    id: "zai",
    label: "Z.AI",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    // 出处：https://docs.z.ai/devpack/quick-start.md 第 5 节「Endpoint Guide」，2026-10-24 查证
    access: [
      { api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
      { api: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
      { api: "openai-responses", baseUrl: "https://api.z.ai/api/v1" },
    ],
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
     * Kimi 会员（Kimi Code）的编程端点。默认走 Anthropic 兼容协议——与 pi 内建的 kimi-coding
     * 条目同一个 baseUrl 与协议（客户端接 /v1/messages），模型参数（k3 / k3-256k /
     * kimi-for-coding）直接继承它的目录。OpenAI 兼容的 /coding/v1 也能选：pi-ai 补丁
     * （patches/ 下）把 api.kimi.com 认成 Moonshot，不发它不认的 developer 角色。
     */
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding",
    // 出处：https://www.kimi.com/en/help/kimi-code/models（「Kimi Code API supports both OpenAI
    // and Anthropic protocols」两个 Base URL），2026-10-24 查证
    access: [
      { api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding" },
      { api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1" },
    ],
    catalogId: "kimi-coding",
    billing: "plan",
    note: "Kimi Code 会员订阅",
  },
  {
    id: "opencode-go",
    label: "OpenCode",
    api: "openai-completions",
    /*
     * 出处（2026-10-25 查证）：https://opencode.ai/v2/docs/console/go/#endpoints（按协议列端点，
     * 模型列表在 inference/go/v1/models）；models.dev（https://models.dev/api.json 的 opencode-go）；
     * pi.dev 在线目录（31 条型号全在 inference/go[/v1]）。
     *
     * 默认取 inference/go/v1 这一组（与 pi 在线目录同一写法）：文档表里的 /openai/v1 发对话能通，但
     * 「获取列表」拼出来的 /openai/v1/models 是 404，只有 /v1/models 应答（无 key 实测）。
     * Anthropic 客户端自己接 /v1/messages，所以它那条不带 /v1。
     */
    baseUrl: "https://opencode.ai/inference/go/v1",
    access: [
      { api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/v1" },
      { api: "anthropic-messages", baseUrl: "https://opencode.ai/inference/go" },
      { api: "openai-responses", baseUrl: "https://opencode.ai/inference/go/v1" },
      { api: "google-generative-ai", baseUrl: "https://opencode.ai/inference/go/v1" },
    ],
    accessAliases: [
      // 2026-10 之前的地址（pi 内建快照至今仍是这一组）：已存它的实例继续走它。这一组没有 Google
      // 路由（zen/go 下各种写法都 404）
      [
        { api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" },
        { api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        { api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" },
      ],
      // 文档端点表的写法（按协议分子路径）：用户照文档填进来也认得
      [
        { api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/openai/v1" },
        { api: "anthropic-messages", baseUrl: "https://opencode.ai/inference/go/anthropic" },
        { api: "openai-responses", baseUrl: "https://opencode.ai/inference/go/openai/v1" },
        { api: "google-generative-ai", baseUrl: "https://opencode.ai/inference/go/google/v1beta" },
      ],
    ],
    protocolPerModel: true,
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
    id: "zhipu-coding-team",
    label: "智谱团队版",
    api: "anthropic-messages",
    // 与个人版 Anthropic 那一种同一个端点。不挂 catalogId：团队版能用哪些型号、参数是否与个人版
    // 一致都没有账号核实过，不借 zai-coding-cn 的目录（挂了也不会改道——协议与地址听条目的，
    // 一致性测试逐条核对）
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    billing: "plan",
    untested: true,
    note: "GLM Coding Plan 团队版，团队凭据登录",
  },
  {
    id: "qwen-token-plan",
    label: "通义千问",
    api: "openai-completions",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    catalogId: "qwen-token-plan-cn",
    billing: "plan",
    untested: true,
    note: "通义千问 Token Plan 订阅，走 OpenAI 兼容端点",
  },
  {
    id: "xiaomi-token-plan",
    label: "小米 MiMo",
    api: "openai-completions",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    catalogId: "xiaomi-token-plan-cn",
    billing: "plan",
    untested: true,
    note: "小米 MiMo Token Plan 订阅",
  },
  {
    id: "doubao",
    label: "火山方舟",
    api: "openai-completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    billing: "plan",
    untested: true,
    note: "火山方舟 Coding Plan 订阅；只能用套餐授权的型号",
  },
  {
    id: "ark-coding-plan",
    label: "火山方舟 Agent",
    api: "anthropic-messages",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    billing: "plan",
    untested: true,
    note: "火山方舟 Agent Plan 订阅",
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
    note: "Claude Pro / Max 订阅，令牌自动续期",
  },
  /*
   * 以下三家的登录流程、续期与请求鉴权都复用 pi 自带的实现（pi-ai 的 OAuth 流程），凭据落
   * 我们自己的密钥库。我们没有这三家的账号，全部 `untested`。
   *
   * id 与 pi 内建 id 一致**不是巧合，是必须**：pi 的客户端按 `model.provider` 认 Copilot
   * （动态请求头、Claude 型号走 Bearer），会话又用我们的 id 注册——第一个实例的 id 就是条目 id。
   */
  {
    id: "openai-codex",
    label: "ChatGPT",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    catalogId: "openai-codex",
    billing: "plan",
    auth: "oauth",
    untested: true,
    note: "ChatGPT Plus / Pro 订阅，用 Codex 额度",
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    protocolPerModel: true,
    // 多协议网关：目录里的 Claude 型号走 Messages、GPT 新型号走 Responses，注册时按型号各走各的；
    // 目录外手加的型号落这里写的协议（/chat/completions 在 Copilot 上对所有型号都开着）
    api: "openai-completions",
    // 个人版的地址；企业 / 商业账号的真实地址写在令牌里（proxy-ep），会话装配时按令牌改写
    baseUrl: "https://api.individual.githubcopilot.com",
    catalogId: "github-copilot",
    billing: "plan",
    auth: "oauth",
    untested: true,
    note: "Copilot 订阅，用 Copilot 额度调用多家模型",
  },
  {
    id: "xai",
    label: "xAI",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    catalogId: "xai",
    billing: "plan",
    auth: "oauth",
    untested: true,
    note: "SuperGrok / X Premium 订阅",
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
  {
    id: "openai-responses-compatible",
    label: "OpenAI Responses 兼容",
    api: "openai-responses",
    baseUrl: "",
    untested: true,
    note: "走 Responses 协议的自建网关，客户端接 /responses",
  },
];

/**
 * 「添加服务商」目录的四个分区：按量计费的官方 API / 套餐订阅 / 浏览器登录的订阅 /
 * 自建的兼容网关。**从条目已有的字段推出来，不另立字段**：浏览器登录（auth 为 oauth）=
 * 登录订阅；没有预填地址（baseUrl 为空）= 兼容入口；套餐计费 = 套餐订阅；其余 = API。
 * 新加条目只要 auth / billing / baseUrl 写对，分区自动跟着对。
 *
 * 登录订阅单列一区（2026-10-24 用户裁决）：只有 Claude 一家时它挤在套餐区里，登录类一多，
 * 「填 key」与「点登录」混在一区，用户得点进去才知道要哪一种。
 */
export type KnownProviderGroup = "api" | "plan" | "oauth" | "custom";

/** 卡片墙上分区的先后 */
export const KNOWN_PROVIDER_GROUPS: readonly KnownProviderGroup[] = ["api", "plan", "oauth", "custom"];

export function knownProviderGroup(provider: KnownProvider): KnownProviderGroup {
  if (provider.auth === "oauth") return "oauth";
  if (provider.baseUrl === "") return "custom";
  return provider.billing === "plan" ? "plan" : "api";
}

/** 默认名里补的区别词：同名条目分在哪个区，就补哪个区的计费口径 */
const GROUP_SUFFIX: Record<KnownProviderGroup, string> = {
  api: "按量",
  plan: "套餐",
  oauth: "订阅",
  custom: "兼容",
};

/**
 * 新建实例时预填的名字。label 在目录里有分区标题兜着；出了目录（服务商列表、模型菜单）
 * 就没有分区可看，所以 label 撞名的条目（智谱的按量与套餐）在名字里补上计费方式。
 */
export function knownProviderDefaultName(provider: KnownProvider): string {
  const collides = KNOWN_PROVIDERS.some((item) => item.id !== provider.id && item.label === provider.label);
  if (!collides) return provider.label;
  return `${provider.label}（${GROUP_SUFFIX[knownProviderGroup(provider)]}）`;
}

/** 这家的全部接入方式；没声明 `access` 的就是默认那一种。默认的那一种永远排第一 */
export function knownAccessMethods(provider: KnownProvider): readonly KnownAccess[] {
  const methods = provider.access ?? [{ api: provider.api, baseUrl: provider.baseUrl }];
  const first = methods.find((method) => method.api === provider.api && method.baseUrl === provider.baseUrl);
  return first === undefined ? methods : [first, ...methods.filter((method) => method !== first)];
}

/** 地址比较用：去掉尾部斜杠（用户填的与文档写的常差这一个字符） */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * 这个实例的协议 + 地址属于这家哪一组官方端点：默认那组（`access`）或某组别名（`accessAliases`）。
 * 认不出（用户改成了自建网关 / 镜像）为 undefined——那时协议与地址全听实例自己的。
 */
export function accessFamilyOf(
  provider: KnownProvider,
  endpoint: { api: string; baseUrl: string },
): readonly KnownAccess[] | undefined {
  const families = [knownAccessMethods(provider), ...(provider.accessAliases ?? [])];
  return families.find((family) =>
    family.some((method) => method.api === endpoint.api && sameUrl(method.baseUrl, endpoint.baseUrl)),
  );
}

/**
 * 协议选择器里给哪几种：当前地址所在那一组里有的（存的是旧写法 zen/go，就只给 zen/go 那组有的）；
 * 当前地址认不出或没给时给默认那组。
 *
 * 不跨组：zen/go 那组没有 Google 路由，就不给 Google 这一项——而不是点了之后静默把用户存的地址
 * 换成另一组的（改用户自己写的地址要他自己同意，2026-10-25）。想用 Google 的用户把地址改成
 * inference/go 那组，选择器就跟着列出它。
 */
export function accessChoicesFor(
  provider: KnownProvider,
  current?: { api: string; baseUrl: string },
): readonly KnownAccess[] {
  return (current === undefined ? undefined : accessFamilyOf(provider, current)) ?? knownAccessMethods(provider);
}

/**
 * 选中某个协议时用的地址：取自当前地址所在那一组（见 accessChoicesFor）。
 * 那一组没有这个协议就 undefined（调用方保留原地址）。
 */
export function knownAccessFor(
  provider: KnownProvider,
  api: ProviderApi,
  current?: { api: string; baseUrl: string },
): KnownAccess | undefined {
  return accessChoicesFor(provider, current).find((method) => method.api === api);
}

/**
 * 会话载荷里随条目带给 agent 进程的接入信息（`ProviderSecrets` 的同名字段）。主进程装配载荷与
 * 一致性测试从这里取，不各拼一份。
 *
 * 多协议网关（`protocolPerModel`）且实例地址属于某组官方端点时，带上 `protocolPerModel` 与**那一组**的
 * `access`。地址认不出（镜像 / 自建）时两个都不带：不知道别的协议在哪，按单协议处理——协议与地址
 * 全听条目的。单协议的家（智谱选了 Anthropic）也不带：agent 进程只在型号各走各的协议时才换地址。
 */
export function endpointHintsOf(
  known: KnownProvider,
  endpoint: { api: string; baseUrl: string },
): {
  catalogId?: string;
  catalogAuthoritative?: true;
  access?: KnownAccess[];
  protocolPerModel?: true;
} {
  const family = known.protocolPerModel === true ? accessFamilyOf(known, endpoint) : undefined;
  return {
    ...(known.catalogId === undefined ? {} : { catalogId: known.catalogId }),
    ...(known.catalogAuthoritative === true ? { catalogAuthoritative: true } : {}),
    ...(family === undefined ? {} : { protocolPerModel: true, access: family.map((method) => ({ ...method })) }),
  };
}

/** knownProviderOf 要的最小形状：Provider / ProviderDto 天然满足 */
export interface ProviderKindSource {
  id: string;
  kind?: string;
  endpoint: { api: ProviderApi };
}

/** 认不出条目时按协议落到哪个兼容入口 */
function compatibleKindFor(api: ProviderApi): string {
  if (api === "anthropic-messages") return "anthropic-compatible";
  if (api === "openai-responses") return "openai-responses-compatible";
  return "openai-compatible";
}

function knownById(id: string): KnownProvider | undefined {
  return KNOWN_PROVIDERS.find((item) => item.id === id);
}

/**
 * 一个已配置的 provider 来自哪个目录条目。三档，先到先得：
 *   1. 显式的 `kind`（新建 / 复制时写入）；
 *   2. id 本身就是条目 id（第一个实例），或去掉 `-2` / `-copy` / `-copy3` 后缀后是——
 *      老数据没有 kind，第二个实例与副本只能靠 id 的生成规则（nextFreeId / nextCopyId）认回来；
 *   3. 都不是：按协议落到「兼容」条目之一（Anthropic / OpenAI Responses / 其余一律 OpenAI 兼容）。
 * 永远有答案：调用方不必再处理「认不出来」。
 */
export function knownProviderOf(provider: ProviderKindSource): KnownProvider {
  const explicit = provider.kind === undefined ? undefined : knownById(provider.kind);
  if (explicit !== undefined) return explicit;
  const byId = knownById(provider.id) ?? knownById(provider.id.replace(/-(?:\d+|copy\d*)$/, ""));
  if (byId !== undefined) return byId;
  const compatible = knownById(compatibleKindFor(provider.endpoint.api));
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
