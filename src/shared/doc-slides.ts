/**
 * 演示文稿的分页：一份 `.md`，单独成行的 `---` 分页（Marp 写法）。
 *
 * 渲染端（右栏缩略条 / 当前页）、PDF 导出（页数 = 分页数）、引用（页号 + 行号范围）
 * 与测试共用这一处——「第几页」只有这一个定义，两边不各说各话。
 *
 * - 文件开头的 front matter（`---` … `---`，里面只有 `key: value` 行）不是页，
 *   `marp: true` 是「这份文件是演示文稿」的标记（`isDeckText`）；
 * - 围栏代码块（``` / ~~~）里的 `---` 不分页；
 * - 空白页算一页（用户加了一页还没写字，缩略条里得有它）；只有「整份正文都是空白」
 *   才是 0 页；
 * - 每页的 `from`/`to` 是**可原样替换的区间**：只收有字的那几行，不含分隔线，也不含页前后的
 *   空行与换行——用户改某一页再拼回去，分隔线与留白不会被吃掉。空白页的区间是一个点。
 */

/** 一页在整份文本里的位置 */
export interface DeckPage {
  /** 0 起 */
  index: number;
  /** 起点偏移：页里第一个非空行的行首 */
  from: number;
  /** 终点偏移（不含）：页里最后一个非空行的行尾（不含换行） */
  to: number;
  /** 起止行号（1 起，含两端），按整份文件算——引用给模型的就是它 */
  startLine: number;
  endLine: number;
  text: string;
}

export interface Deck {
  /** front matter 的整块文本（含两条 `---`），没有就是 null */
  head: string | null;
  pages: DeckPage[];
}

