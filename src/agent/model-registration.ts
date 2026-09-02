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
import type { BuiltinModel } from "../shared/agent-ipc.ts";
import type { ModelDecl } from "../shared/provider.ts";

/** pi 注册表里的模型对象——从 ModelRuntime 的方法签名推出来，不另维护一份类型 */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
/** registerProvider 第二参的完整形状（同上，签名推导） */
export type PiProviderRegistration = Parameters<ModelRuntime["registerProvider"]>[1];

/**
 * 目录不认识的模型 id 的保守默认（Q2）：自建网关声明的 id、目录还没收录的新模型。
 * **只有目录 miss 后的补注册会用它**——目录认识的 id 走官方参数（窗口 / 单价），
 * 那才是「配置好的模型」的真实元数据。填错影响压缩时机与用量统计，不影响能不能跑。
 */
export const FALLBACK_MODEL = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

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
): NonNullable<PiProviderRegistration["models"]> {
  return declared.map((decl) => {
    const known = current.find((model) => model.id === decl.id);
    const base = known === undefined ? { id: decl.id, name: decl.id, ...FALLBACK_MODEL } : { ...known };
    return {
      ...base,
      name: decl.name ?? base.name,
      contextWindow: decl.contextWindow ?? base.contextWindow,
      maxTokens: decl.maxTokens ?? base.maxTokens,
      // cost 是整份替换（校验保证四档齐全）：用户明确报价，连目录的 tiers 一起作废
      ...(decl.cost === undefined ? {} : { cost: { ...decl.cost } }),
    };
  });
}

/**
 * 任一声明模型带了用户覆盖字段吗。**带覆盖时即使目录认识选中 id 也必须补注册**——
 * 不重注册的话 getModel 返回的是目录原值，用户填的窗口 / 费率永远不生效。
 */
export function hasModelOverrides(models: readonly ModelDecl[]): boolean {
  return models.some(
    (model) =>
      model.contextWindow !== undefined || model.maxTokens !== undefined || model.cost !== undefined,
  );
}

/** 目录模型 → 设置面展示的瘦身形状：只留 id 与三组参数，剥掉 pi 的 tiers 等无消费者字段 */
export function toBuiltinModel(model: PiModel): BuiltinModel {
  return {
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
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
): PiProviderRegistration {
  return {
    ...toAuthConfig(provider),
    models: toFallbackModels(current, provider.models),
  };
}

/**
 * 注册（先 auth 面，目录 miss / 用户覆盖时补注册兜底）并解析选中模型。
 * create 与会话内换模型（C-4）共用同一条装配路径——解析规则必须一致，
 * 否则「建会话能用的模型」和「切过去能用的模型」是两套真相。
 */
export function registerAndResolveModel(
  runtime: Pick<ModelRuntime, "registerProvider" | "getModel" | "getProviders">,
  provider: ProviderWire,
  modelId: string,
): PiModel | undefined {
  runtime.registerProvider(provider.id, toAuthConfig(provider));
  let model: PiModel | undefined = runtime.getModel(provider.id, modelId);
  if (model === undefined || hasModelOverrides(provider.models)) {
    const known = runtime.getProviders().find((p) => p.id === provider.id);
    runtime.registerProvider(provider.id, toFallbackRegistration(provider, known?.getModels() ?? []));
    model = runtime.getModel(provider.id, modelId);
  }
  return model;
}
