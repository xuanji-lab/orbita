/**
 * memoryRetrieveRequest / memoryAppend 在主进程的落点——**与 readTaskRequest 同一条边界**：
 * agent 进程不碰 userData，作用域（workspaceId ?? cwd）由主进程按会话归属解析，
 * 读写在主进程。纯核在 store / retrieve，这里只剩「解析作用域 → 调 store」一跳
 * 另一半是**设置 › 记忆的管理面**（memory:list / memory:remove）：用户本人按工作区翻
 * 自己的记忆库，作用域由 renderer 显式给出、不从会话 meta 解析。那条路子的入参校验
 * （parseMemoryScopeRef / parseMemoryRemoveRequest）也住这里——ipc.ts import electron，
 * 判断放那里就没法被 `node --test` 直接测（files/list.ts 的同款先例）。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { MemoryRemoveRequest, MemoryRetrieveOutcome, MemoryScopeRef } from "../../shared/memory.ts";
import { retrieveMemories } from "./retrieve.ts";
import { memoryScopeOf, type MemoryStore } from "./store.ts";

/**
 * 会话归属的最小只读视图（read-task.ts 的 SessionStoreReader 同一条纪律：
 * 收窄到只用得到的字段）。SessionStore 结构化满足本接口，测试给 stub。
 */
export interface SessionScopeReader {
  readMeta(id: string): Promise<{ workspaceId: string | null; cwd: string } | null>;
}

/**
 * 这条会话的记忆作用域；null = 会话的 meta 读不到（新会话首轮可能还没落 meta、
 * 或会话已被删）。
 *
 * **读不到不是错误**：新会话第一轮的召回就落在这里——那一刻盘上本来就没有它的
 * 记忆，答「没有可注入的」与答「出错了」对调用方是同一结果（都不注入），
 * 但前者不会在每条新会话的首轮刷一条错误日志。
 */
async function scopeOfSession(sessions: SessionScopeReader, sessionId: string): Promise<string | null> {
  const meta = await sessions.readMeta(sessionId);
  if (meta === null) {
    console.warn("[memory] 读不到会话 meta，这一轮没有可注入/可追加的记忆", sessionId);
    return null;
  }
  return memoryScopeOf(meta);
}

/**
 * memoryRetrieveRequest：读该作用域的记忆 JSONL → 词法打分 → 回 memoryRetrieveResult。
 * 任何路径都回执（同 readTaskRequest）：不回答的话 agent 进程里的那次调用永远挂着，
 * 而轮前路径是同步等的，整轮开不了工。
 */
export async function applyMemoryRetrieve(
  sessions: SessionScopeReader,
  memory: MemoryStore,
  event: Extract<AgentEvent, { type: "memoryRetrieveRequest" }>,
): Promise<MemoryRetrieveOutcome> {
  // 开轮命令自带的 scope 优先（首轮 meta 还没落盘，meta 解析是必输的竞态）；
  // 缺席才退回 meta（旧调用方兼容）。
  const scope =
    event.scope !== undefined
      ? memoryScopeOf(event.scope)
      : await scopeOfSession(sessions, event.sessionId);
  if (scope === null) return { ok: true, hits: [] };
  return { ok: true, hits: retrieveMemories(await memory.list(scope), event.query) };
}

/**
 * memoryAppend：轮后蒸馏出的 draft 落进该会话作用域的 JSONL。**单向、无回执**
 * （契约同 title 事件）——调用方（index.ts 的接线）只负责把失败记进日志：
 * 记忆是易耗品，不该有报错通路打断对话。
 */
export async function applyMemoryAppend(
  sessions: SessionScopeReader,
  memory: MemoryStore,
  event: Extract<AgentEvent, { type: "memoryAppend" }>,
): Promise<void> {
  const scope = await scopeOfSession(sessions, event.sessionId);
  if (scope === null) return;
  await memory.append(scope, event.sessionId, event.entries);
}

/* ---------- 设置 › 记忆（memory:list / memory:remove）的入参校验 ---------- */

/**
 * 校验 renderer 传上来的作用域引用。**不信任地验**（files/ipc.ts 的同一条纪律）：
 * `MemoryScopeRef` 只是编译期的约定，IPC 那头是什么都可能——cwd 不是字符串、
 * workspaceId 是个数字，都会让 scopeId 变成一个莫名其妙的哈希键，进而在
 * userData 里凭空多出一个谁也看不懂的 memory 文件。当场抛，让 renderer 走统一的
 * catch（whitelistedPath 的同款处理）。
 */
export function parseMemoryScopeRef(raw: unknown): MemoryScopeRef {
  return scopeRefOf(asRequestObject(raw));
}

/**
 * memory:remove 的入参：作用域照上面校验，外加 entryId 必须是字符串。
 * **空串不在这里拦**——「删一个空 id」的答案是「什么都没删」（removed: false），
 * 那是 store 的幂等语义，交给它；这里只管类型。
 */
export function parseMemoryRemoveRequest(raw: unknown): MemoryRemoveRequest {
  const req = asRequestObject(raw);
  const entryId = req.entryId;
  if (typeof entryId !== "string") throw new Error("memory request needs a string entryId");
  return { ...scopeRefOf(req), entryId };
}

/** IPC 那头先是个什么都不能假设的东西；过这一道之后才谈得上逐字段验类型。 */
function asRequestObject(raw: unknown): RequestRecord {
  if (typeof raw !== "object" || raw === null) throw new Error("memory request must be an object");
  return raw as RequestRecord;
}

type RequestRecord = { workspaceId?: unknown; cwd?: unknown; entryId?: unknown };

function scopeRefOf(req: RequestRecord): MemoryScopeRef {
  if (typeof req.cwd !== "string") throw new Error("memory request needs a string cwd");
  // 缺席（undefined）按「没有工作区」收：null 与不传在这个面上是同一件事，
  // renderer 写 `?? null` 还是直接透传都不该让面板白屏
  const workspaceId = req.workspaceId ?? null;
  if (workspaceId !== null && typeof workspaceId !== "string") {
    throw new Error("memory request workspaceId must be a string or null");
  }
  return { workspaceId, cwd: req.cwd };
}