const SEPARATOR = /^---[ \t]*$/;
const FENCE = /^(\s{0,3})(```+|~~~+)/;
const FRONT_KEY = /^[A-Za-z_][\w-]*\s*:/;

/** 文本开头的 front matter 占多少行（含两条 `---`）；没有返回 0 */
function frontMatterLines(lines: readonly string[]): number {
  if (lines.length < 2 || !SEPARATOR.test(lines[0] as string)) return 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (SEPARATOR.test(line)) return i >= 2 ? i + 1 : 0;
    // 空行 / 缩进续行（yaml 的多行值）放过；其余必须是 key: value，否则这是第一页的内容
    if (line.trim() === "" || /^\s/.test(line)) continue;
    if (!FRONT_KEY.test(line)) return 0;
  }
  return 0;
}

/** 按行切成 [起点偏移, 行文本]：换行符不进行文本（CRLF 的 \r 一并去掉），偏移按原文算 */
function lineTable(text: string): { offset: number; body: string; eol: number }[] {
  const rows: { offset: number; body: string; eol: number }[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const nl = text.indexOf("\n", offset);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(offset, end);
    rows.push({ offset, body: raw.endsWith("\r") ? raw.slice(0, -1) : raw, eol: end });
    if (nl === -1) break;
    offset = nl + 1;
  }
  return rows;
}

export function parseDeck(text: string): Deck {
  const rows = lineTable(text);
  const headLines = frontMatterLines(rows.map((row) => row.body));
  const head =
    headLines === 0
      ? null
      : text.slice(0, (rows[headLines - 1] as { eol: number }).eol);

  // 分隔线所在的行号（0 起）
  const cuts: number[] = [];
  let fence: string | null = null;
  for (let i = headLines; i < rows.length; i += 1) {
    const body = (rows[i] as { body: string }).body;
    const open = FENCE.exec(body);
    if (fence !== null) {
      if (open !== null && (open[2] as string).startsWith(fence[0] as string) && (open[2] as string).length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (open !== null) {
      fence = open[2] as string;
      continue;
    }
    if (SEPARATOR.test(body)) cuts.push(i);
  }

  // 段 = [起始行, 结束行)，结束行是下一条分隔线所在行（或文末）
  const segments: { startRow: number; endRow: number }[] = [];
  let start = headLines;
  for (const cut of cuts) {
    segments.push({ startRow: start, endRow: cut });
    start = cut + 1;
  }
  segments.push({ startRow: start, endRow: rows.length });

  // 行表在文件以换行结尾时多一行空行，它不是内容
  const rowCount = rows.length - (text.endsWith("\n") && rows.length > 1 ? 1 : 0);
  const pages: DeckPage[] = segments.map((segment, index) => {
    const lastRow = Math.min(segment.endRow, rowCount) - 1;
    let firstContent = -1;
    let lastContent = -1;
    for (let i = segment.startRow; i <= lastRow; i += 1) {
      if ((rows[i] as { body: string }).body.trim() === "") continue;
      if (firstContent === -1) firstContent = i;
      lastContent = i;
    }
    if (firstContent === -1) {
      // 空白页：区间是个点，落在段首（没有这一行就落在文末）
      const at = rows[Math.min(segment.startRow, rows.length - 1)] as { offset: number };
      const from = segment.startRow >= rowCount ? text.length : at.offset;
      const row = Math.min(segment.startRow, Math.max(rowCount - 1, 0)) + 1;
      return { index, from, to: from, startLine: row, endLine: row, text: "" };
    }
    // 只收有字的那几行：前后的空行属于分隔线周围的留白，页编辑不去碰它们
    const from = (rows[firstContent] as { offset: number }).offset;
    const to = (rows[lastContent] as { body: string; offset: number }).offset + (rows[lastContent] as { body: string }).body.length;
    return { index, from, to, startLine: firstContent + 1, endLine: lastContent + 1, text: text.slice(from, to) };
  });

  // 整份正文都是空白、没有分页符 = 还没有页
  if (cuts.length === 0 && (pages[0] as DeckPage).text.trim() === "") return { head, pages: [] };
  return { head, pages };
}

/** 是不是演示文稿：front matter 里有 `marp: true` */
export function isDeckText(text: string): boolean {
  const rows = lineTable(text).map((row) => row.body);
  const count = frontMatterLines(rows);
  if (count === 0) return false;
  return rows.slice(1, count - 1).some((line) => /^marp\s*:\s*true\s*$/i.test(line.trim()));
}

/** 新建的演示文稿的初始内容：只有 front matter，没有页 */
export const NEW_DECK_TEXT = "---\nmarp: true\n---\n";

/** 「加一页」的占位内容 */
export const NEW_PAGE_TEXT = "# ";

/**
 * 在第 `after` 页（0 起）后面插一页，返回新的整份文本。`after` 为 null 或还没有页 = 放文末。
 * 返回新页的 index 与新页文字在新文本里的区间（调用方据此把光标放进去）。
 */
export function insertPageAfter(
  text: string,
  after: number | null,
  pageText = NEW_PAGE_TEXT,
): { text: string; index: number; from: number; to: number } {
  const deck = parseDeck(text);
  const anchor = after === null ? deck.pages[deck.pages.length - 1] : deck.pages[after];
  if (anchor === undefined) {
    // 还没有页：front matter 之后（或文首）直接放
    const base = text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
    const lead = base === "" || deck.head !== null ? "\n" : "";
    const prefix = `${base}${lead}`;
    return { text: `${prefix}${pageText}\n`, index: 0, from: prefix.length, to: prefix.length + pageText.length };
  }
  const glue = "\n\n---\n\n";
  const next = `${text.slice(0, anchor.to)}${glue}${pageText}${text.slice(anchor.to)}`;
  const from = anchor.to + glue.length;
  return { text: next, index: anchor.index + 1, from, to: from + pageText.length };
}

/** 把第 `index` 页的文字换成 `pageText`，其余一字不动 */
export function replacePage(text: string, index: number, pageText: string): string {
  const page = parseDeck(text).pages[index];
  if (page === undefined) return text;
  return `${text.slice(0, page.from)}${pageText}${text.slice(page.to)}`;
}

/** 删掉第 `index` 页（连同它前面的一条分隔线；首页连同后面的）。返回新文本 */
export function removePage(text: string, index: number): string {
  const deck = parseDeck(text);
  const page = deck.pages[index];
  if (page === undefined) return text;
  if (deck.pages.length === 1) return `${text.slice(0, page.from)}${text.slice(page.to)}`;
  if (index > 0) {
    // 吃掉「前一页末尾 → 本页末尾」之间的分隔线与本页
    const previous = deck.pages[index - 1] as DeckPage;
    return `${text.slice(0, previous.to)}${text.slice(page.to)}`;
  }
  const following = deck.pages[1] as DeckPage;
  return `${text.slice(0, page.from)}${text.slice(following.from)}`;
}
