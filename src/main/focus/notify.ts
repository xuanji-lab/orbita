/**
 * `focus:notify-done` 入参的净化 —— 纯函数（`node --test` 直接测；ipc.ts 里有
 * electron，测不了）。
 *
 * 不校验就把 renderer 传来的对象交给 `new Notification`：非对象会让 Electron 抛，
 * 空标题 / 空正文发出去是一条看不见的通知。这里只放行「去掉首尾空白后非空的
 * 字符串」，超长按字数截断（不丢通知），其余一律拒绝（ipc 直接 return）。
 */
import type { FocusNotifyRequest } from "../../shared/focus.ts";

/** 标题：120 字（系统通知的标题本来就只露一行） */
export const NOTIFY_TITLE_MAX = 120;
/** 正文：300 字（多了也看不完，按字数截断） */
export const NOTIFY_BODY_MAX = 300;

/** 按字符（不是 UTF-16 码元）截断，避免切开 emoji 的代理对 */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function field(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  return clipChars(text, max);
}

/**
 * 合法 → 净化后的请求；不合法 → null（调用方直接 return，不发通知）。
 * 只认 title / body 两个字段，其余字段忽略（不进 Notification）。
 */
export function normalizeFocusNotify(raw: unknown): FocusNotifyRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const title = field((raw as { title?: unknown }).title, NOTIFY_TITLE_MAX);
  const body = field((raw as { body?: unknown }).body, NOTIFY_BODY_MAX);
  if (title === null || body === null) return null;
  return { title, body };
}
