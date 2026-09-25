/**
 * 引用 chip 上的文案。口径照 Proma（`buildQuotedSelectionLabel` / `ChipMeta`）：
 * 字数按码点计、短摘要取前 20 个字并如实加省略号——只露一截又不标省略，
 * 用户没法判断引用是不是完整带上了。
 */
import { countChars, type TextQuote } from "../../../shared/quote.ts";
import type { Messages } from "../messages-en.ts";

const SUMMARY_CHARS = 20;

/** 来源：文件取文件名；历史消息是「第 N 轮 · 谁说的」（迁移来的旧块可能没有轮号） */
export function quoteSource(quote: TextQuote, t: Messages): string {
  if (quote.filePath !== undefined) return quote.filePath.split(/[\\/]/).pop() || quote.filePath;
  const who = quote.role === "user" ? t.quote.userMessage : t.quote.agentReply;
  return quote.turn === undefined ? who : `${t.quote.turn(quote.turn)} · ${who}`;
}

/** 展开态的 meta 行：来源 · 字数（截过的标出来） */
export function quoteMeta(quote: TextQuote, t: Messages): string {
  const size = quote.truncated === true ? t.quote.truncated(countChars(quote.text)) : t.quote.chars(countChars(quote.text));
  return `${quoteSource(quote, t)} · ${size}`;
}

/** 收起态的正文：前 20 字，超出才加省略号，空白压成一格（meta 由 chip 排在它前面） */
export function quotePreview(quote: TextQuote): string {
  const flat = Array.from(quote.text.replace(/\s+/g, " ").trim());
  return flat.slice(0, SUMMARY_CHARS).join("") + (flat.length > SUMMARY_CHARS ? "…" : "");
}
