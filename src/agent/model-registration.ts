/**
 * provider 注册的纯装配层 —— 从 runtime 抽出来只为可测（runtime 本体被 parentPort
 * 守卫钉死在 utility 进程里，node --test 加载即退出）。
 *
 * 背景语义（pi provider-composer 的 applyExtension）：注册时的 models 数组是
 * **整体替换**——带上它就会把内建目录里的官方参数（上下文窗口 / 单价）盖掉。
 * 所以注册分两步：先只给 auth（目录元数据存活），目录里解析不到选中 id、**或任一
 * 声明模型带了用户覆盖字段**时才补注册 models。补注册做**保留合并 + 用户字段覆盖**：
 * 已认识的目录条目原样带回，用户声明的字段逐个盖上（用户 > 目录 > 兜底）。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { BuiltinModel, BuiltinProvider } from "../shared/agent-ipc.ts";
import { knownModelParams } from "../shared/known-providers.ts";
import { lookupCatalogModel, resolveModelDefaults, type CatalogPreference } from "../shared/model-defaults.ts";
import type { ModelDecl } from "../shared/provider.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/thinking.ts";

/** pi 注册表里的模型对象——从 ModelRuntime 的方法签名推出来，不另维护一份类型 */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * compat 里属于「模型怎么思考」而不是「网关怎么认字」的两项。
 * 其余 compat 是端点怪癖（supportsStore / supportsDeveloperRole …），不跨条目借。
 */
type ThinkingReplayCompat = {
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: string;
};

/**
 * 型号家族键：取 id 最后一段的字母前缀。`deepseek-v4.1-flash` 与
 * `deepseek-ai/DeepSeek-V4-Flash` 都归到 `deepseek`。
 *
 * 聚合网关给同一型号换写法（deepseek-v4.1-flash 之于 opencode-go 目录里的
 * deepseek-v4-flash）时，精确 id 查不到目录条目——这就是家族键存在的理由。
 */
function modelFamily(id: string): string {
  const last = id.split(/[\\/]/).filter(Boolean).pop() ?? id;
  return /^[a-z]+/.exec(last.toLowerCase())?.[0] ?? last.toLowerCase();
}

/**
 * 从**同一家目录**里同家族的条目借思考回传协议。
 *
 * 背景（2026-10-21 实测）：openai-completions 上声明 `deepseek-v4.1-flash`，
 * 目录只收录了 `deepseek-v4-flash` / `deepseek-v4-pro`，精确命中落空 → compat 整份缺省
 * → pi 按标准 OpenAI 发：不回传 `reasoning_content`、思考参数用 `reasoning_effort`。
 * 只要历史里有一条 assistant 没带 reasoning_content（上游偶尔不回思考），DeepSeek 的
 * thinking 上游就 400「The reasoning_content in the thinking mode must be passed back」。
 *
 * 两项协议跟**网关**走（opencode-go 是 deepseek 形状、openrouter 是 openrouter 形状），
 * 所以只从同一家的条目借，不按 id 跨家猜。
 */
function borrowedThinkingReplay(
  models: readonly PiModel[],
  modelId: string,
  api: string | undefined,
): ThinkingReplayCompat | undefined {
  if (api !== "openai-completions") return undefined;
  const family = modelFamily(modelId);
  for (const model of models) {
    if (model.api !== "openai-completions" || model.compat === undefined) continue;
    if (modelFamily(model.id) !== family) continue;
    const compat = model.compat as ThinkingReplayCompat;
    if (
      compat.requiresReasoningContentOnAssistantMessages === undefined &&
      compat.thinkingFormat === undefined
    ) {
      continue;
    }
    return {
      ...(compat.requiresReasoningContentOnAssistantMessages === undefined
        ? {}
        : { requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages }),
      ...(compat.thinkingFormat === undefined ? {} : { thinkingFormat: compat.thinkingFormat }),
    };
  }
  return undefined;
}
/** pi 注册表里的 provider 对象（同上，签名推导） */
export type PiProvider = ReturnType<ModelRuntime["getProviders"]>[number];
/** registerProvider 第二参的完整形状（同上，签名推导） */
export type PiProviderRegistration = Parameters<ModelRuntime["registerProvider"]>[1];

/** 注册的 auth 面：**不带 models**——带了会把目录的官方窗口 / 单价盖成兜底值 */
export function toAuthConfig(provider: {
  apiKey: string;
  baseUrl: string;
  api: string;
  headers?: Record<string, string>;
}) {
  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    api: provider.api,
    ...(provider.headers ? { headers: provider.headers } : {}),
  };
}

