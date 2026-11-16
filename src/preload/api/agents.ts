/**
 * 常驻主智能体的 contextBridge 面 —— 四层契约的第 3 层（`agents:main`）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { MainAgentModelInput, MainAgentProfile } from "../../shared/main-agent.ts";

export const agentsApi = {
  /** 某工作区的主智能体档案（没有就建；只预留会话 id，会话在第一句话发出时才落盘） */
  main: (workspaceId: string): Promise<MainAgentProfile> => ipcRenderer.invoke(ipcChannels.agentsMain, workspaceId),
  /** 定这个工作区的主智能体以后都用的型号与思考档；回更新后的档案 */
  setMainModel: (input: MainAgentModelInput): Promise<MainAgentProfile> => ipcRenderer.invoke(ipcChannels.agentsSetMainModel, input),
} as const;
