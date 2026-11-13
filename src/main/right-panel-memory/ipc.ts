/**
 * 右栏记忆的 IPC —— 四层契约的第 2 层（契约在 shared/right-panel-memory.ts）。
 * 入参当不可信数据：信封校验在 store.save 里，不对就抛。
 */
import { ipcMain } from "electron";
import { rightPanelMemoryChannels, type RightPanelMemoryFile } from "../../shared/right-panel-memory.ts";
import type { RightPanelMemoryStore } from "./store.ts";

export function registerRightPanelMemoryIpc(store: RightPanelMemoryStore): void {
  ipcMain.handle(rightPanelMemoryChannels.load, (): Promise<RightPanelMemoryFile | null> => store.load());
  ipcMain.handle(rightPanelMemoryChannels.save, (_event, raw: unknown): Promise<void> => store.save(raw));
}