/**
 * 补注册的 models：**保留合并 + 用户字段覆盖**——注册表里已认识的 id（目录条目，带官方
 * 窗口 / 单价）原样带回，目录没有的 id 落兜底默认；之后用户声明的字段逐个盖上
 * （pi modelOverrides 同款 `??` 语义：目录会过时或零价——实测 glm-5.3 目录定价全零——
 * 用户填了的才算数）。不做保留的话，补一个新 id 会把同 provider 其它目录模型的
 * 官方参数一并砸掉（models 是整体替换，已验证）。
 */
export function toFallbackModels(
  current: readonly PiModel[],
  declared: readonly ModelDecl[],
  /**
   * 全目录（`runtime.getProviders()` 的全部条目）。本家 `current` 里没有的 id 到这里
   * 按**模型 id** 借官方参数——自建网关声明的 claude-opus-5 / k3 挂在别家名下，
   * 不跨家借就只能落 128k 兜底（wafo 2026-09-21 实测）。
   */
  catalog: readonly BuiltinProvider[] = [],
  prefer: CatalogPreference = {},
  /**
   * 目录的**原始**模型（未瘦身，带 thinkingLevelMap / compat）。借参时从**借参数的
   * 那一条**（精确 id，否则 Claude 家族：claude-fable-5-1 借 claude-fable-5）抄档位表——
   * 档位是模型能力（跟 id 走：glm 的 high / claude 的 xhigh），不是协议开关；
   * 不抄的话 pi 对借参模型按「无表」规则算出伪支持集（minimal→high 五档），
   * 档位菜单跟着撒谎。
   *
   * compat 只抄 `forceAdaptiveThinking` 一项，其余仍然不抄：那是接入端点的协议怪癖，
   * 跟网关走（sendSessionAffinityHeaders 只有 cloudflare 有、supportsStrictTools /
   * allowedFallbackModels 只有 anthropic 官方有）。这一项不同，它是**模型**接受的思考
   * 格式：新 Claude 只收 `thinking: adaptive` + `output_config.effort`，不认
   * budget_tokens；pi 目录里 claude-opus-5 在 anthropic / opencode / cloudflare /
   * copilot / vercel 五家 anthropic-messages 条目上一律带它。且档位表的 xhigh / max
   * 本身就是 effort 值，只在 adaptive 下被读——只抄表不抄它，用户选的档会被 pi 换算成
   * budget_tokens 发出去，effort 一个都送不到（2026-09-23 实测）。
   *
   * 目录没收录、家族也借不到的型号（claude-opus-5-5）没有条目可借：由白名单
   * `adaptiveThinking` 声明，档位表按白名单 thinkingLevels 生成（见 effortLevelMap）。
   */
  catalogModels: readonly PiModel[] = [],
): NonNullable<PiProviderRegistration["models"]> {
  return declared.map((decl) => {
    const known = current.find((model) => model.id === decl.id);
    const borrowed = resolveModelDefaults(catalog, decl.id, prefer);
    // 借参来源的原始目录条目（理由见参数注释）。目录缺席时退回精确 id
    const sourceId = lookupCatalogModel(catalog, decl.id, prefer)?.id ?? decl.id;
    const sources = catalogModels.filter((model) => model.id === sourceId);
    const borrowedMap = sources[0]?.thinkingLevelMap;
    // 目录没收录、也借不到家族参数的新 Claude（claude-opus-5-5）：白名单声明它只收
    // adaptive。同样只对 anthropic-messages 协议的接入生效
    const patch = knownModelParams(decl.id);
    const declaredAdaptive = prefer.api === "anthropic-messages" && patch.adaptiveThinking === true;
    // 只认同协议的条目：copilot 的 openai-completions 版 claude-fable-5 就不带这一项
    const adaptive =
      declaredAdaptive ||
      sources.some(
        (model) =>
          model.api === prefer.api &&
          model.compat !== undefined &&
          "forceAdaptiveThinking" in model.compat &&
          model.compat.forceAdaptiveThinking === true,
      );
    // 档位表：目录的优先；目录没有而白名单声明了 adaptive，就按白名单档位生成——
    // 否则 pi 按「无表」规则不认 xhigh / max，用户选的这两档会被夹成 high
    const levelMap =
      borrowedMap ??
      (declaredAdaptive && patch.thinkingLevels !== undefined ? effortLevelMap(patch.thinkingLevels) : undefined);
    // 目录没收录精确 id 时（聚合网关换写法），思考回传协议从同家同家族的条目借；
    // 借不到就不带——不按 id 猜协议，猜错比不带更糟（发错字段当场 400）
    const replay = known === undefined ? borrowedThinkingReplay(current, decl.id, prefer.api) : undefined;
    const compat =
      adaptive || replay !== undefined
        ? {
            ...(adaptive ? { forceAdaptiveThinking: true } : {}),
            ...(replay ?? {}),
          }
        : undefined;
    const base =
      known === undefined
        ? {
            id: decl.id,
            name: decl.id,
            // 跨目录借参的第五件：reasoning。借不到才落 false——「不确定就不发」
            // （发不支持的档位当场 400）；借得到（如 glm-5.3-flash 在白名单）就是真值
            reasoning: borrowed.reasoning,
            input: borrowed.input,
            cost: borrowed.cost,
            contextWindow: borrowed.contextWindow,
            maxTokens: borrowed.maxTokens,
            ...(levelMap === undefined ? {} : { thinkingLevelMap: { ...levelMap } }),
            ...(compat === undefined ? {} : { compat }),
          }
        : { ...known };
    return {
      ...base,
      name: decl.name ?? base.name,
      contextWindow: decl.contextWindow ?? base.contextWindow,
      maxTokens: decl.maxTokens ?? base.maxTokens,
      // cost 是整份替换（校验保证四档齐全）：用户明确报价，连目录的 tiers 一起作废
      ...(decl.cost === undefined ? {} : { cost: { ...decl.cost } }),
      // vision 是覆盖声明：填了才动 input 模态（目录怎么说就怎么的留空不动）
      ...(decl.vision === undefined ? {} : { input: decl.vision ? ["text", "image"] : ["text"] }),
    };
  });
}

