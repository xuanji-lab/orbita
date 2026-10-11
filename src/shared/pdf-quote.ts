/**
 * PDF 原文引用的匹配与契约（实验功能「PDF 引用」）。**两个消费者**：agent 的
 * `cite_pdf` 在引用写进对话之前核验原文（agent/pdf-tools.ts），renderer 点引用时
 * 在文本层上把同一段找回来画高亮（features/files/PdfPreview.tsx）。两边必须用同一
 * 把尺子量——否则 agent 说「找到了」、界面却高亮不出来，信任反而被打穿。
 *
 * **文本源**：两边都取 pdf.js（同版本 6.1.200：unpdf 内置 / pdfjs-dist 直装）
 * `getTextContent({ disableNormalization: true })` 的条目字符串——渲染端文本层
 * （TextLayer）本身就是按这个参数流出来的，DOM 里每个 span 就是一个条目。
 *
 * **归一化**：比对前两边都只留字母、数字与组合符（`\p{L}\p{N}\p{M}`），逐码点做
 * NFKC + 小写。去空白解决换行（中文换行处本不该有空格、英文换行处是空格，提取
 * 工具各插各的）；去标点顺带吃掉行尾断词连字符、全半角标点、弯直引号；NFKC 展开
 * 连字（ﬁ → fi）与全角字母数字。代价是标点不同的两句会判同——引用核验关心的是
 * 「这段话在不在原文里」，标点差异不构成另一段话。
 *
 * **偏移**：命中位置记成「该页归一化串」上的 [start, end)。归一化串由条目串
 * 确定性地算出，两边同版本 pdf.js 得到同一串，偏移即可直接复用；对不上时
 * renderer 退回按原文重搜（`findQuote`）。
 */

/** pdf.js 文本条目的最小子集（TextItem；TextMarkedContent 没有 str，调用方先滤掉） */
export interface PdfTextRun {
  str: string;
  /** 条目后是否换行。只影响展示文本（`displayText`），不参与匹配 */
  hasEOL?: boolean;
}

/** 一页的匹配索引：归一化串 + 每个归一化 UTF-16 单元回指的源位置 */
export interface PageTextIndex {
  norm: string;
  /** norm[i] 来自第几个条目 */
  run: readonly number[];
  /** norm[i] 的源码点在条目串里的起点（UTF-16 偏移） */
  from: readonly number[];
  /** norm[i] 的源码点在条目串里的终点（不含） */
  to: readonly number[];
}

/** 引用的最短归一化长度。再短的片段（「如下」「Table」）在一篇文档里处处都是，定位没有意义 */
export const QUOTE_MIN_CHARS = 4;

/** 近似匹配（首尾锚定）要求的最短归一化长度：太短的引用两端锚点会重叠 */
const APPROX_MIN_CHARS = 12;

const KEEP = /[\p{L}\p{N}\p{M}]/u;

/** 单个码点的归一化：NFKC + 小写，只留字母 / 数字 / 组合符（可能展开成多个字，如 ﬁ → fi） */
function normalizeCodePoint(cp: string): string {
  let out = "";
  for (const ch of cp.normalize("NFKC").toLowerCase()) {
    if (KEEP.test(ch)) out += ch;
  }
  return out;
}

/** 整串归一化（引用原文那一侧用） */
export function normalizeQuote(text: string): string {
  let out = "";
  for (const cp of text) out += normalizeCodePoint(cp);
  return out;
}

/** 条目列表 → 一页的匹配索引 */
export function indexPageText(runs: readonly PdfTextRun[]): PageTextIndex {
  let norm = "";
  const run: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  runs.forEach((item, runIndex) => {
    let offset = 0;
    for (const cp of item.str) {
      const piece = normalizeCodePoint(cp);
      for (let i = 0; i < piece.length; i++) {
        run.push(runIndex);
        from.push(offset);
        to.push(offset + cp.length);
      }
      norm += piece;
      offset += cp.length;
    }
  });
  return { norm, run, from, to };
}

/** 归一化串上的 [start, end) 映回源位置：起点条目 / 偏移、终点条目 / 偏移（不含） */
export interface SourceSpan {
  startRun: number;
  startOffset: number;
  endRun: number;
  endOffset: number;
}

