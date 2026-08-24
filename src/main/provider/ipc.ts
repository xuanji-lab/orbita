/**
 * provider 域的 IPC handler —— 四层契约的第 2 层。
 * 校验失败不是异常路径而是正常结果：把 issues 结构化地还给 renderer，让表单逐项标红。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";
import { discoverModels, type DiscoveredModels } from "./discover.ts";
import { ProviderStore, ProviderValidationError } from "./store.ts";

export type UpsertResult =
  | { ok: true; provider: ProviderDto }
  | { ok: false; issues: ValidationIssue[] };

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
      input: { baseUrl: string; apiKey?: string; providerId?: string },
    ): Promise<DiscoveredModels> => {
      const apiKey =
        input.apiKey !== undefined && input.apiKey !== ""
          ? input.apiKey
          : input.providerId === undefined
            ? null
            : await store.resolveApiKey(input.providerId);
      if (apiKey === null) {
        return { ok: false, models: [], message: "Enter an API key first." };
      }
      return discoverModels({ baseUrl: input.baseUrl, apiKey });
    },
  );

  ipcMain.handle(ipcChannels.providerRemove, (_event, id: string): Promise<void> =>
    store.remove(id),
  );
}
