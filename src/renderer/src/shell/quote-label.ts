/**
 * 引用 chip 上的文案。口径照 Proma（`buildQuotedSelectionLabel` / `ChipMeta`）：
 * 字数按码点计、短摘要取前 20 个字并如实加省略号——只露一截又不标省略，
 * 用户没法判断引用是不是完整带上了。
 */
import { countChars, type TextQuote } from "../../../shared/quote.ts";
import type { Messages } from "../messages-en.ts";

const SUMMARY_CHARS = 20;

/**
 * 引用卡收起态的安全上限：不预截（CSS 的 ellipsis 按真实宽度填满一行，
 * 2026-10 用户验收「正文省略太多」），但也不把几万字的引用整段交给一行 DOM——
 * 300 字之外仍截断加省略号；全文在 title 里照旧可达。
 */
export const QUOTE_ROW_PREVIEW_MAX_CHARS = 300;

/** 来源：文件取文件名；历史消息是「第 N 轮 · 谁说的」（迁移来的旧块可能没有轮号） */
export function quoteSource(quote: TextQuote, t: Messages): string {
  if (quote.filePath !== undefined) return quote.filePath.split(/[\\/]/).pop() || quote.filePath;
  const who = quote.role === "user" ? t.quote.userMessage : t.quote.agentReply;
  return quote.turn === undefined ? who : `${t.quote.turn(quote.turn)} · ${who}`;
}

/**
 * 引用卡一格的注脚，分三段返回：轮次（或文件名）、谁说的、字数。两列卡窄格里
 * CSS 先藏掉「谁说的」（留「第 1 轮 · 6 字」），更窄时回落一列再全显——分段
 * 只为给 CSS 藏，拼回整句就是 quoteMeta。
 */
export function quoteNoteParts(
  quote: TextQuote,
  t: Messages,
): { lead: string | null; who: string | null; size: string } {
  const size =
    quote.truncated === true ? t.quote.truncated(countChars(quote.text)) : t.quote.chars(countChars(quote.text));
  if (quote.filePath !== undefined) {
    return { lead: quote.filePath.split(/[\\/]/).pop() || quote.filePath, who: null, size };
  }
  const who = quote.role === "user" ? t.quote.userMessage : t.quote.agentReply;
  return { lead: quote.turn === undefined ? null : t.quote.turn(quote.turn), who, size };
}

/** 展开态的 meta 行：来源 · 字数（截过的标出来） */
export function quoteMeta(quote: TextQuote, t: Messages): string {
  return `${quoteSource(quote, t)} · ${quoteNoteParts(quote, t).size}`;
}

/** 收起态的正文：前 20 字，超出才加省略号，空白压成一格（meta 由 chip 排在它前面）。
 *  **只有收起态的 QuoteChip 等小口在用**——引用卡的整行不吃这个（那边要填满
 *  一行，走 quoteRowPreview） */
export function quotePreview(quote: TextQuote): string {
  const flat = Array.from(quote.text.replace(/\s+/g, " ").trim());
  return flat.slice(0, SUMMARY_CHARS).join("") + (flat.length > SUMMARY_CHARS ? "…" : "");
}

/**
 * 引用卡一行的正文：**不预截**——压平空白后整段交给 CSS 的 ellipsis 按真实宽度
 * 裁（2026-10 用户验收：先硬截 20 字再交给 CSS，一整行只显示一小段）。超过
 * QUOTE_ROW_PREVIEW_MAX_CHARS 才截断加省略号（防极端长引用的无谓渲染）；悬停
 * title 仍挂全文。
 */
export function quoteRowPreview(quote: TextQuote): string {
  const flat = Array.from(quote.text.replace(/\s+/g, " ").trim());
  return (
    flat.slice(0, QUOTE_ROW_PREVIEW_MAX_CHARS).join("") +
    (flat.length > QUOTE_ROW_PREVIEW_MAX_CHARS ? "…" : "")
  );
}
