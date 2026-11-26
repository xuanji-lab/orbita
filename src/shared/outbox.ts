/**
 * 发件箱（四层契约第 1 层）：点了发送的那句话**先落盘再开跑**。
 *
 * 2026-11-24 用户：「点发送后先落盘再开跑；主进程或 agent 进程重启时，没发出去的话不能静默消失，要在界面上说没发出去并保留在输入框。」
 * 一句话发出去之前写一条进 `<userData>/outbox.json`；它在对话里落了账（用户条目回显）就删掉。
 * 下次启动（或 renderer 重载）时还留着的：去会话里核对它落没落账，没落的放回它出发的那个输入框并说一声没发出去。
 * 只存文字（图片、文件引用不进发件箱：它们本来就在各自的落盘副本里，丢了的是那句话）。
 */
export interface OutboxEntry {
  /** 这次发送的 id（renderer 生成） */
  id: string;
  /** 发往哪条会话（首页首条消息 = 新会话的 id，盘上可能还没有它的 meta） */
  sessionId: string;
  /** 出发的输入框草稿键（放回时写回这里） */
  draftKey: string;
  text: string;
  /** 点发送的时刻（ms）：核对「落没落账」用——会话里有不早于它的用户消息就算落了 */
  at: number;
}

export const OUTBOX_MAX = 50;

export function isOutboxEntry(raw: unknown): raw is OutboxEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    v["id"] !== "" &&
    typeof v["sessionId"] === "string" &&
    v["sessionId"] !== "" &&
    typeof v["draftKey"] === "string" &&
    typeof v["text"] === "string" &&
    typeof v["at"] === "number" &&
    Number.isFinite(v["at"])
  );
}

/** 盘上读回的内容 → 合法条目（坏行丢掉，超出上限只留最新的） */
export function parseOutbox(raw: unknown): OutboxEntry[] {
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
  return list.filter(isOutboxEntry).sort((a, b) => a.at - b.at).slice(-OUTBOX_MAX);
}

/**
 * 启动核对：这条落没落账。会话里有一条不早于它（容 2 秒时钟误差）、正文以它开头的用户消息就算落了。
 * 正文比较只看开头：主进程会在用户原文前面拼指令块、引用会展开——所以用「包含」而不是全等。
 */
export function outboxLanded(entry: Pick<OutboxEntry, "text" | "at">, records: readonly { role: string; timestamp: number; text: string }[]): boolean {
  const head = entry.text.trim().slice(0, 80);
  return records.some((record) => record.role === "user" && record.timestamp >= entry.at - 2000 && (head === "" || record.text.includes(head)));
}
