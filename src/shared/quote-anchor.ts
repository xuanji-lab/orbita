/**
 * 文档引用的「以原文为锚」重新定位（纯函数）。
 *
 * 划选那一刻记下的行号会过期：用户在引用之后又改了文档、agent 在中间写了几段，行号就指到别处——
 * 尤其是同一句话在文件里出现两次时，旧行号正好指到新复制出来的那一句，agent 就改错位置
 * （2026-11-07 独立验收的「重复句」场景）。所以引用以**原文 + 上下文**为锚，发送时按当前文档现算：
 * - 原文只出现一次 → 用它现在的行号；
 * - 出现多次 → 只认「前后各 20 字与划选时完全一致」的那一处；认不出就不猜，标 ambiguous；
 * - 一次都找不到 → 标 missing，发给模型时说「原文已不在文件里」，不让它凭行号去改别处。
 */
import { parseDeck } from "./doc-slides.ts";
import type { TextQuote } from "./quote.ts";

/** 上下文长度（字符，不是码点：只用来比相似度，切开一个代理对无碍） */
export const QUOTE_CONTEXT_CHARS = 20;
/** 同一段原文最多比对多少处出现（防病态文档） */
const MAX_OCCURRENCES = 500;

export function contextAround(text: string, from: number, to: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, from - QUOTE_CONTEXT_CHARS), from),
    after: text.slice(to, to + QUOTE_CONTEXT_CHARS),
  };
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

/** 原文在 `text` 里的所有出现位置（起点偏移） */
export function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  for (let at = text.indexOf(needle); at !== -1 && found.length < MAX_OCCURRENCES; at = text.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

/**
 * 这一处的前后文与划选时记的**完全一致**（划选时的前 20 字、后 20 字原样还在）——说明它周围一个字没动，
 * 才敢认它是用户划选的那一处。只比相似度不行：「紧贴着复制出一模一样的一句」时，复制出来的那句前文和
 * 原句划选时的前文一模一样，相似度反而更高（第二次独立验收 m3f / m3g 就是这么改错的）。
 */
function sameSurroundings(text: string, quote: TextQuote, index: number): boolean {
  if (quote.context === undefined) return false;
  const around = contextAround(text, index, index + quote.text.length);
  return around.before === quote.context.before && around.after === quote.context.after;
}

/** 引用原文就在 `index` 处：算出现在的行号（演示文稿还有页号），清掉 missing */
export function quoteAt(text: string, quote: TextQuote, index: number): TextQuote {
  const { missing: _missing, ambiguous: _ambiguous, ...rest } = quote;
  const end = index + quote.text.length;
  const lastChar = end > index && text[end - 1] === "\n" ? end - 1 : end;
  const from = lineOf(text, index);
  const to = Math.max(from, lineOf(text, lastChar));
  const next: TextQuote = { ...rest, lines: { from, to } };
  delete next.occurrence;
  const all = occurrences(text, quote.text);
  if (all.length > 1) {
    next.occurrence = { index: all.indexOf(index) + 1 || 1, of: all.length };
    // 此刻这一处前后的字（不是划选时的）：模型拿它们拼 oldText
    next.context = contextAround(text, index, end);
  }
  if (quote.slide !== undefined) {
    const page = parseDeck(text).pages.find((candidate) => index >= candidate.from && index <= candidate.to);
    if (page !== undefined) next.slide = page.index + 1;
  }
  return next;
}

/**
 * 按文件当前内容重新定位一条文件引用（没有可靠的位置追踪时的兜底）。非文件引用原样返回。
 * - 原文只出现一次：用它现在的行号；
 * - 出现多次：只有恰好一处「前后文与划选时完全一致」才认它；否则**不猜**，标 ambiguous
 *   （划选时的行号 + 现在每一处的行号），模型被告知不改、先问用户是哪一处；
 * - 一次都找不到：标 missing，lines 原样留着（只是提示）。
 */
export function relocateQuote(text: string, quote: TextQuote): TextQuote {
  if (quote.filePath === undefined || quote.text === "") return quote;
  const found = occurrences(text, quote.text);
  const { missing: _missing, ambiguous: _ambiguous, ...rest } = quote;
  if (found.length === 0) return { ...rest, missing: true };
  if (found.length === 1) return quoteAt(text, quote, found[0] as number);
  const sure = found.filter((index) => sameSurroundings(text, quote, index));
  if (sure.length === 1) return quoteAt(text, quote, sure[0] as number);
  return {
    ...rest,
    ambiguous: { was: quote.lines?.from ?? 0, at: found.map((index) => lineOf(text, index)) },
  };
}

/**
 * 发送前把指向某份文件的引用换成它在 `text`（文件此刻的全文）里的位置。
 * 优先用编辑器追踪的区间（`tracked(anchor)`，准确，分得清「恰好复制在原句上方」的重复句）；
 * 追踪不到、或区间里的字被改过，退回「原文 + 上下文」定位；都找不到标 missing。
 */
export function resolveDocQuotes(
  text: string,
  path: string,
  tracked: (anchor: string) => { from: number; to: number } | null,
  quotes: readonly TextQuote[],
): TextQuote[] {
  return quotes.map((quote) => {
    if (quote.filePath !== path) return quote;
    const range = quote.anchor === undefined ? null : tracked(quote.anchor);
    if (range !== null && range.to > range.from && quote.text !== "") {
      const at = text.slice(range.from, range.to).indexOf(quote.text);
      if (at !== -1) return quoteAt(text, quote, range.from + at);
    }
    return relocateQuote(text, quote);
  });
}
