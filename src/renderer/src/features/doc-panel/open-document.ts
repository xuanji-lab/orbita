import type { OpenDocument, TextQuote } from "../../../../shared/quote.ts";
import { resolveDocQuotes } from "../../../../shared/quote-anchor.ts";
import { isDeckPath } from "../../../../shared/slides.ts";
import { loadTracked } from "./quote-track.ts";

/**
 * 右栏正开着编辑的那份文档（模块级一格）。编辑面板挂载时登记、卸载时清掉；发送消息时
 * `useChatSession.send` 读它，做两件事：
 * - 拼成正文开头的 `<open_document …/>`——模型因此知道「在第二段后面加一段」说的是哪份文件；
 * - 把输入框里指向这份文件的引用**按文档当前内容重新定位**（`resolveQuotes`）：划选时记的行号会过期，
 *   同一句话出现两次时旧行号会指到别处，改错位置。
 *
 * 为什么不是 context / props：写的一方（文件预览里的编辑面板）与读的一方（输入框的发送）
 * 隔着整棵 App，中间没有共同祖先该管这件事；它是「此刻用户眼前有什么」这种瞬时事实，
 * 不是任何组件的状态。
 */
export interface OpenDocumentSource {
  /** 文档此刻的全文（含未落盘的输入） */
  text(): string;
  /** 划选时登记的区间现在在哪（编辑器随改动映射）；追踪不到 = null */
  trackedRange(anchor: string): { from: number; to: number } | null;
}

let current: OpenDocument | null = null;
let source: OpenDocumentSource | null = null;

export function setOpenDocument(doc: OpenDocument | null, from?: OpenDocumentSource): void {
  current = doc;
  source = doc === null ? null : (from ?? null);
}

export function getOpenDocument(): OpenDocument | null {
  return current;
}

/**
 * 发送前：指向开着那份文件的引用换成现在的位置。
 * 优先用编辑器追踪的区间（准确，分得清重复句）；追踪不到或区间里的字被改过，
 * 退回「原文 + 上下文」定位；都找不到就标 missing。
 */
export function resolveQuotes(quotes: readonly TextQuote[]): TextQuote[] {
  const open = current;
  const from = source;
  return quotes.map((quote) => {
    if (quote.filePath === undefined) return quote;
    // v2 演示文稿（.slides.json）的引用以页号 / 元素 id 为锚，不靠在文本里重新定位
    if (isDeckPath(quote.filePath)) return quote;
    if (open !== null && from !== null && quote.filePath === open.path) {
      return resolveDocQuotes(from.text(), open.path, (anchor) => from.trackedRange(anchor), [quote])[0] as TextQuote;
    }
    // 面板关着（或开着别的文件）时发送：编辑器已经卸载，但卸载时存了全文与追踪区间，
    // 按它重新定位——总比拿划选时的行号去发强（那正是「关面板再发就改错」的来路）
    const saved = loadTracked(quote.filePath);
    if (saved === null) return quote;
    return resolveDocQuotes(saved.text, quote.filePath, (anchor) => saved.ranges[anchor] ?? null, [quote])[0] as TextQuote;
  });
}
