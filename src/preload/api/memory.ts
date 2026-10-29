/**
 * 记忆库的 contextBridge 面 —— 四层契约的第 3 层。界面（审查面板「记忆」页签、
 * 记忆库页）全部数据与写操作从这里走；变更推送不在这里单独开订阅——走
 * agent.onEvent 的 memoryChanged（skillsChanged 同款）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  MemoryEntriesRequest,
  MemoryEntriesResponse,
  MemoryMutation,
  MemoryMutationOutcome,
  MemoryScopeSummary,
  MemorySessionView,
  MemoryVectorSettings,
  MemoryVectorStatus,
} from "../../shared/memory.ts";

export const memoryApi = {
  /** 作用域清单（记忆库左栏：user 层恒在 + 各工作区 + Home） */
  scopes: (): Promise<MemoryScopeSummary[]> => ipcRenderer.invoke(ipcChannels.memoryScopes),
  /** 条目列表：按作用域（"all" = 全部）+ 类型筛，每条带标题 / 原话片段 / 演变链 */
  entries: (request: MemoryEntriesRequest): Promise<MemoryEntriesResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryEntries, request),
  /** 某会话按轮的记忆视图（轮尾卡与审查 › 记忆页签共用） */
  session: (sessionId: string): Promise<MemorySessionView> =>
    ipcRenderer.invoke(ipcChannels.memorySession, sessionId),
  /** 六种写操作（edit / remove / setStatus / addManual / restorePrevious / returnToWorkspace）；
   *  结果以返回值为准，成功后另有 memoryChanged 推送 */
  mutate: (mutation: MemoryMutation): Promise<MemoryMutationOutcome> =>
    ipcRenderer.invoke(ipcChannels.memoryMutate, mutation),
  /** 本地向量模型的设置页快照（设备 / llama-server / 模型文件 / 补算与向量库）。 */
  vectorStatus: (): Promise<MemoryVectorStatus> => ipcRenderer.invoke(ipcChannels.memoryVectorStatus),
  /** 向量设置的部分更新；换模型会让服务清掉旧向量并重算。 */
  vectorSet: (patch: Partial<MemoryVectorSettings>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(ipcChannels.memoryVectorSet, patch),
  /** 下载当前选中的 GGUF；进度走 agent.onEvent 的 vectorDownload。 */
  vectorDownload: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(ipcChannels.memoryVectorDownload),
} as const;
