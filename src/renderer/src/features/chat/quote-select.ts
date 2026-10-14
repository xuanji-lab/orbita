/**
 * 划选 → 引用，与点 chip → 找回原文的纯逻辑。DOM 那一侧（选区、滚动、高亮）在
 * ChatView 的 QuoteSelectionLayer / jumpToQuote 里，这里只做能测的判断。
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import {
  clampQuote,
  normalizeSelectedText,
  parseQuotedMessage,
  type QuoteRole,
  type TextQuote,
} from "../../../../shared/quote.ts";

/**
 * 一段划选能不能成为引用、成为什么样的引用。null = 不能：
 * - 消息不在转录里（选中的是别的东西）；
 * - 助手消息还在流式生成——文字还在变，引出去的可能是半句话（Proma 同一条规矩）；
 * - 规整后是空的。
 *
 * 轮号按用户消息计（1 起）：用户消息是它自己那一轮，助手回复属于它前面那条用户消息的轮。
 */
export function quoteFromSelection(
  transcript: readonly TranscriptItem[],
  messageId: string,
  role: QuoteRole,
  selected: string,
): TextQuote | null {
  const index = transcript.findIndex((item) => item.id === messageId);
  const item = transcript[index];
  if (item === undefined || item.role !== role) return null;
  if (item.role === "assistant" && item.status === "streaming") return null;
  const normalized = normalizeSelectedText(selected);
  if (normalized === "") return null;
  const { text, truncated } = clampQuote(normalized);
  const turn = transcript.slice(0, index + 1).filter((entry) => entry.role === "user").length;
  return {
    text,
    messageId,
    role,
    ...(turn > 0 ? { turn } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** 文本节点里的一个位置：第几个节点、节点内第几个字符 */
export interface TextPoint {
  node: number;
  offset: number;
}

/**
 * 在一串文本节点里找引用原文的起止位置，**忽略空白差异**：划选出来的文本经过规整
 * （块元素之间的换行、缩进被收掉），和 DOM 里的原样对不上逐字匹配；按非空白字符
 * 比就稳了。找不到返回 null——调用方退回整块闪一下。
 *
 * skip：比对时跳过的单字符（缺省只跳空白）。确认卡的摘句高亮传更宽的集合，与
 * intent-lab 定位摘句的口径一致（见 conv-window.ts 的 EXCERPT_SKIP）。
 */
export function locateQuote(
  segments: readonly string[],
  quote: string,
  skip: RegExp = /\s/,
): { start: TextPoint; end: TextPoint } | null {
  const needle = [...quote].filter((char) => !skip.test(char)).join("");
  if (needle === "") return null;
  const points: TextPoint[] = [];
  let hay = "";
  segments.forEach((segment, node) => {
    for (let offset = 0; offset < segment.length; offset += 1) {
      const char = segment[offset] as string;
      if (skip.test(char)) continue;
      hay += char;
      points.push({ node, offset });
    }
  });
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const first = points[at] as TextPoint;
  const last = points[at + needle.length - 1] as TextPoint;
  return { start: first, end: { node: last.node, offset: last.offset + 1 } };
}

/**
 * 引用出自转录里的哪条消息。发出去的引用不带 id（模型用不上，不进正文），靠
 * 「谁说的 + 第几轮 + 原文」找回来：
 * - 输入框里的引用还带着划选时的 id，在转录里就直接用；
 * - 否则在同一轮、同一角色的消息里找包含这段原文的（按非空白字符比，同 locateQuote）；
 *   用户消息只比用户自己的话——它自己也可能带着引用块，别把引用的引用当出处；
 * - 找不到（迁移来的引用、被压缩掉的历史）返回 null，chip 不画成可点。
 */
export function findQuoteSource(transcript: readonly TranscriptItem[], quote: TextQuote): string | null {
  if (quote.messageId !== "" && transcript.some((item) => item.id === quote.messageId)) return quote.messageId;
  if (quote.filePath !== undefined) return null;
  const needle = quote.text.replace(/\s+/g, "");
  if (needle === "") return null;
  let turn = 0;
  for (const item of transcript) {
    if (item.role === "user") turn += 1;
    if (item.role !== quote.role) continue;
    if (quote.turn !== undefined && turn !== quote.turn) continue;
    const raw = item.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const own = item.role === "user" ? parseQuotedMessage(raw).text : raw;
    if (own.replace(/\s+/g, "").includes(needle)) return item.id;
  }
  return null;
}
