/**
 * 星系设计稿的 contextBridge 面 —— 四层契约的第 3 层。真源是工作区 planet/（shared/planet-design.ts）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { PlanetReadResult, PlanetWriteRequest, PlanetWriteResult } from "../../shared/planet-design.ts";

export const planetApi = {
  /** 读一个工作区的设计稿；planet/ 里什么都没有时 planets 为 null（界面回退种子稿） */
  read: (workspaceId: string): Promise<PlanetReadResult> => ipcRenderer.invoke(ipcChannels.planetRead, workspaceId),
  /** 设计面板改了就写回（插件稿只改名字与质量，其余写进伴随文件 galaxy.json） */
  write: (request: PlanetWriteRequest): Promise<PlanetWriteResult> => ipcRenderer.invoke(ipcChannels.planetWrite, request),
};
