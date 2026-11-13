/**
 * 右栏记忆的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/right-panel-memory.ts）。
 * 启动时 load 一次；变化后 renderer 防抖 save 整份。
 */
import { ipcRenderer } from "electron";
import { rightPanelMemoryChannels, type RightPanelMemoryFile } from "../../shared/right-panel-memory.ts";

export const rightPanelMemoryApi = {
  /** 读上次的记忆；文件不在 / 坏了回 null */
  load: (): Promise<RightPanelMemoryFile | null> => ipcRenderer.invoke(rightPanelMemoryChannels.load),
  /** 整份写回（原子） */
  save: (file: RightPanelMemoryFile): Promise<void> => ipcRenderer.invoke(rightPanelMemoryChannels.save, file),
};
