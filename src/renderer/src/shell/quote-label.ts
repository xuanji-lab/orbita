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

/** 芯片里文件名的最长码点数；再长从中间省略（保头保尾：扩展名与结尾的版本号 / 日期比中段更能认出是哪份） */
export const QUOTE_FILE_NAME_MAX = 20;

/** 中间省略：`花园城市新加坡介绍的最终修订版.slides.json` → `花园城市新加坡介…s.json`；不超限原样 */
export function middleTruncate(name: string, max: number = QUOTE_FILE_NAME_MAX): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const tail = Math.min(7, Math.floor((max - 1) / 3));
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** 文件引用的出处拆成两段：文件名、位置（页号 / 行号 / 原文已改）。窄格里先省文件名、位置留着 */
function fileSourceParts(quote: TextQuote, t: Messages): { name: string; position: string } {
  const name = (quote.filePath ?? "").split(/[\\/]/).pop() || (quote.filePath ?? "");
  const parts: string[] = [];
  if (quote.slide !== undefined) parts.push(t.quote.slide(quote.slide));
  if (quote.missing === true) parts.push(t.quote.missing);
  else if (quote.ambiguous !== undefined) parts.push(t.quote.ambiguous);
  else if (quote.lines !== undefined) parts.push(t.quote.lines(quote.lines.from, quote.lines.to));
  return { name, position: parts.join(" · ") };
}

/** 文件引用的出处：文件名，演示文稿再加页号，有行号再加行号（`计划.md · 第 12–14 行`） */
function fileSource(quote: TextQuote, t: Messages): string {
  const { name, position } = fileSourceParts(quote, t);
  return position === "" ? name : `${name} · ${position}`;
}

/** 来源：文件取文件名；历史消息是「第 N 轮 · 谁说的」（迁移来的旧块可能没有轮号） */
export function quoteSource(quote: TextQuote, t: Messages): string {
  if (quote.filePath !== undefined) return fileSource(quote, t);
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
): { lead: string | null; who: string | null; size: string; file: string | null } {
  const size =
    quote.truncated === true ? t.quote.truncated(countChars(quote.text)) : t.quote.chars(countChars(quote.text));
  if (quote.filePath !== undefined) {
    const { name: fullName, position } = fileSourceParts(quote, t);
    // 芯片上文件名不被 CSS 挤成「新…」：太长就在这里从中间省略，其余宽度紧张时先让正文与字数让位
    const name = middleTruncate(fullName);
    // 有位置：位置是 lead，文件名单列（CSS 窄格里先省文件名）；没有位置就和从前一样，文件名当 lead
    return position === "" ? { lead: name, who: null, size, file: null } : { lead: position, who: null, size, file: name };
  }
  const who = quote.role === "user" ? t.quote.userMessage : t.quote.agentReply;
  return { lead: quote.turn === undefined ? null : t.quote.turn(quote.turn), who, size, file: null };
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
