/**
 * 记忆管理面的 contextBridge 面 —— 四层契约的第 3 层（设置 › 记忆库 / 聊天摘抄 /
 * 审查面板）。作用域按 token 寻址（MemoryScopeToken，sha1(scopeId) 的文件名）：
 * 用户翻自己的记忆库、从聊天划选摘抄，都不经会话 meta——那条按 sessionId 问的
 * agent 侧路子（memoryRetrieveRequest / memoryAppend）不走这里。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  MemoryAddManualRequest,
  MemoryAddManualResponse,
  MemoryEntriesRequest,
  MemoryEntriesResponse,
  MemoryExcerptRequest,
  MemoryExcerptResponse,
  MemoryExcerptsRequest,
  MemoryExcerptsResponse,
  MemoryMoveGlobalRequest,
  MemoryMoveGlobalResponse,
  MemoryPatchRequest,
  MemoryPatchResponse,
  MemoryRemoveBatchRequest,
  MemoryRemoveBatchResponse,
  MemoryResolveRequest,
  MemoryResolveResponse,
  MemoryScopesResponse,
  MemorySessionTurnsResponse,
} from "../../shared/memory.ts";

export const memoryApi = {
  /** 作用域清单：工作区 / Home / 全局（含条目数）。地址就是返回的 token。 */
  scopes: (): Promise<MemoryScopesResponse> => ipcRenderer.invoke(ipcChannels.memoryScopes),
  /** 一个作用域的全部条目 + 使用统计 + 出处会话标题。空库是空数组，不是错误。 */
  entries: (req: MemoryEntriesRequest): Promise<MemoryEntriesResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryEntries, req),
  /** 编辑正文 / 常驻开关 / 状态。entry=null 表示这个 id 不在（幂等）。 */
  patch: (req: MemoryPatchRequest): Promise<MemoryPatchResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryPatch, req),
  /** 批量删；removed = 实际删掉的条数。 */
  removeBatch: (req: MemoryRemoveBatchRequest): Promise<MemoryRemoveBatchResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryRemoveBatch, req),
  /** 移到全局（跨工作区召回才带得上）。 */
  moveGlobal: (req: MemoryMoveGlobalRequest): Promise<MemoryMoveGlobalResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryMoveGlobal, req),
  /** 冲突拍板（undo=true 翻回去；drop-new 不可撤销）。 */
  resolve: (req: MemoryResolveRequest): Promise<MemoryResolveResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryResolve, req),
  /** 添加摘抄（聊天划选）：作用域由主进程按会话归属解析。 */
  addExcerpt: (req: MemoryExcerptRequest): Promise<MemoryExcerptResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryExcerpt, req),
  /** 全库摘抄（右栏 › 摘抄页签）：所有作用域的 excerpt 条目。 */
  excerpts: (req: MemoryExcerptsRequest): Promise<MemoryExcerptsResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryExcerpts, req),
  /** 手动添加（设置 › 记忆库）：常驻、算「我说的 · 立场」。 */
  addManual: (req: MemoryAddManualRequest): Promise<MemoryAddManualResponse> =>
    ipcRenderer.invoke(ipcChannels.memoryAddManual, req),
  /** 审查面板 › 记忆页签：本会话按轮的注入与新增 + 待处理冲突数。 */
  sessionTurns: (sessionId: string): Promise<MemorySessionTurnsResponse> =>
    ipcRenderer.invoke(ipcChannels.memorySessionTurns, { sessionId }),
} as const;