export function sourceSpan(index: PageTextIndex, start: number, end: number): SourceSpan | null {
  if (start < 0 || end > index.norm.length || start >= end) return null;
  return {
    startRun: index.run[start] ?? 0,
    startOffset: index.from[start] ?? 0,
    endRun: index.run[end - 1] ?? 0,
    endOffset: index.to[end - 1] ?? 0,
  };
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

/**
 * 源位置区间 → 给人看的原文：条目原样拼接，换行处补一个空格，再把连续空白压成
 * 一个；**两侧都是 CJK 的空白直接去掉**（中文排版换行处本无空格，补出来的空格
 * 会让引文读着像被截断）。行尾断词连字符保留（原文就是那样印的），但不补空格。
 */
export function displayText(runs: readonly PdfTextRun[], span: SourceSpan): string {
  let raw = "";
  for (let i = span.startRun; i <= span.endRun; i++) {
    const str = runs[i]?.str ?? "";
    const begin = i === span.startRun ? span.startOffset : 0;
    const finish = i === span.endRun ? span.endOffset : str.length;
    raw += str.slice(begin, finish);
    // 行尾断词（「buf-」+ 换行）直接接下一行，不补空格：读成 buf-fering 而不是 buf- fering
    if (i < span.endRun && runs[i]?.hasEOL === true && !/[-\u2010\u00ad]$/.test(str)) raw += " ";
  }
  const collapsed = foldGlyphs(raw).replace(/\s+/g, " ").trim();
  let out = "";
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i] ?? "";
    if (ch === " " && CJK.test(collapsed[i - 1] ?? "") && CJK.test(collapsed[i + 1] ?? "")) continue;
    out += ch;
  }
  return out;
}

/**
 * 排版字形 → 正字：拉丁连字（ﬀ ﬁ ﬂ，U+FB00–FB06）与康熙部首 / 部首补充（U+2E80–2FDF）。
 * 中文 PDF 常把「文」「一」编成部首码位（⽂ ⼀），看着一样，复制出去、搜索时却是另一个
 * 字。只折这两段：整串 NFKC 会把中文全角标点（，）也折成半角，原文就不是原文了。
 */
function foldGlyphs(text: string): string {
  return text.replace(/[\u2e80-\u2fdf\ufb00-\ufb06]/g, (ch) => ch.normalize("NFKC"));
}

/** 一处命中：页码 1 起，偏移在该页归一化串上 */
export interface QuoteLocation {
  page: number;
  start: number;
  end: number;
}

export type QuoteMatch =
  /** exact：归一化后逐字相同；approximate：首尾锚定、中段有出入（引文以 PDF 原文为准） */
  | ({ kind: "exact" | "approximate"; occurrences: number } & QuoteLocation)
  /** nearest：只有开头一段对得上的最近位置，给模型改引用用；整段都对不上为 null */
  | { kind: "not-found"; nearest: QuoteLocation | null }
  | { kind: "too-short" };

/** 页码遍历顺序：提示页先，其余按序。提示页越界当没给 */
function pageOrder(count: number, hint: number | undefined): number[] {
  const order: number[] = [];
  if (hint !== undefined && hint >= 1 && hint <= count) order.push(hint);
  for (let page = 1; page <= count; page++) if (page !== hint) order.push(page);
  return order;
}

function occurrencesOf(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    hits.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return hits;
}

/**
 * 在全文档里找一段引文。顺序：精确（归一化后逐字）→ 近似（首尾各一段锚点、
 * 跨度与引文长度相差不超过三成，取最接近的）→ 都不中则给「开头对得上的最近处」。
 * `pageHint`（1 起）只决定先看哪一页、多处命中时取哪一处，不限制搜索范围——
 * 模型记错页码不该让一段真在文档里的引文判成找不到。
 */
