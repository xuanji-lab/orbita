/**
 * 子会话可选模型的**事实清单** —— IPC 契约层（派发前对齐段的数据面，2026-10-18）。
 *
 * 为什么要这一层：模型此前拿不到「有哪些模型可选」——只有 delegate 传错 model 时，
 * 主进程那句报错（main/channel/requests.ts 的 resolveSubSessionModel）才附带列表。
 * 「派发前对齐」要求 agent 主动推荐每块用哪个模型，它必须先把清单看在眼里，所以清单
 * 随每轮开轮命令进提示词。
 *
 * **只做事实陈述**：不排序、不写谁更强更便宜——强弱与成本由 agent 按名字推荐、用户
 * 拍板（合作者定稿）。能力同理：只搬运配置里已经声明的事实（`ModelDecl.vision`），
 * 没声明就是不知道（字段缺席），不查目录、不猜。
 *
 * 「能不能用」按 nav 状态点与模型菜单同一条判定 `hasCredentials` 过滤：列出一条没有
 * 密钥的模型，等于让 agent 推荐一个派下去必失败（`has no API key stored`）的模型。
 */
import { hasCredentials, type ProviderDto } from "./provider.ts";
import type { ModelPair } from "./settings.ts";

/** 一条「哪些模型可以派子会话」的事实。渲染成提示词一行（见 agent/delegation-prompt.ts）。 */
export interface AvailableModel {
  providerId: string;
  /** 厂商展示名：同一个 model id 可能出现在多个网关，给模型区分用 */
  providerName: string;
  modelId: string;
  /**
   * 展示名。配置没填声明名时就是 modelId——id 本身是事实，不算编造；
   * 而「更强的模型」这类判断不在这里，也不该由我们替用户下。
   */
  modelName: string;
  /** 能不能吃图片输入。配置里声明过才有值；缺席 = 不知道（不猜） */
  imageInput?: boolean;
}

/**
 * 纯函数：provider 配置（ProviderDto[]）→ 可选模型清单。
 * 顺序照 providers.json 里厂商的顺序、厂商内照声明的顺序——稳定，不做重排，
 * 用户排的顺序就是清单的顺序。
 */
export function availableModelsFromProviders(providers: readonly ProviderDto[]): AvailableModel[] {
  const models: AvailableModel[] = [];
  for (const provider of providers) {
    // 没配好密钥的厂商整个跳过：它的模型派过去必失败（与模型菜单的 usableProviders 同源）
    if (!hasCredentials(provider.auth)) continue;
    for (const model of provider.models.declared) {
      models.push({
        providerId: provider.id,
        providerName: provider.displayName,
        modelId: model.id,
        modelName: model.name ?? model.id,
        // vision 没声明就彻底不带键（缺席 = 不知道），别塞一个 undefined 占位
        ...(model.vision === undefined ? {} : { imageInput: model.vision }),
      });
    }
  }
  return models;
}

/**
 * 设置里的「子会话模型」此刻是否真的会生效：provider 还在注册表里才算。
 *
 * 判据与 `resolveSubSessionModel`（main/channel/requests.ts）里那句**必须一致**——
 * 两处讲的是同一件事。provider 被删时运行时退回同父（易耗品处理），提示词若还讲
 * 「沿用设置里的子会话模型 (X)」，模型就会据此向用户复述一个不会发生的落点
 * （2026-10-19 验收发现的边界）。
 *
 * 返回 undefined = 不点名时并没有设置项可落，提示词该如实讲「同父」。
 */
export function usableSubSessionSetting(
  setting: ModelPair | undefined,
  providers: readonly ProviderDto[],
): ModelPair | undefined {
  if (setting === undefined) return undefined;
  return providers.some((provider) => provider.id === setting.providerId) ? setting : undefined;
}
