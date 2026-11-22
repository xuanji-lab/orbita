/**
 * 回复语言锚点的 agent 侧：从一串模型消息里算出「当前该用哪种语言」。
 * 语言识别本身（detectReplyLang）与标记文本（replyLanguageNote）在 shared/reply-language.ts，
 * 为什么要这个锚点见那里的文件头。
 *
 * 纯模块：不 import electron，可被 `node --test` 直接加载。
 */
import { parseChannelPrompt } from "../shared/channel.ts";
import { stripInvocationBlock } from "../shared/invocation.ts";
import { splitUserTextBlocks } from "../shared/prompt-attachments.ts";
import { withoutQuotes } from "../shared/quote.ts";
import { detectReplyLang, type ReplyLang } from "../shared/reply-language.ts";
import { isClosingScanText } from "../shared/legacy-closing-scan.ts";
import type { ContextMessage } from "./image-byte-budget.ts";

/** Orbita 自己加在用户消息上的成对标签：先整块抹掉，再按各自的规则剥附件 / 指令 / 引用 */
const WRAPPER_BLOCK = /<(user_context|orbita-memory|reply_language|referenced_task|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g;
const WRAPPER_SELF_CLOSING = /<(?:referenced_task|reply_language)\b[^>]*\/>/g;

/**
 * 一条用户消息的文本块 → 用户亲手打的字的语言。
 *
 * 「用户的字」= 去掉 Orbita 包装之后的正文（与 deriveSessionTitle 同一套剥法：
 * `<mentioned_tools>` 指令块 / `<quoted_context>` 与 `<open_document>` / `<attached-files>` 与
 * `<pasted-text>` 块 / 记忆、情境、任务引用等包装）。正文里没有能判的字（只发附件）时，
 * 退到粘贴文本——那是用户亲手贴的文字。通道信封、收尾扫描的机器提问不是用户的字：返回 null。
 */
export function userTypedLang(blocks: readonly string[]): ReplyLang | null {
  const text = blocks.join("\n\n");
  if (parseChannelPrompt(text) !== null || isClosingScanText(text)) return null;
  const cleaned = blocks.map((block) => block.replace(WRAPPER_BLOCK, "").replace(WRAPPER_SELF_CLOSING, ""));
  const { body, pasted } = splitUserTextBlocks(cleaned.filter((block) => block.trim() !== ""));
  const typed = withoutQuotes(stripInvocationBlock(body.trimStart())).replace(/<!--[\s\S]*?-->/g, " ");
  return detectReplyLang(typed) ?? detectReplyLang(pasted.join("\n\n"));
}

/** 一条消息的文本块（字符串正文算一块；非文本块跳过） */
export function textBlocksOf(message: ContextMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") out.push(record.text);
  }
  return out;
}

/**
 * 逐条算「这条用户消息发出时，用户的语言是什么」（下标与 messages 对齐；非用户消息为 null）。
 *
 * **只看这条及之前的消息**（因果）：同一份历史每轮重放结果逐字节相同，才不破前缀缓存。
 * 语言来源取最近的一个：
 * - 用户亲手打的字（userTypedLang）；
 * - 父会话经通道送来的信封里的 `lang` 属性（父会话那边按用户亲手打的字算好的）——
 *   子会话收到的全是信封，靠它才有「用户的语言」。信封**正文**不参与判断：
 *   正文是父模型写的，父模型漂成英文时子会话不该跟着漂。
 * 都还没有就是 null（调用方不附标记，规则段回到「跟随用户的字」）。
 */
export function replyLangsOf(messages: readonly ContextMessage[]): (ReplyLang | null)[] {
  const out: (ReplyLang | null)[] = [];
  let current: ReplyLang | null = null;
  for (const message of messages) {
    if ((message as { role?: unknown }).role !== "user") {
      out.push(null);
      continue;
    }
    const blocks = textBlocksOf(message);
    const envelope = blocks.length === 0 ? null : parseChannelPrompt(blocks.join("\n\n"));
    const seen = envelope !== null ? (envelope.from === "parent" ? (envelope.lang ?? null) : null) : userTypedLang(blocks);
    if (seen !== null) current = seen;
    out.push(current);
  }
  return out;
}

/** 此刻（最后一条用户消息之后）用户的语言；派发 / 回信时写进通道消息 */
export function currentReplyLang(messages: readonly ContextMessage[]): ReplyLang | undefined {
  return replyLangsOf(messages).reduce<ReplyLang | undefined>((last, lang) => lang ?? last, undefined);
}
