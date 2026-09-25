/**
 * 文字引用：用户在历史消息里划选一段，作为这条消息的上下文一起发给模型。
 *
 * **载体就是消息正文**：发送时引用展开成 `<quoted_context>` 块拼在用户文字前面，
 * 转录与 pi 的本子里存的都是这一整段文本；显示时再解析回 chip。不另开字段——
 * pi 的 `prompt(text)` 只收一段文字，两本账必须是同一段话，按位对账（分支）才站得住。
 *
 * **格式与 Proma 一致**（`quoted-selection.ts` 的 `buildQuotedSelectionBlock`）：
 * 从 Proma 迁移过来的会话里已经有这种块，照同一格式解析就能直接画成 chip；
 * Proma 的 `<quoted_file>`（文件预览选区）也认，只是我们自己不产。
 *
 * 放 shared 是因为两边都要认它：renderer 组消息与画 chip，主进程取标题 /
 * 最近提问时要先剥掉引用——否则侧栏标题会是一行 `<quoted_context …>`。
 */

/** 被引用的消息是谁说的。Proma 还有 system，我们的转录里没有可划选的 system 消息 */
export type QuoteRole = "user" | "assistant";

export interface TextQuote {
  /** 引用正文（已规整空白、已截到上限） */
  text: string;
  /** 来源消息的转录 id。点 chip 跳回原文靠它；迁移来的 Proma 引用 id 在本转录里找不到，就不可跳 */
  messageId: string;
  role: QuoteRole;
  /** 第几轮（按用户消息计，1 起）。迁移来的旧块可能没有 */
  turn?: number;
  /** 来源是文件（Proma 的 `<quoted_file>`）时的路径；我们自己产的引用没有 */
  filePath?: string;
  /**
   * 划选超过上限被截过。**只活在输入框里**（chip 要如实标出「只引了前 N 字」），
   * 不进正文——发出去之后它就是一段 2000 字的引用，模型不需要知道原文更长。
   */
  truncated?: true;
}

/** 一段引用的上限（码点）。Proma 同值：再长就不是「引一句」，是贴全文了 */
export const QUOTE_MAX_CHARS = 2000;

/** 按码点计数（汉字 / 字母 / emoji 各算 1），与用户对「字数」的直觉一致——chip 上的字数就是它 */
export function countChars(text: string): number {
  return Array.from(text).length;
}

/** 截到上限。返回是否截过——chip 要如实标出「只引了前 N 字」 */
export function clampQuote(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= QUOTE_MAX_CHARS) return { text, truncated: false };
  return { text: chars.slice(0, QUOTE_MAX_CHARS).join(""), truncated: true };
}

/** 划选出来的文本规整：行首尾的空白收掉（块元素之间的换行会带出缩进），整体去首尾空白 */
export function normalizeSelectedText(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/** 引用正文里出现闭合标签会提前截断整块——改写掉（同 Proma 的 sanitizeQuotedText） */
function sanitizeBody(text: string): string {
  return text.replace(/<\/quoted_context>/gi, "</quoted_context_>").replace(/<\/quoted_file>/gi, "</quoted_file_>");
}

/** 标签给模型看的来源说明（Proma 的 label 位） */
function roleLabel(role: QuoteRole): string {
  return role === "user" ? "Agent history · user message" : "Agent history · agent reply";
}

function quoteBlock(quote: TextQuote): string {
  const turn = quote.turn !== undefined ? ` turn="${quote.turn}"` : "";
  return (
    `<quoted_context source="agent-history" label="${escapeAttribute(roleLabel(quote.role))}" ` +
    `message_id="${escapeAttribute(quote.messageId)}" role="${quote.role}"${turn}>\n` +
    `${sanitizeBody(quote.text)}\n</quoted_context>\n\n`
  );
}

/** 引用 + 用户文字 → 发给模型的整段正文。没有引用就是原文，一字不差 */
export function composeQuotedMessage(quotes: readonly TextQuote[], text: string): string {
  if (quotes.length === 0) return text;
  return `${quotes.map(quoteBlock).join("")}${text}`.trimEnd();
}

const BLOCK = /<(quoted_context|quoted_file)\b([^>]*)>\r?\n([\s\S]*?)\r?\n<\/\1>(?:\r?\n)*/g;

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1] === undefined ? undefined : decodeAttribute(match[1]);
}

/**
 * 整段正文 → 引用 + 用户自己的话。解析不出的块原样留在文字里（宁可显示一段标签，
 * 也不吞掉用户看不见的内容）。用户文字不含引用块时返回 `{ quotes: [], text }`，text 原样。
 */
export function parseQuotedMessage(message: string): { quotes: TextQuote[]; text: string } {
  if (!message.includes("<quoted_")) return { quotes: [], text: message };
  const quotes: TextQuote[] = [];
  const text = message.replace(BLOCK, (whole, tag: string, attrs: string, body: string) => {
    if (tag === "quoted_file") {
      const filePath = attribute(attrs, "path");
      if (filePath === undefined) return whole;
      quotes.push({ text: body, messageId: "", role: "user", filePath });
      return "";
    }
    const role = attribute(attrs, "role");
    const turn = Number(attribute(attrs, "turn"));
    quotes.push({
      text: body,
      messageId: attribute(attrs, "message_id") ?? "",
      role: role === "user" ? "user" : "assistant",
      ...(Number.isInteger(turn) && turn > 0 ? { turn } : {}),
    });
    return "";
  });
  return { quotes, text: text.trim() };
}

/** 只要用户自己说的那部分（标题、最近提问、复制键都要它） */
export function withoutQuotes(message: string): string {
  return parseQuotedMessage(message).text;
}
