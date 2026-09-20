/**
 * 设置的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { AppSettings, SettingsPatch } from "../../shared/settings.ts";

export const settingsApi = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.settingsGet),
  /** 部分更新；返回落盘后的完整设置 */
  set: (patch: SettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke(ipcChannels.settingsSet, patch),
};
