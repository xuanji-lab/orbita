/**
 * 文档里划选一段 → 一条文件引用（`TextQuote` 的 filePath / lines / slide）。纯函数。
 *
 * 引用正文是**源码里的原文**（含 `**`、`#` 这些符号，不去掉）：agent 用 edit 工具改的时候
 * 要在文件里逐字匹配这段；行号告诉它这段在文件的第几行到第几行——同一句话在文件里出现两次时
 * 不靠运气。长度沿用 QUOTE_MAX_CHARS（再长就不是「引一句」）。
 */
import { clampQuote, type TextQuote } from "../../../../shared/quote.ts";
import { parseDeck } from "../../../../shared/doc-slides.ts";

/** 偏移 → 行号（1 起）。偏移越界按文首 / 文末夹 */
export function lineOf(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

/** 选区 [from, to) 覆盖的行号范围（含两端）。选区终点恰在下一行行首时，那一行不算 */
export function lineRangeOf(text: string, from: number, to: number): { from: number; to: number } {
  const start = lineOf(text, from);
  const endOffset = to > from && text[to - 1] === "\n" ? to - 1 : to;
  return { from: start, to: Math.max(start, lineOf(text, endOffset)) };
}

/** 在文档里划选 → 引用。选区为空（或只有空白）返回 null */
export function quoteOfSelection(input: {
  path: string;
  /** 整份文件文本 */
  text: string;
  from: number;
  to: number;
}): TextQuote | null {
  const raw = input.text.slice(input.from, input.to);
  if (raw.trim() === "") return null;
  const clamped = clampQuote(raw.replace(/^\n+|\s+$/g, ""));
  return {
    text: clamped.text,
    messageId: "",
    role: "user",
    filePath: input.path,
    lines: lineRangeOf(input.text, input.from, input.to),
    ...(clamped.truncated ? { truncated: true as const } : {}),
  };
}

/** 演示文稿里「引用这一页」：整页文字，带页号（1 起）与这一页在文件里的行号范围 */
export function quoteOfSlide(input: { path: string; text: string; page: number }): TextQuote | null {
  const page = parseDeck(input.text).pages[input.page];
  if (page === undefined) return null;
  const clamped = clampQuote(page.text);
  return {
    // 空白页也能引（用户说「这页写三列对比」）：正文留一个占位，让芯片有东西显示
    text: clamped.text === "" ? "" : clamped.text,
    messageId: "",
    role: "user",
    filePath: input.path,
    lines: { from: page.startLine, to: page.endLine },
    slide: input.page + 1,
    ...(clamped.truncated ? { truncated: true as const } : {}),
  };
}

/**
 * 页内编辑器里的划选（偏移按那一页的文字算）→ 引用，行号与页号仍按整份文件。
 * `regionFrom` 是该编辑器那段文字在整份文件里的起点。
 */
export function quoteOfPageSelection(input: {
  path: string;
  fullText: string;
  regionFrom: number;
  from: number;
  to: number;
  page: number;
}): TextQuote | null {
  const quote = quoteOfSelection({
    path: input.path,
    text: input.fullText,
    from: input.regionFrom + input.from,
    to: input.regionFrom + input.to,
  });
  return quote === null ? null : { ...quote, slide: input.page + 1 };
}
