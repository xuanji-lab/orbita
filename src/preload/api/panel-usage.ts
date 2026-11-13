/**
 * 面板打开次数的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/panel-usage.ts）。
 * 只在本机记账、不上传；bump 在面板被打开的那一拍发，get 给设置页的只读统计。
 */
import { ipcRenderer } from "electron";
import { panelUsageChannels, type PanelUsageKey, type PanelUsageSnapshot } from "../../shared/panel-usage.ts";

export const panelUsageApi = {
  /** 当前计数（since 起算） */
  get: (): Promise<PanelUsageSnapshot> => ipcRenderer.invoke(panelUsageChannels.get),
  /** 记一次打开；回的是记完之后的整份 */
  bump: (key: PanelUsageKey): Promise<PanelUsageSnapshot> => ipcRenderer.invoke(panelUsageChannels.bump, key),
};
