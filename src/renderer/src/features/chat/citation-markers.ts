/**
 * 正文里的 PDF 引用标记 `[^c4k2]` → 可点的上标编号（实验功能「PDF 引用」）。
 *
 * 标记由 agent 的 cite_pdf 发出（shared/pdf-quote.ts 的 CITATION_MARKER）。remark-gfm
 * 只认有定义的脚注，没有定义的 `[^c4k2]` 原样留在文本节点里——这里把它切成 link
 * 节点：href 是 `#orbita-cite-<id>`（片段链接过得了 sanitize，也绝不会导航），
 * 文字是本条消息内的出场序号（同一编号重复出现沿用第一次的序号）。
 *
 * **解析与引用表无关**：编号能不能对上一条真实引用，由渲染期的锚点组件查 Context
 * 决定（对不上就原样显示 `[^c4k2]`，模型写错的编号对用户可见）。这样 markdown 的
 * 解析结果只随 text 变，MarkdownBlock 的 memo 仍然成立。
 *
 * 代码、行内代码、公式、已有链接里的不动：`[^c4k2]` 出现在代码里多半是在讲语法本身。
 */
import { CITATION_MARKER, citationsOfDetails, type PdfCitation } from "../../../../shared/pdf-quote.ts";

export const CITE_HREF_PREFIX = "#orbita-cite-";

/** 够用的 mdast 子集（同 math-guard.ts） */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "inlineMath", "math", "html"]);

export function linkCitationMarkers(tree: MdNode): void {
  const order = new Map<string, number>();
  walk(tree, order);
}

function walk(node: MdNode, order: Map<string, number>): void {
  const children = node.children;
  if (children === undefined) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if (SKIP.has(child.type)) continue;
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitMarkers(child.value, order);
      if (parts !== null) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
      continue;
    }
    walk(child, order);
  }
}

/** 一段文本切成 text / link 交替；没有标记回 null（不动原节点） */
function splitMarkers(value: string, order: Map<string, number>): MdNode[] | null {
  const pattern = new RegExp(CITATION_MARKER.source, "g");
  const out: MdNode[] = [];
  let last = 0;
  for (let hit = pattern.exec(value); hit !== null; hit = pattern.exec(value)) {
    const id = hit[1] ?? "";
    if (hit.index > last) out.push({ type: "text", value: value.slice(last, hit.index) });
    let label = order.get(id);
    if (label === undefined) {
      label = order.size + 1;
      order.set(id, label);
    }
    out.push({ type: "link", url: `${CITE_HREF_PREFIX}${id}`, children: [{ type: "text", value: String(label) }] });
    last = hit.index + hit[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** unified 插件形状：使用处传工厂本身、不要调用（math-guard.ts 的 2026-09-04 黑屏教训） */
export function remarkCitationMarkers(): (tree: MdNode) => void {
  return (tree) => {
    linkCitationMarkers(tree);
  };
}

/** 锚点 href → 引用编号；不是引用锚点回 null */
export function citationIdOfHref(href: string | undefined): string | null {
  if (href === undefined || !href.startsWith(CITE_HREF_PREFIX)) return null;
  const id = href.slice(CITE_HREF_PREFIX.length);
  return /^c[a-z0-9]{3}$/.test(id) ? id : null;
}

/** 悬停提示：`p.3 · “原文…”`（设计系统：title 承载后半句，中点连接） */
export function citationTitle(page: number, text: string, max = 160): string {
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return `p.${page} · “${clipped}”`;
}

/** 转录的最小子集：只认 cite_pdf 的终态工具结果（TranscriptItem 结构上可代入） */
export interface CitationSourceItem {
  role: string;
  toolName?: string;
  status?: string;
  details?: unknown;
}

/**
 * 本会话的引用表：编号 → 引用。按转录顺序收，**后来的覆盖先前的**——编号是
 * 3 位 base36 随机串，跨轮撞号的概率是万分之几，撞了也只是指向较新的那条
 * （正文写的通常就是最近一次 cite_pdf 发的编号）。running 帧没有 details，跳过。
 */
export function collectCitations(items: readonly CitationSourceItem[]): ReadonlyMap<string, PdfCitation> {
  const table = new Map<string, PdfCitation>();
  for (const item of items) {
    if (item.role !== "tool" || item.toolName !== "cite_pdf" || item.status === "running") continue;
    for (const citation of citationsOfDetails(item.details)) table.set(citation.id, citation);
  }
  return table;
}
