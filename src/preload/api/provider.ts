/**
 * provider 域的 contextBridge 面 —— 四层契约的第 3 层。
 * 只依赖 electron 与 src/shared；不 import 主进程模块（分层守卫的红线）。
 * 注意 API 形状：明文密钥只有 renderer → main 这一个方向，回来的永远是 ProviderDto。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";

export type UpsertResult =
  | { ok: true; provider: ProviderDto }
  | { ok: false; issues: ValidationIssue[] };

export const providerApi = {
  list: (): Promise<ProviderDto[]> => ipcRenderer.invoke(ipcChannels.providerList),
  upsert: (input: ProviderUpsertInput): Promise<UpsertResult> =>
    ipcRenderer.invoke(ipcChannels.providerUpsert, input),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.providerRemove, id),
};
