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
import type { BuiltinModel, BuiltinProvider } from "../shared/agent-ipc.ts";
import { resolveModelDefaults, type CatalogPreference } from "../shared/model-defaults.ts";
import type { ModelDecl } from "../shared/provider.ts";

/** pi 注册表里的模型对象——从 ModelRuntime 的方法签名推出来，不另维护一份类型 */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
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
): NonNullable<PiProviderRegistration["models"]> {
  return declared.map((decl) => {
    const known = current.find((model) => model.id === decl.id);
    /**
     * 本家目录条目**整条保留**（带 thinkingLevelMap / compat 这些跨家借不得的字段）；
     * 本家没有才退到跨目录推断，且只借参数四件套——别家的协议开关借过来会出错。
     */
    const borrowed = resolveModelDefaults(catalog, decl.id, prefer);
    const base =
      known === undefined
        ? {
            id: decl.id,
            name: decl.id,
            reasoning: false,
            input: borrowed.input,
            cost: borrowed.cost,
            contextWindow: borrowed.contextWindow,
            maxTokens: borrowed.maxTokens,
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
): PiProviderRegistration {
  return {
    ...toAuthConfig(provider),
    models: toFallbackModels(current, provider.models, catalog, {
      catalogId: provider.catalogId,
      api: provider.api,
    }),
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
      toFallbackRegistration(provider, known?.getModels() ?? [], catalog),
    );
    model = runtime.getModel(provider.id, modelId);
  }
  return model;
}