/**
 * 白名单档位 → pi 的 thinkingLevelMap（目录外的 adaptive 型号用）：不在档位表里的档
 * 标 null（pi 视为不支持，发送前夹走——例如 opus-5-5 关不掉思考，off 就是 null）；
 * xhigh / max 映射成同名 effort（pi 只在表里有字符串时才把这两档当 effort 原样送出，
 * 否则按「无表」规则直接不认）；其余档留空 = pi 的默认映射（low / medium / high 同名）。
 */
function effortLevelMap(levels: readonly ThinkingLevel[]): NonNullable<PiModel["thinkingLevelMap"]> {
  const map: NonNullable<PiModel["thinkingLevelMap"]> = {};
  for (const level of THINKING_LEVELS) {
    if (!levels.includes(level)) map[level] = null;
    else if (level === "xhigh" || level === "max") map[level] = level;
  }
  return map;
}

/**
 * 任一声明模型带了用户覆盖字段吗。**带覆盖时即使目录认识选中 id 也必须补注册**——
 * 不重注册的话 getModel 返回的是目录原值，用户填的窗口 / 费率 / 图片能力永远不生效。
 */
export function hasModelOverrides(models: readonly ModelDecl[]): boolean {
  return models.some(
    (model) =>
      model.contextWindow !== undefined ||
      model.maxTokens !== undefined ||
      model.cost !== undefined ||
      model.vision !== undefined,
  );
}

/**
 * pi 的 provider 对象 → 我们的 BuiltinProvider。**两个消费者共用**：设置面的内建目录
 * （runtime 的 listBuiltins）与注册时的跨目录推断——两边必须看到同一份目录快照，
 * 否则设置页显示 1M、真正建会话时按 128k 压缩。
 *
 * api / baseUrl 长在 Model 上而非 Provider 上，取第一条模型的值当这家的代表。
 */
export function toBuiltinProvider(provider: PiProvider): BuiltinProvider {
  const models = provider.getModels();
  const first = models[0];
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl ?? first?.baseUrl ?? "",
    api: String(first?.api ?? "openai-completions"),
    models: models.map(toBuiltinModel),
  };
}

