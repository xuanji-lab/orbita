import { createContext } from "react";
import type { PdfCitation } from "@shared/pdf-quote";

/**
 * PDF 引用的两条横切通路（实验功能「PDF 引用」）。走 Context 而不是 props：消费者是
 * MarkdownBlock 里的锚点，离 ChatView / App 隔着转录列、条目、轮折叠好几层；ChatView
 * 还在抽屉与子会话面板里复用——逐层传 props 要动每个中间签名（ExperimentalFeaturesContext 同理）。
 *
 * - CitationTableContext：本会话的引用表（编号 → 引用），由 ChatView 从自己的转录派生。
 *   每个 ChatView 提供自己的一份：抽屉里看的会话，查的是抽屉那条会话的引用。
 * - CitationOpenContext：点开一条引用（App 提供：开文件面板、预览 PDF、跳到原文）。
 *   null = 树外渲染 / 没有面板可开，锚点退化成不可点的编号。
 */
export const CitationTableContext = createContext<ReadonlyMap<string, PdfCitation>>(new Map());

export const CitationOpenContext = createContext<((citation: PdfCitation) => void) | null>(null);
