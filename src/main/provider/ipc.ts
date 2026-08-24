/**
 * provider 域的 IPC handler —— 四层契约的第 2 层。
 * 校验失败不是异常路径而是正常结果：把 issues 结构化地还给 renderer，让表单逐项标红。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";
import { discoverModels, type DiscoveredModels } from "./discover.ts";
import { testConnection, type ConnectionTestResult } from "./test-connection.ts";
import { ProviderStore, ProviderValidationError } from "./store.ts";

export type UpsertResult =
  | { ok: true; provider: ProviderDto }
  | { ok: false; issues: ValidationIssue[] };

/** 密钥来源：表单里刚输入的优先，否则取已存的 */
async function resolveKey(
  store: ProviderStore,
  typed: string | undefined,
  providerId: string | undefined,
): Promise<string | null> {
  if (typed !== undefined && typed !== "") return typed;
  if (providerId === undefined) return null;
  return store.resolveApiKey(providerId);
}

export function registerProviderIpc(store: ProviderStore): void {
  ipcMain.handle(ipcChannels.providerList, (): Promise<ProviderDto[]> => store.list());

  ipcMain.handle(
    ipcChannels.providerUpsert,
    async (_event, input: ProviderUpsertInput): Promise<UpsertResult> => {
      try {
        return { ok: true, provider: await store.upsert(input) };
      } catch (error) {
        if (error instanceof ProviderValidationError) return { ok: false, issues: error.issues };
        throw error;
      }
    },
  );

  // 从供应商获取模型：密钥可以是表单里刚输入的（还没保存），也可以取已存的
  ipcMain.handle(
    ipcChannels.providerDiscover,
    async (
      _event,
      input: { baseUrl: string; api: string; apiKey?: string; providerId?: string },
    ): Promise<DiscoveredModels> => {
      const apiKey = await resolveKey(store, input.apiKey, input.providerId);
      if (apiKey === null) {
        return { ok: false, models: [], message: "Enter an API key first." };
      }
      return discoverModels({ baseUrl: input.baseUrl, api: input.api, apiKey });
    },
  );

  // 测试连接：用表单当前值，不必先保存
  ipcMain.handle(
    ipcChannels.providerTest,
    async (
      _event,
      input: { api: string; baseUrl: string; modelId: string; apiKey?: string; providerId?: string },
    ): Promise<ConnectionTestResult> => {
      const apiKey = await resolveKey(store, input.apiKey, input.providerId);
      if (apiKey === null) return { ok: false, message: "Enter an API key first." };
      return testConnection({ ...input, apiKey });
    },
  );

  /**
   * 显示明文密钥。**这是「密钥不过 IPC」边界上唯一的一个显式开口**——
   * 只在用户点眼睛时取一次，不随 list 下发。用户明确要求要能核对自己粘的 key 对不对。
   */
  ipcMain.handle(ipcChannels.providerReveal, (_event, id: string): Promise<string | null> =>
    store.resolveApiKey(id),
  );

  ipcMain.handle(ipcChannels.providerRemove, (_event, id: string): Promise<void> =>
    store.remove(id),
  );
}
