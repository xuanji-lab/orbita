/**
 * 记忆库 IPC 的入参校验 —— renderer 过来的都是不可信数据（files/list.ts 的同款
 * 先例：判断放纯模块里才能被 `node --test` 直接测）。形状不对当场抛，handler 把
 * 错误原样给 renderer。
 */
import type { MemoryEntriesRequest, MemoryEntryType, MemoryMutation } from "../../shared/memory.ts";

/** token 只认两种形状：user 保留字或 40 位 hex（sha1）。别让它拼出奇怪的路。 */
export function parseScopeToken(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("memory request needs a string token");
  if (raw === "user" || /^[0-9a-f]{40}$/.test(raw)) return raw;
  throw new Error("memory token must be \"user\" or 40-hex");
}

function parseText(raw: unknown, field: string, maxChars: number): string {
  if (typeof raw !== "string") throw new Error(`memory request needs a string ${field}`);
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error(`memory ${field} must not be empty`);
  if (trimmed.length > maxChars) throw new Error(`memory ${field} too long (>${maxChars} chars)`);
  return trimmed;
}

function parseEntryId(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") throw new Error("memory request needs a string entryId");
  return raw;
}

function parseType(raw: unknown): MemoryEntryType {
  if (raw !== "fact" && raw !== "preference" && raw !== "insight") {
    throw new Error("memory type must be fact | preference | insight");
  }
  return raw;
}

export function parseEntriesRequest(raw: unknown): MemoryEntriesRequest {
  if (typeof raw !== "object" || raw === null) throw new Error("memory request must be an object");
  const suspect = raw as { token?: unknown; type?: unknown };
  return {
    token: suspect.token === "all" ? "all" : parseScopeToken(suspect.token),
    ...(suspect.type !== undefined ? { type: parseType(suspect.type) } : {}),
  };
}

export function parseSessionId(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") throw new Error("memory request needs a string sessionId");
  return raw;
}

/**
 * 六种写操作的逐 op 校验（形状层；业务不变量——偏好 / 经验必须带 reason、正文
 * 非空——在记忆服务侧兑底，主进程只拦明显坏形状）。addManual 的 scopeId 可选：
 * 主进程能从工作区表解出来就带（handler 那层填），解不出省略。
 */
export function parseMutation(raw: unknown): MemoryMutation {
  if (typeof raw !== "object" || raw === null) throw new Error("memory mutation must be an object");
  const suspect = raw as Record<string, unknown>;
  const op = suspect.op;
  switch (op) {
    case "edit":
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
        text: parseText(suspect.text, "text", 2000),
      };
    case "remove":
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
      };
    case "setStatus": {
      if (suspect.status !== "active" && suspect.status !== "muted") {
        throw new Error("memory status must be active | muted（stale 只由新说法顶掉旧说法产生）");
      }
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
        status: suspect.status,
      };
    }
    case "addManual": {
      const type = parseType(suspect.type);
      return {
        op,
        token: parseScopeToken(suspect.token),
        type,
        text: parseText(suspect.text, "text", 2000),
        ...(suspect.reason !== undefined ? { reason: parseText(suspect.reason, "reason", 1000) } : {}),
        ...(suspect.scopeId !== undefined && typeof suspect.scopeId === "string"
          ? { scopeId: suspect.scopeId }
          : {}),
      };
    }
    case "restorePrevious":
    case "returnToWorkspace":
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
      };
    default:
      throw new Error(`unknown memory mutation op: ${String(op)}`);
  }
}

/** 作用域 id（工作区 id 或 cwd 路径）：只当查表的键用，不拼路径；限长防滥用。 */
function parseScopeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("memory history request needs scopeIds: string[]");
  if (raw.length > 500) throw new Error("memory history scopeIds too many (>500)");
  return raw.map((item) => {
    if (typeof item !== "string" || item === "" || item.length > 4096) {
      throw new Error("memory history scopeIds must be non-empty strings");
    }
    return item;
  });
}

/** 从历史生成的预估 / 开始：{ scopeIds: string[] } */
export function parseHistoryScopes(raw: unknown): { scopeIds: string[] } {
  if (typeof raw !== "object" || raw === null) throw new Error("memory history request must be an object");
  return { scopeIds: parseScopeIds((raw as { scopeIds?: unknown }).scopeIds) };
}

/** 从历史生成的暂停 / 继续 / 停止 */
export function parseHistoryControl(raw: unknown): { action: "pause" | "resume" | "stop" } {
  const action = typeof raw === "object" && raw !== null ? (raw as { action?: unknown }).action : undefined;
  if (action !== "pause" && action !== "resume" && action !== "stop") {
    throw new Error("memory history action must be pause | resume | stop");
  }
  return { action };
}
