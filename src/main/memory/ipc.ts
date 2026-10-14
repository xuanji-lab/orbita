/**
 * 记忆管理面的 IPC —— 四层契约的第 2 层（设置 › 记忆库 + 聊天摘抄 + 审查面板）。
 *
 * 与 agent 侧的 memoryRetrieveRequest / memoryAppend 是两条边界：那些由 agent 进程按
 * sessionId 问过来，作用域从会话 meta 解析（requests.ts）；这里是用户本人从设置页 /
 * 聊天划选管理自己的记忆库，作用域按 token 寻址（MemoryScopeToken）。两边最终都落
 * 到同一个 MemoryStore，只是「哪个作用域」的来源不同。
 *
 * 入参一律当不可信数据验（parseXxx，requests.ts）：类型声明是编译期的约定，
 * IPC 那头什么都能传。写路径（改 / 删 / 移 / 拍板）成功与否都在回执里说清，
 * 幂等语义与各 store 方法一致（不在 = 安静地什么都没发生）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { MEMORY_GLOBAL_SCOPE } from "../../shared/memory.ts";
import type {
  MemoryAddManualResponse,
  MemoryEntriesResponse,
  MemoryExcerptResponse,
  MemoryExcerptsResponse,
  MemoryListResponse,
  MemoryMoveGlobalResponse,
  MemoryPatchResponse,
  MemoryRemoveBatchResponse,
  MemoryRemoveResponse,
  MemoryResolveResponse,
  MemoryScopesResponse,
  MemorySessionTurnsResponse,
} from "../../shared/memory.ts";
import { memoryScopeOf, type MemoryStore } from "./store.ts";
import {
  listExcerpts,
  listLibraryItems,
  listScopes,
  parseAddManualRequest,
  parseBatchTarget,
  parseExcerptRequest,
  parsePatchRequest,
  parseResolveRequest,
  parseScopeToken,
  type SessionScopeReader,
  type WorkspaceReader,
} from "./requests.ts";
import { sessionTurns } from "./requests.ts";
import type { MemoryUsageStore } from "./usage.ts";

export interface MemoryIpcDeps {
  memory: MemoryStore;
  usage: MemoryUsageStore;
  sessions: SessionScopeReader;
  workspaces: WorkspaceReader;
}

export function registerMemoryIpc(deps: MemoryIpcDeps): void {
  const { memory, usage, sessions, workspaces } = deps;
  const globalToken = memory.tokenOf(MEMORY_GLOBAL_SCOPE);

  /** 作用域清单：工作区 / Home / 全局（分类与命名在 listScopes，纯函数可测）。 */
  ipcMain.handle(ipcChannels.memoryScopes, async (): Promise<MemoryScopesResponse> => ({
    scopes: await listScopes(memory, workspaces),
  }));

  /** 一个作用域的全部条目（落盘顺序）+ 使用统计 + 出处标题。空库 = 空数组。 */
  ipcMain.handle(
    ipcChannels.memoryEntries,
    async (_event, raw: unknown): Promise<MemoryEntriesResponse> => {
      const req = asTokenRequest(raw);
      return { items: await listLibraryItems(memory, usage, sessions, req.token) };
    },
  );

  /** 编辑 / 常驻开关 / 状态。entry=null = 这个 id 不在（幂等）。 */
  ipcMain.handle(ipcChannels.memoryPatch, async (_event, raw: unknown): Promise<MemoryPatchResponse> => {
    const req = parsePatchRequest(raw);
    return { entry: await memory.patch(req.token, req.entryId, req) };
  });

  /** 批量删。removed = 实际删掉的条数（不在的 id 不计数）。 */
  ipcMain.handle(
    ipcChannels.memoryRemoveBatch,
    async (_event, raw: unknown): Promise<MemoryRemoveBatchResponse> => {
      const req = parseBatchTarget(raw);
      return { removed: await memory.removeBatch(req.token, req.entryIds) };
    },
  );

  /** 移到全局：跨工作区召回才带得上的条目从这走。 */
  ipcMain.handle(
    ipcChannels.memoryMoveGlobal,
    async (_event, raw: unknown): Promise<MemoryMoveGlobalResponse> => {
      const req = parseBatchTarget(raw);
      return { moved: await memory.move(req.token, globalToken, req.entryIds) };
    },
  );

  /** 冲突拍板（undo=true 翻回去；drop-new 不可撤销——store 侧回 false）。 */
  ipcMain.handle(ipcChannels.memoryResolve, async (_event, raw: unknown): Promise<MemoryResolveResponse> => {
    const req = parseResolveRequest(raw);
    return {
      resolved: await memory.resolveConflict(
        req.token,
        globalToken,
        { newId: req.newId, oldId: req.oldId },
        req.resolution,
        req.undo,
      ),
    };
  });

  /** 添加摘抄（聊天划选）：作用域按会话归属解析，不由 renderer 给。 */
  ipcMain.handle(ipcChannels.memoryExcerpt, async (_event, raw: unknown): Promise<MemoryExcerptResponse> => {
    const req = parseExcerptRequest(raw);
    const meta = await sessions.readMeta(req.sessionId);
    if (meta === null) return { entry: null };
    const token = memory.tokenOf(memoryScopeOf(meta));
    return { entry: await memory.addExcerpt(token, req.sessionId, req) };
  });

  /** 手动添加（设置 › 记忆库）：用户自己写的一条。 */
  ipcMain.handle(ipcChannels.memoryAddManual, async (_event, raw: unknown): Promise<MemoryAddManualResponse> => {
    const req = parseAddManualRequest(raw);
    return { entry: await memory.addManual(req.token, req.text) };
  });

  /** 审查面板 › 记忆页签：本会话按轮的注入与新增 + 作用域待处理冲突数。 */
  ipcMain.handle(
    ipcChannels.memorySessionTurns,
    async (_event, raw: unknown): Promise<MemorySessionTurnsResponse> => {
      const req = asSessionRequest(raw);
      return await sessionTurns(sessions, memory, usage, req.sessionId);
    },
  );

  /** 右栏 › 摘抄页签：所有作用域的 excerpt 条目（当前会话的标 current）。 */
  ipcMain.handle(ipcChannels.memoryExcerpts, async (_event, raw: unknown): Promise<MemoryExcerptsResponse> => {
    const req = asSessionRequest(raw);
    return { items: await listExcerpts(memory, sessions, req.sessionId) };
  });

  /* ── v1 旧通道（按工作区列 / 删单条）——随记忆库页改版移除 ── */

  /** 这个作用域的全部条目，落盘顺序（旧在前）。空库 = 空数组，不是错误。 */
  ipcMain.handle(ipcChannels.memoryList, async (_event, raw: unknown): Promise<MemoryListResponse> => ({
    entries: await memory.list(memory.tokenOf(memoryScopeOf(parseMemoryScopeRef(raw)))),
  }));

  /**
   * 删一条。removed=false = 这个 id 不在（含文件不存在 / 空 id），**幂等不抛错**——
   * 用户连点两下删除，第二次安静地什么也不发生（store.remove 的语义）。
   */
  ipcMain.handle(ipcChannels.memoryRemove, async (_event, raw: unknown): Promise<MemoryRemoveResponse> => {
    const req = parseMemoryRemoveRequest(raw);
    return { removed: await memory.remove(memory.tokenOf(memoryScopeOf(req)), req.entryId) };
  });
}

