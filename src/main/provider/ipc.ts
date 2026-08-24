/**
 * provider 域的 IPC handler —— 四层契约的第 2 层。
 * 校验失败不是异常路径而是正常结果：把 issues 结构化地还给 renderer，让表单逐项标红。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";
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

  ipcMain.handle(ipcChannels.providerRemove, (_event, id: string): Promise<void> =>
    store.remove(id),
  );
}
