/**
 * 星系设计稿的 contextBridge 面 —— 四层契约的第 3 层。真源是工作区 planet/（shared/planet-design.ts）。
 * 子智能体档案（shared/sub-agent.ts）挂在同一个面上：它和形象稿住在同一个 planet/ 里，面板里一起改。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { PlanetReadResult, PlanetWriteRequest, PlanetWriteResult } from "../../shared/planet-design.ts";
import type { SubAgentCreateRequest, SubAgentDeleteRequest, SubAgentMutationResult, SubAgentUpdateRequest } from "../../shared/sub-agent.ts";

export const planetApi = {
  /** 读一个工作区的设计稿；planet/ 里什么都没有时 planets 为 null（界面回退种子稿） */
  read: (workspaceId: string): Promise<PlanetReadResult> => ipcRenderer.invoke(ipcChannels.planetRead, workspaceId),
  /** 设计面板改了就写回（插件稿只改名字与质量，其余写进伴随文件 galaxy.json） */
  write: (request: PlanetWriteRequest): Promise<PlanetWriteResult> => ipcRenderer.invoke(ipcChannels.planetWrite, request),
  /** 面板里新建一个子智能体（名字 + 职能；放在默认空轨道上），回新 id */
  createSubAgent: (request: SubAgentCreateRequest): Promise<SubAgentMutationResult> => ipcRenderer.invoke(ipcChannels.subAgentCreate, request),
  /** 改名字 / 职能 / 默认模型 */
  updateSubAgent: (request: SubAgentUpdateRequest): Promise<SubAgentMutationResult> => ipcRenderer.invoke(ipcChannels.subAgentUpdate, request),
  /** 删（用户在面板里确认过）：名单拿掉，档案目录挪进 planet/agents/.deleted/ */
  deleteSubAgent: (request: SubAgentDeleteRequest): Promise<SubAgentMutationResult> => ipcRenderer.invoke(ipcChannels.subAgentDelete, request),
};
