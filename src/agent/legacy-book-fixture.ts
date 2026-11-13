/** 测试夹具：手拼 pi 本子（v3 JSONL）。只给 legacy-migrate / kernel 的测试用。 */
/** 拼一份 v3 本子：header + 按给定顺序的 entry（parentId 默认接上一条） */
export function book(entries: Record<string, unknown>[], header: Record<string, unknown> = {}): string {
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w", ...header })];
  let previous: string | null = null;
  for (const entry of entries) {
    const line: Record<string, unknown> = { parentId: previous, timestamp: "2026-01-01T00:00:01.000Z", ...entry };
    lines.push(JSON.stringify(line));
    previous = line["id"] as string;
  }
  return `${lines.join("\n")}\n`;
}

export const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function user(id: string, text: string): Record<string, unknown> {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } };
}
export function assistant(id: string, text: string, calls: string[] = [], stopReason?: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", id: call, name: "read", arguments: { path: call } }))],
      api: "anthropic-messages",
      provider: "p",
      model: "m",
      usage,
      stopReason: stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
      timestamp: 2,
    },
  };
}
export function result(id: string, call: string): Record<string, unknown> {
  return { type: "message", id, message: { role: "toolResult", toolCallId: call, toolName: "read", content: [{ type: "text", text: `file ${call}` }], isError: false, timestamp: 3 } };
}

