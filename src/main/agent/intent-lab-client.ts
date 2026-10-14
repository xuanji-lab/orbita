/**
 * intent-lab 的主进程客户端（探活 / 拉图 / 存档 / 作废）—— /recall 与 /feedback
 * 的客户端在 agent 进程（intent-recall-client.ts），这四个端点只有主进程用，各归各的进程。
 *
 * 纯模块（不 import electron；fetch 走全局——node --test 用真 http 服务盖）。
 */
import { parseIntentHealth, type IntentHealth } from "../../shared/intent-lab.ts";
import { parseIntentEdges, type IntentEdges } from "../../shared/intent-edges.ts";

/** GET /health：探活。连不上 / 非 200 / 形状坏 → null（探活语义：畸形等于不可用，不猜）。 */
export async function getIntentHealth(baseUrl: string): Promise<IntentHealth | null> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return parseIntentHealth(await response.json());
  } catch {
    return null;
  }
}

/** GET /edges?sessionId=&turnId=：某一问的图数据。连不上 / 非 200 / 畸形 → null（不画半张图）。 */
export async function getIntentEdges(
  baseUrl: string,
  sessionId: string,
  turnId: string,
): Promise<IntentEdges | null> {
  try {
    const query = `?sessionId=${encodeURIComponent(sessionId)}&turnId=${encodeURIComponent(turnId)}`;
    const response = await fetch(`${baseUrl}/edges${query}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return parseIntentEdges(await response.json());
  } catch {
    return null;
  }
}

/**
 * POST /ingest：本轮回答正常结束后存档 QA（q = 意图口径原话，a = 助手该轮最后一段
 * 文字）。失败抛给调用方（调用方只记日志，不影响界面——存档是养分，不是链路）。
 */
export async function postIntentIngest(baseUrl: string, row: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** POST /invalidate（契约 v6，会话回退成功后调）：把被回退轮次的 turnId 送去作废。幂等；
 *  连不上 / 服务端错 → { ok: false }（调用方只记日志，绝不动回退本身）。 */
export async function postIntentInvalidate(
  baseUrl: string,
  sessionId: string,
  turnIds: readonly string[],
): Promise<{ ok: true; invalidated: number } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/invalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, turnIds }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (cause) {
    console.error("[intent-lab] /invalidate 连不上", cause);
    return { ok: false, error: "intent-lab unreachable" };
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "unparseable reply" };
  }
  if (typeof body !== "object" || body === null) return { ok: false, error: "malformed reply" };
  const value = body as Record<string, unknown>;
  if (value["ok"] !== true || typeof value["invalidated"] !== "number") {
    return { ok: false, error: "malformed reply" };
  }
  return { ok: true, invalidated: value["invalidated"] };
}
