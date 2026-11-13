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
 *
 * **模型自己补了脚注定义的情形**（2026-11-08，会话 96d38d）：模型模仿 miyo 检索的
 * 「Sources section」，在末尾给每个标记补一行 `[^c7b2]: 文件名, p. 1`。remark-gfm 对
 * 有定义的标签改出 footnoteReference + footnoteDefinition，上面的文本切分永远看不到它，
 * 点击变成「跳到页面底部的脚注」而不是打开 PDF。这里把标签形如引用编号的
 * footnoteReference 还原成同一种引用链接（序号与文本路径共用同一张出场表），并删掉
 * 对应的 footnoteDefinition（否则页脚多出一份重复的来源列表）。`[^1]`、`[^note]` 这类
 * 人写的脚注不动。
 */
import { CITATION_MARKER, citationsOfDetails, type PdfCitation } from "../../../../shared/pdf-quote.ts";

export const CITE_HREF_PREFIX = "#orbita-cite-";

/** 够用的 mdast 子集（同 math-guard.ts） */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  /** footnoteReference / footnoteDefinition 的标签（保留原大小写）与规范化标识 */
  label?: string;
  identifier?: string;
  children?: MdNode[];
}

/** 引用编号的标签形态：与 CITATION_MARKER 同一规则（c + 3 位小写字母 / 数字），整串匹配 */
const CITATION_ID = /^c[a-z0-9]{3}$/;

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
    if (child.type === "footnoteDefinition" && isCitationFootnote(child)) {
      children.splice(i, 1);
      i -= 1;
      continue;
    }
    if (child.type === "footnoteReference" && isCitationFootnote(child)) {
      children[i] = citationLink(child.label ?? child.identifier ?? "", order);
      continue;
    }
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

/** 脚注节点的标签是不是引用编号；用 label（原样）而非小写化的 identifier，`[^C7B2]` 不认 */
function isCitationFootnote(node: MdNode): boolean {
  return CITATION_ID.test(node.label ?? node.identifier ?? "");
}

/** 一个引用编号 → 链接节点；序号按本条消息内首次出场排，重复编号沿用 */
function citationLink(id: string, order: Map<string, number>): MdNode {
  let label = order.get(id);
  if (label === undefined) {
    label = order.size + 1;
    order.set(id, label);
  }
  return { type: "link", url: `${CITE_HREF_PREFIX}${id}`, children: [{ type: "text", value: String(label) }] };
}

/** 一段文本切成 text / link 交替；没有标记回 null（不动原节点） */
function splitMarkers(value: string, order: Map<string, number>): MdNode[] | null {
  const pattern = new RegExp(CITATION_MARKER.source, "g");
  const out: MdNode[] = [];
  let last = 0;
  for (let hit = pattern.exec(value); hit !== null; hit = pattern.exec(value)) {
    if (hit.index > last) out.push({ type: "text", value: value.slice(last, hit.index) });
    out.push(citationLink(hit[1] ?? "", order));
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
  return CITATION_ID.test(id) ? id : null;
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
