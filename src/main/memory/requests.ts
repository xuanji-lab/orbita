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
 * 八种写操作的逐 op 校验（形状层；业务不变量——偏好 / 经验必须带 reason、正文
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
        throw new Error("memory status must be active | muted（stale 只能由冲突拍板产生）");
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
    case "decidePromote": {
      if (suspect.decision !== "user" && suspect.decision !== "workspace") {
        throw new Error("memory promote decision must be user | workspace");
      }
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
        decision: suspect.decision,
      };
    }
    case "undoPromote":
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
      };
    case "decideConflict": {
      if (suspect.decision !== "stale-old" && suspect.decision !== "keep-both") {
        throw new Error("memory conflict decision must be stale-old | keep-both");
      }
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
        decision: suspect.decision,
      };
    }
    case "undoConflict":
      return {
        op,
        token: parseScopeToken(suspect.token),
        entryId: parseEntryId(suspect.entryId),
      };
    default:
      throw new Error(`unknown memory mutation op: ${String(op)}`);
  }
}
