/**
 * 划选 → 引用，与点 chip → 找回原文的纯逻辑。DOM 那一侧（选区、滚动、高亮）在
 * ChatView 的 QuoteSelectionLayer / jumpToQuote 里，这里只做能测的判断。
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { clampQuote, normalizeSelectedText, type QuoteRole, type TextQuote } from "../../../../shared/quote.ts";

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
 */
export function locateQuote(segments: readonly string[], quote: string): { start: TextPoint; end: TextPoint } | null {
  const needle = quote.replace(/\s+/g, "");
  if (needle === "") return null;
  const points: TextPoint[] = [];
  let hay = "";
  segments.forEach((segment, node) => {
    for (let offset = 0; offset < segment.length; offset += 1) {
      const char = segment[offset] as string;
      if (/\s/.test(char)) continue;
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
