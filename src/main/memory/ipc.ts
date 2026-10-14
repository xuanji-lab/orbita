/**
 * 记忆管理面的 IPC —— 四层契约的第 2 层（设置 › 记忆：列条目 / 删一条）。
 *
 * 与 agent 侧的 memoryRetrieveRequest / memoryAppend 是两条边界：那些由 agent 进程按
 * sessionId 问过来，作用域从会话 meta 解析（requests.ts）；这里是用户本人从设置页按
 * 工作区翻自己的记忆库，作用域由 renderer 显式给出（workspaceId ?? cwd，契约在
 * shared/memory.ts）。两边最终都落到同一个 MemoryStore，只是「哪个作用域」的来源不同。
 *
 * 入参一律当不可信数据验（parseMemoryScopeRef / parseMemoryRemoveRequest，requests.ts）：
 * 类型声明是编译期的约定，IPC 那头什么都能传。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { MemoryListResponse, MemoryRemoveResponse } from "../../shared/memory.ts";
import { memoryScopeOf, type MemoryStore } from "./store.ts";
import { parseMemoryRemoveRequest, parseMemoryScopeRef } from "./requests.ts";

export function registerMemoryIpc(memory: MemoryStore): void {
  /** 这个作用域的全部条目，落盘顺序（旧在前）。空库 = 空数组，不是错误。 */
  ipcMain.handle(ipcChannels.memoryList, async (_event, raw: unknown): Promise<MemoryListResponse> => ({
    entries: await memory.list(memoryScopeOf(parseMemoryScopeRef(raw))),
  }));

  /**
   * 删一条。removed=false = 这个 id 不在（含文件不存在 / 空 id），**幂等不抛错**——
   * 用户连点两下删除，第二次安静地什么也不发生（store.remove 的语义）。
   */
  ipcMain.handle(ipcChannels.memoryRemove, async (_event, raw: unknown): Promise<MemoryRemoveResponse> => {
    const req = parseMemoryRemoveRequest(raw);
    return { removed: await memory.remove(memoryScopeOf(req), req.entryId) };
  });
}
