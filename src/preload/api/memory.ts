/**
 * 记忆管理面的 contextBridge 面 —— 四层契约的第 3 层（设置 › 记忆）。
 * 作用域由 renderer 显式给出（workspaceId ?? cwd，契约在 shared/memory.ts）：
 * 用户是按工作区翻自己的记忆库，不是按某条会话——agent 侧那条按 sessionId 问的路子
 * 不走这里（memoryRetrieveRequest / memoryAppend，shared/agent-ipc.ts）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  MemoryListRequest,
  MemoryListResponse,
  MemoryRemoveRequest,
  MemoryRemoveResponse,
} from "../../shared/memory.ts";

export const memoryApi = {
  /** 这个作用域的全部条目，落盘顺序（旧在前）；空库是空数组，不是错误 */
  list: (req: MemoryListRequest): Promise<MemoryListResponse> => ipcRenderer.invoke(ipcChannels.memoryList, req),
  /** 删一条；removed=false 表示这个 id 不在（幂等，不报错） */
  remove: (req: MemoryRemoveRequest): Promise<MemoryRemoveResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryRemove, req),
} as const;