/** 目录模型 → 设置面展示的瘦身形状：只留 id 与三组参数，剥掉 pi 的 tiers 等无消费者字段 */
export function toBuiltinModel(model: PiModel): BuiltinModel {
  return {
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // 图片能力跟着参数一起过 IPC：设置页要拿它下图片徽标与「Inherit」的实际含义
    input: [...model.input],
    // 思考能力同批过 IPC：跨目录借参（resolveModelDefaults）要读它，
    // renderer 的思考档芯片也要靠它判断「这个模型只有 off」
    reasoning: model.reasoning,
    // 支持档在 pi 旁边算好再过线：不透出去 thinkingLevelMap 本身（它一进
    // shared，就会有人在拿不到 pi 的进程里拿它再算一遍支持集——第二份真源）。
    // 借参路径（无 map）也能算：pi 的规则是 reasoning:true 且非显式 null 即支持
    supportedThinkingLevels: getSupportedThinkingLevels(model),
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
  };
}

/** 与 runtime 的 create 命令里 provider 载荷同形（结构匹配，不引 AgentCommand 耦合） */
interface ProviderWire {
  apiKey: string;
  baseUrl: string;
  api: string;
  headers?: Record<string, string>;
  models: ModelDecl[];
  /**
   * pi 目录里这家叫什么（`KNOWN_PROVIDERS.catalogId`）。**官方参数按它去查。**
   * 缺席 = 目录里没这家（自建网关）。
   */
  catalogId?: string;
}

/**
 * 补注册的完整载荷：**必须带上整个 auth 面**，不只是 models。pi 的 registerProvider
 * 校验跑在合并之前——只传 `{models}` 的话，`api` 只能从目录 defaults 借，自建网关
 * 没有目录条目可借，当场抛「no "api" specified」（真实事故：openai-compatible 网关
 * 上创建会话失败）。
 */
export function toFallbackRegistration(
  provider: ProviderWire,
  current: readonly PiModel[],
  catalog: readonly BuiltinProvider[] = [],
  catalogModels: readonly PiModel[] = [],
): PiProviderRegistration {
  return {
    ...toAuthConfig(provider),
    models: toFallbackModels(current, provider.models, catalog, {
      catalogId: provider.catalogId,
      api: provider.api,
    }, catalogModels),
  };
}

/**
 * 注册（先 auth 面，目录 miss / 用户覆盖时补注册兜底）并解析选中模型。
 * create 与会话内换模型（C-4）共用同一条装配路径——解析规则必须一致，
 * 否则「建会话能用的模型」和「切过去能用的模型」是两套真相。
 */
export function registerAndResolveModel(
  runtime: Pick<ModelRuntime, "registerProvider" | "getModel" | "getProviders">,
  provider: ProviderWire & { id: string },
  modelId: string,
): PiModel | undefined {
  runtime.registerProvider(provider.id, toAuthConfig(provider));
  let model: PiModel | undefined = runtime.getModel(provider.id, modelId);
  if (model === undefined || hasModelOverrides(provider.models)) {
    /**
     * **拿哪家的目录条目去保留合并：按 catalogId，不是按我们自己的 id。**
     *
     * 同一厂商的不同套餐是不同的接入方式，所以我们的 `zhipu-coding` 在 pi 目录里
     * 叫 `zai-coding-cn`。拿 `zhipu-coding` 去查一无所获 → `known` 为空 →
     * `toFallbackModels` 全落 FALLBACK_MODEL → **官方的 1M 窗口被拍成 128k**
     * （wafo 2026-09-03 实测）。
     *
     * 这与上面「先只注 auth 面」是**两个正交的 bug**，症状都是 128k：
     * 前者防的是「models 整体替换盖掉目录」，本处防的是「压根就没查到目录」。
     * 只修一个都还是 128k。
     *
     * 注册仍然用我们自己的 id：会话里 `model.provider` 要与 meta 对得上。
     */
    const source = provider.catalogId ?? provider.id;
    const providers = runtime.getProviders();
    const known = providers.find((p) => p.id === source);
    /**
     * 本家查不到时还有第二跳：**按模型 id 跨整个目录借**（见 shared/model-defaults）。
     * 自建网关本来就不属于哪一家，但它跑的 claude-opus-5 / k3 / glm-5.3 都是有官方
     * 口径的型号——不借就全落 128k，1M 模型会提前 8 倍触发压缩，图片还会被 pi 剥掉。
     */
    const catalog = providers.map(toBuiltinProvider);
    runtime.registerProvider(
      provider.id,
      toFallbackRegistration(provider, known?.getModels() ?? [], catalog, providers.flatMap((item) => item.getModels())),
    );
    model = runtime.getModel(provider.id, modelId);
  }
  return model;
}
