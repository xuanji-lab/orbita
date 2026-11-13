/**
 * 面板打开次数的 IPC —— 四层契约的第 2 层（契约在 shared/panel-usage.ts）。
 * 入参当不可信数据：不认识的面板键直接抛（invoke 在 renderer 侧变 rejected promise）。
 */
import { ipcMain } from "electron";
import { isPanelUsageKey, panelUsageChannels, type PanelUsageSnapshot } from "../../shared/panel-usage.ts";
import type { PanelUsageStore } from "./store.ts";

export function registerPanelUsageIpc(store: PanelUsageStore): void {
  ipcMain.handle(panelUsageChannels.get, (): Promise<PanelUsageSnapshot> => store.get());
  ipcMain.handle(panelUsageChannels.bump, (_event, raw: unknown): Promise<PanelUsageSnapshot> => {
    if (!isPanelUsageKey(raw)) throw new Error("invalid panel usage key");
    return store.bump(raw);
  });
}
