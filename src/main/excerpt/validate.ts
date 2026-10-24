/**
 * 摘抄 IPC 的入参校验 —— renderer 传来的都当不可信数据（四层契约第 2 层的入口）。
 * 过不了的返回 null，handler 抛错（renderer 侧 invoke 变 rejected promise）。
 * **纯模块**：不 import electron，可被 `node --test` 直接加载。
 */
import type { ExcerptAddRequest, ExcerptRemoveRequest } from "../../shared/excerpt.ts";

/** turn：正整数（按用户消息计，1 起）；迁移来的旧消息可能没有。 */
function isTurn(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function parseExcerptAddRequest(raw: unknown): ExcerptAddRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record["sessionId"] !== "string" || record["sessionId"] === "") return null;
  // 纯空白也算空：摘一段空白没有意义，且存储侧 trim 后为空会抛
  if (typeof record["text"] !== "string" || record["text"].trim() === "") return null;
  if (record["role"] !== "user" && record["role"] !== "assistant") return null;
  const turn = record["turn"];
  if (turn !== undefined && !isTurn(turn)) return null;
  return {
    sessionId: record["sessionId"],
    ...(turn !== undefined ? { turn } : {}),
    role: record["role"],
    text: record["text"],
  };
}

export function parseExcerptRemoveRequest(raw: unknown): ExcerptRemoveRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["id"];
  // 不限定 `exc_` 前缀：不像通道的路径拼接有穿越风险，这里的 id 只是查键，
  // 查不到自然 removed = false——「当作已删」本就是界面的预期分支
  if (typeof id !== "string" || id === "") return null;
  return { id };
}
