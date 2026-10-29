/**
 * 家务活模型装配（设置里的 choreModel → 带密钥面的载荷）。
 * 两个消费者：agent IPC 的 readChoreModel（起名 / 收尾清单等小活）与记忆线
 * （服务 init / 每轮 turnSettled）。没指定、指的 provider 已删、或密钥取不到，
 * 一律返回 undefined 让调用方退回——家务是易耗品，不该因为一个删掉的 provider
 * 就停掉；但原因要落到 dev 终端，否则「我选了模型为什么没生效」无从查起。
 */
import type { MemoryChoreModel } from "../../shared/memory.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { ProviderStore } from "../provider/store.ts";
import { resolveProviderSecrets } from "../agent/ipc.ts";

/** 形状与 generateTitle 等命令的 model 载荷同构（MemoryChoreModel 是它的命名版）。 */
export async function choreModelPayload(
  settings: SettingsStore,
  providers: ProviderStore,
): Promise<MemoryChoreModel | undefined> {
  const choice = (await settings.read()).choreModel;
  if (choice === undefined) return undefined;
  try {
    return {
      provider: await resolveProviderSecrets(providers, choice.providerId),
      modelId: choice.modelId,
    };
  } catch (error: unknown) {
    console.error(
      `[main] 家务活模型 ${choice.providerId}/${choice.modelId} 装配失败，这件家务退回 / 跳过`,
      error,
    );
    return undefined;
  }
}
