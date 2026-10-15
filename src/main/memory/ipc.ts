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
  MemoryBackfillStartResponse,
  MemoryEntriesResponse,
  MemoryExcerptResponse,
  MemoryExcerptsResponse,
  MemoryMoveGlobalResponse,
  MemoryPatchResponse,
  MemoryRemoveBatchResponse,
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
import { parseBackfillRange, type MemoryBackfillService } from "./backfill.ts";

export interface MemoryIpcDeps {
  memory: MemoryStore;
  usage: MemoryUsageStore;
  sessions: SessionScopeReader;
  workspaces: WorkspaceReader;
  /** 从历史生成（补蒸）的任务编排：预估 / 开始 / 暂停 / 继续 / 取消 / 读状态。 */
  backfill: MemoryBackfillService;
}

export function registerMemoryIpc(deps: MemoryIpcDeps): void {
  const { memory, usage, sessions, workspaces, backfill } = deps;
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

  /* ---------- 从历史生成（补蒸）：memory:backfill-* 六个通道 ---------- */

  /** 预估（只读不写）：范围待蒸轮数 / 已蒸跳过 / 粗估 token / 家务活模型。 */
  ipcMain.handle(
    ipcChannels.memoryBackfillEstimate,
    async (_event, raw: unknown) => backfill.estimate(parseBackfillRange(raw)),
  );

  /** 开跑：已有任务在跑 / 暂停中不另起（started=false）；开关关着拒绝并写原因。 */
  ipcMain.handle(
    ipcChannels.memoryBackfillStart,
    async (_event, raw: unknown): Promise<MemoryBackfillStartResponse> =>
      backfill.start(parseBackfillRange(raw)),
  );

  /** 暂停：状态立即翻 paused，在飞的那批蒸完照常落盘（那是已付的钱）。 */
  ipcMain.handle(ipcChannels.memoryBackfillPause, () => backfill.pause());

  /** 继续：重收计划（暂停期间新聊的轮一并接上），接着计数往下跑。 */
  ipcMain.handle(ipcChannels.memoryBackfillResume, () => backfill.resume());

  /** 取消：清队、状态 cancelled；已落的条目保留。 */
  ipcMain.handle(ipcChannels.memoryBackfillCancel, () => backfill.cancel());

  /** 读状态（闲聊拉取；细粒度进度靠 memoryBackfillEvent 推送）。 */
  ipcMain.handle(ipcChannels.memoryBackfillStatus, () => backfill.statusSnapshot());

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
