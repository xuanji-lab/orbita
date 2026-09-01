/**
 * provider 注册的纯装配层 —— 从 runtime 抽出来只为可测（runtime 本体被 parentPort
 * 守卫钉死在 utility 进程里，node --test 加载即退出）。
 *
 * 背景语义（pi provider-composer 的 applyExtension）：注册时的 models 数组是
 * **整体替换**——带上它就会把内建目录里的官方参数（上下文窗口 / 单价）盖掉。
 * 所以注册分两步：先只给 auth（目录元数据存活），目录里解析不到选中的模型 id 时
 * 才补注册兜底 models，且补注册要**保留合并**——已认识的目录条目原样带回。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
 * 补注册的 models：**保留合并**——注册表里已认识的 id（目录条目，带官方窗口 / 单价）
 * 原样带回，只有目录没有的 id 才落兜底默认。不做保留的话，补一个新 id 会把同
 * provider 其它目录模型的官方参数一并砸掉（models 是整体替换，已验证）。
 */
export function toFallbackModels(
  current: readonly PiModel[],
  declared: readonly string[],
): NonNullable<PiProviderRegistration["models"]> {
  return declared.map((id) => {
    const known = current.find((model) => model.id === id);
    return known === undefined ? { id, name: id, ...FALLBACK_MODEL } : { ...known };
  });
}

/** 与 runtime 的 create 命令里 provider 载荷同形（结构匹配，不引 AgentCommand 耦合） */
interface ProviderWire {
  apiKey: string;
  baseUrl: string;
  api: string;
  headers?: Record<string, string>;
  models: string[];
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
