/**
 * 星系设计稿的 contextBridge 面 —— 四层契约的第 3 层。真源是工作区 planet/（shared/planet-design.ts）。
 * 子智能体档案（shared/sub-agent.ts）挂在同一个面上：它和形象稿住在同一个 planet/ 里，面板里一起改。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { PlanetReadResult, PlanetWriteRequest, PlanetWriteResult } from "../../shared/planet-design.ts";
import type { AvatarBodyRef, AvatarGenerateRequest, AvatarHistoryResult, AvatarJobEvent, AvatarJobResult, AvatarRenderPolicyResult, AvatarRenderPolicySetRequest, AvatarSelectRequest } from "../../shared/planet-avatar.ts";
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
  /** 「生成形象」：开一组候选（幕后会话跑插件 planet-render）；同一颗正在出图时回错误。
   *  `model` 是面板解析好的具体型号（胶囊上显示的就是它），主进程以它为准、只校验可用 */
  generateAvatar: (request: AvatarGenerateRequest): Promise<AvatarJobResult> => ipcRenderer.invoke(ipcChannels.planetAvatarGenerate, request),
  /** 这颗天体当前这一轮（活任务，或按盘上账本重建）；从没出过图为 null */
  avatarJob: (request: AvatarBodyRef): Promise<AvatarJobResult> => ipcRenderer.invoke(ipcChannels.planetAvatarGet, request),
  /** 每一轮的自然语言要求与候选；可以选回任意旧候选 */
  avatarHistory: (request: AvatarBodyRef): Promise<AvatarHistoryResult> => ipcRenderer.invoke(ipcChannels.planetAvatarHistory, request),
  /** 挑一张写进 planet/ */
  selectAvatar: (request: AvatarSelectRequest): Promise<AvatarJobResult> => ipcRenderer.invoke(ipcChannels.planetAvatarSelect, request),
  cancelAvatar: (request: AvatarBodyRef): Promise<AvatarJobResult> => ipcRenderer.invoke(ipcChannels.planetAvatarCancel, request),
  /** 「用生图工具」开关此刻的状态（读插件的策略文件；插件没装为 ok:false） */
  avatarRenderPolicy: (): Promise<AvatarRenderPolicyResult> => ipcRenderer.invoke(ipcChannels.planetAvatarPolicyGet),
  /** 拨开关：经插件脚本把策略文件写成手绘 / 用生图工具 */
  setAvatarRenderPolicy: (request: AvatarRenderPolicySetRequest): Promise<AvatarRenderPolicyResult> =>
    ipcRenderer.invoke(ipcChannels.planetAvatarPolicySet, request),
  /** 进度推送；返回退订函数 */
  onAvatarJob: (listener: (event: AvatarJobEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AvatarJobEvent) => listener(event);
    ipcRenderer.on(ipcChannels.planetAvatarEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.planetAvatarEvent, handler);
  },
};