/** memory:entries 的入参：只要一个 token。 */
function asTokenRequest(raw: unknown): { token: string } {
  const req = asRequestObject(raw);
  return { token: parseScopeToken(req.token) };
}

function asSessionRequest(raw: unknown): { sessionId: string } {
  const req = asRequestObject(raw);
  if (typeof req.sessionId !== "string" || req.sessionId === "") {
    throw new Error("memory request needs a string sessionId");
  }
  return { sessionId: req.sessionId };
}

function asRequestObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw new Error("memory request must be an object");
  return raw as Record<string, unknown>;
}

/* ── v1 旧入参校验（memory:list / memory:remove）——随记忆库页改版移除 ── */

type RequestRecord = { workspaceId?: unknown; cwd?: unknown; entryId?: unknown };

/**
 * 校验 renderer 传上来的作用域引用。**不信任地验**（files/ipc.ts 的同一条纪律）：
 * `MemoryScopeRef` 只是编译期的约定，IPC 那头是什么都可能——cwd 不是字符串、
 * workspaceId 是个数字，都会让 scopeId 变成一个莫名其妙的哈希键，进而在
 * userData 里凭空多出一个谁也看不懂的 memory 文件。当场抛，让 renderer 走统一的
 * catch（whitelistedPath 的同款处理）。
 */
function parseMemoryScopeRef(raw: unknown): { workspaceId: string | null; cwd: string } {
  const req = asRequestObject(raw) as RequestRecord;
  if (typeof req.cwd !== "string") throw new Error("memory request needs a string cwd");
  // 缺席（undefined）按「没有工作区」收：null 与不传在这个面上是同一件事，
  // renderer 写 `?? null` 还是直接透传都不该让面板白屏
  const workspaceId = req.workspaceId ?? null;
  if (workspaceId !== null && typeof workspaceId !== "string") {
    throw new Error("memory request workspaceId must be a string or null");
  }
  return { workspaceId, cwd: req.cwd };
}

function parseMemoryRemoveRequest(raw: unknown): { workspaceId: string | null; cwd: string; entryId: string } {
  const req = asRequestObject(raw) as RequestRecord;
  if (typeof req.entryId !== "string") throw new Error("memory request needs a string entryId");
  return { ...parseMemoryScopeRef(req), entryId: req.entryId };
}
