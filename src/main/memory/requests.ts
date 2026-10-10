/**
 * memoryRetrieveRequest / memoryAppend 在主进程的落点——**与 readTaskRequest 同一条边界**：
 * agent 进程不碰 userData，作用域（workspaceId ?? cwd）由主进程按会话归属解析，
 * 读写在主进程。纯核在 store / retrieve，这里只剩「解析作用域 → 调 store」一跳
 * （read-task.ts 同款分层：可测的判断不进 IPC 胶水）。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { MemoryRetrieveOutcome } from "../../shared/memory.ts";
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
  const scope = await scopeOfSession(sessions, event.sessionId);
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