export function findQuote(pages: readonly PageTextIndex[], quote: string, pageHint?: number): QuoteMatch {
  const q = normalizeQuote(quote);
  if (q.length < QUOTE_MIN_CHARS) return { kind: "too-short" };
  const order = pageOrder(pages.length, pageHint);

  let first: QuoteLocation | null = null;
  let occurrences = 0;
  for (const page of order) {
    const hits = occurrencesOf(pages[page - 1]?.norm ?? "", q);
    occurrences += hits.length;
    const at = hits[0];
    if (first === null && at !== undefined) first = { page, start: at, end: at + q.length };
  }
  if (first !== null) return { kind: "exact", occurrences, ...first };

  if (q.length >= APPROX_MIN_CHARS) {
    const anchor = Math.min(24, Math.max(6, Math.floor(q.length / 4)));
    const head = q.slice(0, anchor);
    const tail = q.slice(-anchor);
    let best: (QuoteLocation & { drift: number }) | null = null;
    let count = 0;
    for (const page of order) {
      const norm = pages[page - 1]?.norm ?? "";
      for (const h of occurrencesOf(norm, head)) {
        let pick: (QuoteLocation & { drift: number }) | null = null;
        for (const t of occurrencesOf(norm, tail)) {
          if (t < h + anchor) continue;
          const span = t + anchor - h;
          if (span < q.length * 0.75 || span > q.length * 1.33) continue;
          const drift = Math.abs(span - q.length);
          if (pick === null || drift < pick.drift) pick = { page, start: h, end: t + anchor, drift };
        }
        if (pick === null) continue;
        count += 1;
        // 提示页先遍历：同等偏差下先到的（提示页）胜出
        if (best === null || pick.drift < best.drift) best = pick;
      }
    }
    if (best !== null) {
      return { kind: "approximate", occurrences: count, page: best.page, start: best.start, end: best.end };
    }
  }

  // 最近处：开头一段（由长到短）第一次对上的位置，跨度按引文长度截到页尾
  for (let size = Math.min(q.length - 1, 24); size >= 6; size--) {
    const head = q.slice(0, size);
    for (const page of order) {
      const norm = pages[page - 1]?.norm ?? "";
      const at = norm.indexOf(head);
      if (at !== -1) {
        return { kind: "not-found", nearest: { page, start: at, end: Math.min(norm.length, at + q.length) } };
      }
    }
  }
  return { kind: "not-found", nearest: null };
}

/**
 * 一条已核验的引用（`cite_pdf` 工具结果 `details.pdfCitations` 的元素，随会话
 * JSONL 落盘；只给 UI，不进模型上下文）。`text` 是 **PDF 里的原文**而不是模型
 * 交来的那句——近似命中时两者有出入，用户看到的必须是文档本身。
 */
export interface PdfCitation {
  /** 引用编号，模型在正文里写 `[^<id>]` */
  id: string;
  /** PDF 的绝对路径（agent 实际读的那一份：附件副本或原位置） */
  path: string;
  page: number;
  /** 该页归一化串上的偏移（renderer 先按它画，对不上再按 text 重搜） */
  start: number;
  end: number;
  text: string;
}

/** 正文里的引用标记：`[^c7k2]`。编号一律 c + 3 位 [a-z0-9]，与人写的脚注 `[^1]` 天然区分 */
export const CITATION_MARKER = /\[\^(c[a-z0-9]{3})\]/g;

/** 新编号：c + 3 位 base36。冲突由「取正文之前最近的一条」消解（见 renderer 的引用表） */
export function newCitationId(random: () => number = Math.random): string {
  let id = "c";
  for (let i = 0; i < 3; i++) id += Math.floor(random() * 36).toString(36);
  return id;
}

/** 工具结果 details → 引用列表。逐字段校验，坏条目丢掉（编造的路径 / 页码会把用户带错地方） */
export function citationsOfDetails(details: unknown): PdfCitation[] {
  if (typeof details !== "object" || details === null) return [];
  const raw = (details as Record<string, unknown>)["pdfCitations"];
  if (!Array.isArray(raw)) return [];
  const out: PdfCitation[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    const { id, path, page, start, end, text } = value;
    if (typeof id !== "string" || !/^c[a-z0-9]{3}$/.test(id)) continue;
    if (typeof path !== "string" || path === "") continue;
    if (typeof text !== "string") continue;
    if (!isNonNegativeInt(page) || page < 1 || !isNonNegativeInt(start) || !isNonNegativeInt(end) || end <= start) {
      continue;
    }
    out.push({ id, path, page, start, end, text });
  }
  return out;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
