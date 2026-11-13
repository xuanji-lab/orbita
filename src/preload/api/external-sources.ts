/**
 * 外部来源的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/external-sources.ts）。
 * 开关走 settingsApi.set({ externalSources })，自定义目录走 importApi 的 custom-roots。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ExternalSourcesResult } from "../../shared/external-sources.ts";

export const externalSourcesApi = {
  /** 发现的来源、数据目录、会话数与开关；只 stat，不读会话内容 */
  list: (): Promise<ExternalSourcesResult> => ipcRenderer.invoke(ipcChannels.externalSourcesList),
};
