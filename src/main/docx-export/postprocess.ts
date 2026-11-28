/**
 * docx 后处理 —— pandoc 只负责「把内容搬进 Word」，学院格式里那几件目录里没有的
 * 事由这里做（全部是纯字符串 → 字符串，便于钉测试）：
 *
 *   1. **三线表**：去掉竖线与内横线，顶 / 底线 1.5 pt，表头下线 0.75 pt；
 *   2. **封面分节**：pandoc 的 title block（Title / Author / Date）后插一个
 *      nextPage 分节符，正文从第 2 节开始（封面页不挂页眉页脚——分节属性只带几何）；
 *   3. **公式编号三栏表**：一行三列的无框表，中间放公式，右列 `(章-序号)`——
 *      `STYLEREF 1 \n \t` 取章号、每章一个独立的 `SEQ EquationN`（见 numberEquations 的说明：
 *      folio 不认 `\s 1`，独立序列名在应用内与 Word 里都正确）；
 *   4. **updateFields**：让 Word 打开时重算目录 / 页码 / 公式号（folio 也读缓存值）。
 *
 * 为什么用字符串而不是 DOM：OOXML 的命名空间前缀在真实模板里可能变（w14 / mc 等），
 * 一个通用 DOM 库会把整棵树重新序列化，动到与本次无关的字节（#308 的保存路径就是
 * 因此坚持「只替换点名的条目」）。这里只在 **body 的顶层元素**上做手术，其余字节
 * 原样保留（写回用 docx/zip.ts 的 rewriteZipEntries）。
 *
 * 幂等性：对已经处理过的文档再跑一次，三线表不会叠边框（tblBorders 被替换），
 * 公式表因为不含 `m:oMathPara` 顶层段落而不会被二次包裹。
 */
import JSZip from "jszip";
import { rewriteZipEntries } from "../docx/zip.ts";
import type { DocxExportStats } from "../../shared/docx-export.ts";

/** 顶层元素切片（只用于 body 内，不递归） */
interface Slice {
  start: number;
  end: number;
  text: string;
}

/**
 * 把一段 XML 的内层切成顶层元素。O(Tag) 计数，跳过注释 / 处理指令 / CDATA；
 * 属性里的 `>` 不参与（OOXML 的属性值里不会有裸 `>`，实测 Word / pandoc 输出均如此）。
 */
export function topLevelSlices(inner: string): Slice[] {
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  const slices: Slice[] = [];
  let depth = 0;
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    // 注释 / PI / CDATA 不参与深度
    if (match[2] === undefined) continue;
    const closing = match[1] === "/";
    const selfClosing = match[4] === "/";
    if (closing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        slices.push({ start, end: pattern.lastIndex, text: inner.slice(start, pattern.lastIndex) });
        start = -1;
      }
      continue;
    }
    if (selfClosing) {
      if (depth === 0) slices.push({ start: match.index, end: pattern.lastIndex, text: match[0] });
      continue;
    }
    if (depth === 0) start = match.index;
    depth += 1;
  }
  return slices;
}

export function bodyInner(documentXml: string): string | null {
  const open = /<w:body\b[^>]*>/.exec(documentXml);
  if (open === null) return null;
  const start = open.index + open[0].length;
  const end = documentXml.lastIndexOf("</w:body>");
  if (end < start) return null;
  return documentXml.slice(start, end);
}

function styleOf(paragraphXml: string): string | null {
  return /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(paragraphXml)?.[1] ?? null;
}

// ─── 1. 三线表 ─────────────────────────────────────────────────────────────

const OUTER = 'w:val="single" w:sz="12" w:space="0" w:color="000000"';
const INNER = 'w:val="none" w:sz="0" w:space="0" w:color="auto"';

function tableBordersXml(): string {
  return (
    "<w:tblBorders>" +
    `<w:top ${OUTER}/><w:left ${INNER}/><w:bottom ${OUTER}/><w:right ${INNER}/>` +
    `<w:insideH ${INNER}/><w:insideV ${INNER}/>` +
    "</w:tblBorders>"
  );
}

/** 在 tblPr 里换上三线表的边框；没有 tblPr 就补一个 */
function setTableBorders(tableXml: string): string {
  const borders = tableBordersXml();
  if (/<w:tblBorders\b[\s\S]*?<\/w:tblBorders>/.test(tableXml)) {
    return tableXml.replace(/<w:tblBorders\b[\s\S]*?<\/w:tblBorders>/, borders);
  }
  if (/<w:tblPr\s*\/>/.test(tableXml)) return tableXml.replace(/<w:tblPr\s*\/>/, `<w:tblPr>${borders}</w:tblPr>`);
  if (/<w:tblPr\b[^>]*>/.test(tableXml)) {
    return tableXml.replace(/(<w:tblPr\b[^>]*>)/, `$1${borders}`);
  }
  return tableXml.replace(/(<w:tbl\b[^>]*>)/, `$1<w:tblPr>${borders}</w:tblPr>`);
}

/** 表头行每个单元格加一条 0.75 pt 下框线 */
function addHeaderRowRule(tableXml: string): string {
  // topLevelSlices 看的是「内层」：剥掉 <w:tbl> 自己的开关标签，行才是顶层
  const openTag = /^<w:tbl\b[^>]*>/.exec(tableXml)?.[0] ?? "<w:tbl>";
  const inner = tableXml.slice(openTag.length, tableXml.lastIndexOf("</w:tbl>"));
  const firstRow = topLevelSlices(inner).find((slice) => /^<w:tr\b/.test(slice.text));
  if (firstRow === undefined) return tableXml;
  const rowOpen = /^<w:tr\b[^>]*>/.exec(firstRow.text)?.[0] ?? "<w:tr>";
  const rowInner = firstRow.text.slice(rowOpen.length, firstRow.text.lastIndexOf("</w:tr>"));
  const border = '<w:tcBorders><w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/></w:tcBorders>';
  let row = rowInner;
  // 从后往前替换，前面的偏移不失效
  for (const cell of [...topLevelSlices(rowInner)].reverse()) {
    if (!/^<w:tc\b/.test(cell.text)) continue;
    const next = cell.text.includes("<w:tcBorders")
      ? cell.text.replace(/<w:tcBorders\b[\s\S]*?<\/w:tcBorders>/, border)
      : /<w:tcPr\s*\/>/.test(cell.text)
        ? cell.text.replace(/<w:tcPr\s*\/>/, `<w:tcPr>${border}</w:tcPr>`)
        : /<w:tcPr\b[^>]*>/.test(cell.text)
          ? cell.text.replace(/(<w:tcPr\b[^>]*>)/, `$1${border}`)
          : cell.text.replace(/(<w:tc\b[^>]*>)/, `$1<w:tcPr>${border}</w:tcPr>`);
    row = row.slice(0, cell.start) + next + row.slice(cell.end);
  }
  const replacedRow = `${rowOpen}${row}</w:tr>`;
  const replaced = inner.slice(0, firstRow.start) + replacedRow + inner.slice(firstRow.end);
  return `${openTag}${replaced}</w:tbl>`;
}

/** 所有顶层表格 → 三线表。返回新 XML 与改动数 */
export function applyThreeLineTables(documentXml: string): { xml: string; count: number } {
  const body = bodyInner(documentXml);
  if (body === null) return { xml: documentXml, count: 0 };
  let count = 0;
  let out = "";
  let cursor = 0;
  for (const slice of topLevelSlices(body)) {
    if (!/^<w:tbl\b/.test(slice.text)) continue;
    const replaced = addHeaderRowRule(setTableBorders(slice.text));
    out += body.slice(cursor, slice.start) + replaced;
    cursor = slice.end;
    count += 1;
  }
  if (count === 0) return { xml: documentXml, count: 0 };
  out += body.slice(cursor);
  const open = documentXml.indexOf("<w:body");
  const bodyOpenEnd = documentXml.indexOf(">", open) + 1;
  return { xml: documentXml.slice(0, bodyOpenEnd) + out + documentXml.slice(documentXml.indexOf("</w:body>")), count };
}

// ─── 2. 封面分节 ───────────────────────────────────────────────────────────

const TITLE_BLOCK_STYLES = new Set(["Title", "Subtitle", "Author", "Date"]);

/** 从 body 最后一个 sectPr 里取几何（页大小 / 页边距 / 栏 / 网格），不带页眉页脚引用 */
function sectionGeometry(documentXml: string): string {
  const end = documentXml.lastIndexOf("</w:body>");
  const before = end < 0 ? documentXml : documentXml.slice(0, end);
  const start = before.lastIndexOf("<w:sectPr");
  if (start < 0) return "";
  const close = before.indexOf("</w:sectPr>", start);
  if (close < 0) return "";
  const kept: string[] = [];
  const pattern = /<(w:pgSz|w:pgMar|w:cols|w:docGrid)\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  const inner = before.slice(start, close);
  while ((match = pattern.exec(inner)) !== null) kept.push(match[0]);
  return kept.join("");
}

/**
 * 封面分节：pandoc 的 title block 之后插一个 nextPage 分节符。
 * 只复制几何——页眉页脚引用不复制，于是封面页默认没有页眉页脚（学校首页通常如此），
 * 正文节沿用模板自己的页眉页脚。
 */
export function applyCoverSection(documentXml: string): { xml: string; applied: boolean } {
  const body = bodyInner(documentXml);
  if (body === null) return { xml: documentXml, applied: false };
  const slices = topLevelSlices(body);
  let lastTitle: Slice | null = null;
  for (const slice of slices) {
    if (!/^<w:p\b/.test(slice.text)) break;
    const style = styleOf(slice.text);
    if (style === null || !TITLE_BLOCK_STYLES.has(style)) break;
    lastTitle = slice;
  }
  if (lastTitle === null) return { xml: documentXml, applied: false };
  const sectPr = `<w:sectPr><w:type w:val="nextPage"/>${sectionGeometry(documentXml)}</w:sectPr>`;
  let paragraph = lastTitle.text;
  if (/<w:pPr\s*\/>/.test(paragraph)) {
    paragraph = paragraph.replace(/<w:pPr\s*\/>/, `<w:pPr>${sectPr}</w:pPr>`);
  } else if (/<\/w:pPr>/.test(paragraph)) {
    paragraph = paragraph.replace(/<\/w:pPr>/, `${sectPr}</w:pPr>`);
  } else {
    paragraph = paragraph.replace(/(<w:p\b[^>]*>)/, `$1<w:pPr>${sectPr}</w:pPr>`);
  }
  const out = body.slice(0, lastTitle.start) + paragraph + body.slice(lastTitle.end);
  const open = documentXml.indexOf("<w:body");
  const bodyOpenEnd = documentXml.indexOf(">", open) + 1;
  return {
    xml: documentXml.slice(0, bodyOpenEnd) + out + documentXml.slice(documentXml.indexOf("</w:body>")),
    applied: true,
  };
}

// ─── 3. 公式编号三栏表 ─────────────────────────────────────────────────────

const EQUATION_TABLE_BORDERS =
  "<w:tblBorders>" +
  ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} ${INNER}/>`).join("") +
  "</w:tblBorders>";

function equationTable(paragraphXml: string, chapter: number | null, number: number): string {
  // 公式段落居中（pandoc 的 display math 段落默认左对齐）
  const centered = /<w:pPr\s*\/>/.test(paragraphXml)
    ? paragraphXml.replace(/<w:pPr\s*\/>/, '<w:pPr><w:jc w:val="center"/></w:pPr>')
    : /<\/w:pPr>/.test(paragraphXml)
      ? paragraphXml.replace(/<\/w:pPr>/, '<w:jc w:val="center"/></w:pPr>')
      : paragraphXml.replace(/(<w:p\b[^>]*>)/, '$1<w:pPr><w:jc w:val="center"/></w:pPr>');

  const chapterField =
    chapter === null
      ? ""
      : '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> STYLEREF 1 \\n \\t </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        `<w:r><w:t>${chapter}</w:t></w:r>` +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        "<w:r><w:t>-</w:t></w:r>";

  // **每章一个独立的 SEQ 名**（Equation1 / Equation2 …），而不是 `SEQ Equation \s 1`：
  // folio 的 SEQ 求值只认 `\r` / `\c`，不认 `\s`（@stll/folio-core 的 seqValues.js 实测），
  // 用 `\s 1` 在应用内会一路累加成 (2-3)。独立名字在 folio 与 Word（F9）里都从 1 开始，
  // 等价于「每章重新编号」，显示与缓存值一致。
  const sequenceName = chapter === null ? "Equation" : `Equation${chapter}`;
  const numberCell =
    "<w:p><w:pPr><w:jc w:val=\"right\"/></w:pPr>" +
    "<w:r><w:t>(</w:t></w:r>" +
    chapterField +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> SEQ ${sequenceName} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${number}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    "<w:r><w:t>)</w:t></w:r></w:p>";

  return (
    "<w:tbl><w:tblPr>" +
    '<w:tblW w:type="pct" w:w="5000"/><w:jc w:val="center"/>' +
    EQUATION_TABLE_BORDERS +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:left w:type="dxa" w:w="0"/><w:right w:type="dxa" w:w="0"/></w:tblCellMar>' +
    "</w:tblPr>" +
    '<w:tblGrid><w:gridCol w:w="900"/><w:gridCol w:w="7400"/><w:gridCol w:w="900"/></w:tblGrid>' +
    "<w:tr>" +
    '<w:tc><w:tcPr><w:tcW w:type="pct" w:w="1000"/><w:vAlign w:val="center"/></w:tcPr><w:p/></w:tc>' +
    `<w:tc><w:tcPr><w:tcW w:type="pct" w:w="8000"/><w:vAlign w:val="center"/></w:tcPr>${centered}</w:tc>` +
    `<w:tc><w:tcPr><w:tcW w:type="pct" w:w="1000"/><w:vAlign w:val="center"/></w:tcPr>${numberCell}</w:tc>` +
    "</w:tr></w:tbl>"
  );
}

/**
 * 每条独立成段的 display equation → 三栏编号表。章号取最近一个 Heading 1；
 * 文档里根本没有 Heading 1 时只出序号（`(1)`），不出 `STYLEREF`——那会显示
 * 「错误！未找到引用源」。
 */
export function numberEquations(documentXml: string): { xml: string; count: number } {
  const body = bodyInner(documentXml);
  if (body === null) return { xml: documentXml, count: 0 };
  const slices = topLevelSlices(body);
  const hasHeading1 = slices.some((slice) => /^<w:p\b/.test(slice.text) && styleOf(slice.text) === "Heading1");
  let chapter = hasHeading1 ? 0 : null;
  let number = 0;
  let count = 0;
  let out = "";
  let cursor = 0;
  for (const slice of slices) {
    if (/^<w:p\b/.test(slice.text)) {
      if (styleOf(slice.text) === "Heading1") {
        chapter = chapter === null ? null : chapter + 1;
        number = 0;
        continue;
      }
      if (!/<m:oMathPara\b/.test(slice.text)) continue;
      number += 1;
      out += body.slice(cursor, slice.start) + equationTable(slice.text, chapter, number);
      cursor = slice.end;
      count += 1;
    }
  }
  if (count === 0) return { xml: documentXml, count: 0 };
  out += body.slice(cursor);
  const open = documentXml.indexOf("<w:body");
  const bodyOpenEnd = documentXml.indexOf(">", open) + 1;
  return {
    xml: documentXml.slice(0, bodyOpenEnd) + out + documentXml.slice(documentXml.indexOf("</w:body>")),
    count,
  };
}

// ─── 3.5 目录缓存条目（pandoc 只给空域，folio 不展开空域） ─────────────────

/**
 * pandoc 的 docx 目录是**一个空 TOC 域**（`begin / instrText / separate / end`
 * 挤在同一段里，中间没有任何条目）。Word 打开时会按 `updateFields` 现算，但 folio
 * 不展开空域——应用内看到的目录只剩一行「Table of Contents」，既没有条目也没有页
 * 码，#308 的页码自愈也就没有东西可改。
 *
 * 所以这里替 Word 写出**缓存条目**：标题（或图表题注）→ 一条 TOCn 段落 +
 * `PAGEREF 书签` 域。页码留 1，folio 打开时按书签位置自己算出真实页码；Word 打开
 * 时按 F9 / updateFields 也会重算。域指令与缓存值分开，自愈只改缓存值，不动指令。
 */
interface TocEntry {
  level: number;
  text: string;
  bookmark: string;
}

/** 段落里的文字（各 run 的 w:t 拼起来，做 XML 反转义） */
function textOfParagraph(paragraphXml: string): string {
  const parts: string[] = [];
  const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(paragraphXml)) !== null) parts.push(decodeXml(match[1] ?? ""));
  return parts.join("").trim();
}

function xmlEscapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 标题条目：阅读顺序、级别 1–6、书签取段落里 pandoc 盖的那个 */
function headingEntries(body: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const slice of topLevelSlices(body)) {
    if (!/^<w:p\b/.test(slice.text)) continue;
    const style = styleOf(slice.text);
    const level = style === null ? 0 : Number(/^Heading([1-6])$/.exec(style)?.[1] ?? 0);
    if (level === 0) continue;
    const bookmark = /<w:bookmarkStart\b[^>]*w:name="([^"]+)"/.exec(slice.text)?.[1];
    const text = textOfParagraph(slice.text);
    if (bookmark === undefined || text === "") continue;
    entries.push({ level, text, bookmark: decodeXml(bookmark) });
  }
  return entries;
}

/** 题注条目：pandoc 给表格 / 图片题注的是 TableCaption / ImageCaption 样式 */
function captionEntries(body: string, styleName: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const slice of topLevelSlices(body)) {
    if (!/^<w:p\b/.test(slice.text) || styleOf(slice.text) !== styleName) continue;
    const bookmark = /<w:bookmarkStart\b[^>]*w:name="([^"]+)"/.exec(slice.text)?.[1];
    const text = textOfParagraph(slice.text);
    if (bookmark === undefined || text === "") continue;
    entries.push({ level: 1, text, bookmark: decodeXml(bookmark) });
  }
  return entries;
}

/**
 * 给图表题注盖书签（PAGEREF 要有落点）。标题的书签 pandoc 已经盖了，题注没有。
 * 新 id 从已有最大 id + 1 起，名字用 `_OrbitaTable1` / `_OrbitaFigure1` 避免与
 * pandoc 的 `_<标题>` 撞。
 */
export function insertCaptionBookmarks(documentXml: string): { xml: string; changed: number } {
  const body = bodyInner(documentXml);
  if (body === null) return { xml: documentXml, changed: 0 };
  let nextId = 0;
  for (const match of body.matchAll(/<w:bookmarkStart\b[^>]*w:id="(\d+)"/g)) {
    nextId = Math.max(nextId, Number(match[1]) + 1);
  }
  const counters = new Map<string, number>();
  const countersOf = (kind: string): number => {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return value;
  };
  let changed = 0;
  let out = "";
  let cursor = 0;
  for (const slice of topLevelSlices(body)) {
    if (!/^<w:p\b/.test(slice.text)) continue;
    const style = styleOf(slice.text);
    if (style !== "TableCaption" && style !== "ImageCaption") continue;
    if (/<w:bookmarkStart\b/.test(slice.text)) continue;
    const kind = style === "TableCaption" ? "Table" : "Figure";
    const n = countersOf(kind);
    const id = nextId++;
    const name = `_Orbita${kind}${n}`;
    const open = /^<w:p\b[^>]*>/.exec(slice.text)?.[0] ?? "<w:p>";
    const withStart = `${open}<w:bookmarkStart w:id="${id}" w:name="${name}"/>${slice.text.slice(open.length)}`;
    const withEnd = withStart.replace(/<\/w:p>\s*$/, `<w:bookmarkEnd w:id="${id}"/></w:p>`);
    out += body.slice(cursor, slice.start) + withEnd;
    cursor = slice.end;
    changed += 1;
  }
  if (changed === 0) return { xml: documentXml, changed: 0 };
  out += body.slice(cursor);
  const open = documentXml.indexOf("<w:body");
  const bodyOpenEnd = documentXml.indexOf(">", open) + 1;
  return {
    xml: documentXml.slice(0, bodyOpenEnd) + out + documentXml.slice(documentXml.indexOf("</w:body>")),
    changed,
  };
}

function tocEntryXml(entry: TocEntry): string {
  const style = `TOC${Math.min(Math.max(entry.level, 1), 3)}`;
  const anchor = xmlEscapeAttribute(entry.bookmark);
  const title = entry.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // PAGEREF **放在 hyperlink 外面**：folio 的 w:hyperlink 子节点解析只保留有 payload 的 run，
  // 域字符（fldChar）会被丢掉——存一次盘目录就变成静态数字，Word 里按 F9 也不会再算。
  // 放在段落这一层，folio 能把 begin/instr/separate/result/end 装配成一个 ComplexField，
  // 保存时原样写回（serializeComplexField），#308 的字段路径才能持续生效。
  return (
    `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>` +
    `<w:hyperlink w:anchor="${anchor}" w:history="1">` +
    `<w:r><w:t xml:space="preserve">${title}</w:t></w:r>` +
    "<w:r><w:tab/></w:r>" +
    "</w:hyperlink>" +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> PAGEREF ${anchor} \\h </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    // 缓存页码：folio 打开时按书签位置重算（#308 的自愈也读同一个域）；Word 会按 F9 重算
    "<w:r><w:t>1</w:t></w:r>" +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    "</w:p>"
  );
}

/**
 * 把空 TOC 域展开成「缓存条目」。返回替换了几处域。
 * 只处理 `<w:p>` 内含 `TOC` 指令的那种，其它域不动。
 */
export function fillTocEntries(documentXml: string): { xml: string; fields: number; entries: number } {
  const body = bodyInner(documentXml);
  if (body === null) return { xml: documentXml, fields: 0, entries: 0 };
  const headings = headingEntries(body);
  const tables = captionEntries(body, "TableCaption");
  const figures = captionEntries(body, "ImageCaption");
  const paragraphPattern = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g;
  const replacements: { start: number; end: number; text: string }[] = [];
  let entries = 0;
  let match: RegExpExecArray | null;
  while ((match = paragraphPattern.exec(body)) !== null) {
    const paragraph = match[0];
    const instruction = decodeXml(match[1] ?? "");
    if (!/^\s*TOC\b/.test(instruction)) continue;
    const isTables = /Table Caption/.test(instruction) && /\\c\b/.test(instruction);
    const isFigures = /Image Caption/.test(instruction) && /\\c\b/.test(instruction);
    const items = isTables ? tables : isFigures ? figures : headings;
    const instrRaw = match[1] ?? "";
    const replacement =
      '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve">${instrRaw}</w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>' +
      (items.length === 0 ? "" : items.map(tocEntryXml).join("")) +
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    replacements.push({ start: match.index, end: match.index + paragraph.length, text: replacement });
    entries += items.length;
  }
  if (replacements.length === 0) return { xml: documentXml, fields: 0, entries: 0 };
  let out = body;
  for (const replacement of [...replacements].reverse()) {
    out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
  }
  const open = documentXml.indexOf("<w:body");
  const bodyOpenEnd = documentXml.indexOf(">", open) + 1;
  return {
    xml: documentXml.slice(0, bodyOpenEnd) + out + documentXml.slice(documentXml.indexOf("</w:body>")),
    fields: replacements.length,
    entries,
  };
}

/** 目录条目样式：模板里没有 TOC 1–3 时补上（右对齐点线制表位 + 逐级缩进） */
export function ensureTocStyles(stylesXml: string): string {
  const missing = [1, 2, 3].filter((level) => !new RegExp(`w:styleId="TOC${level}"`).test(stylesXml));
  if (missing.length === 0) return stylesXml;
  const styles = missing
    .map((level) => {
      const indent = (level - 1) * 240;
      return (
        `<w:style w:type="paragraph" w:styleId="TOC${level}"><w:name w:val="toc ${level}"/>` +
        '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/>' +
        `<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9000"/></w:tabs>` +
        `<w:spacing w:before="0" w:after="60"/>${indent === 0 ? "" : `<w:ind w:left="${indent}"/>`}</w:pPr></w:style>`
      );
    })
    .join("");
  return stylesXml.replace(/<\/w:styles>/, `${styles}</w:styles>`);
}

// ─── 3.6 按产物裁掉空目录（TOC / LOF / LOT） ─────────────────────────────

export interface DocxLists {
  toc: boolean;
  figures: boolean;
  tables: boolean;
}

function countStyledParagraphs(body: string, styleName: string): number {
  let count = 0;
  for (const slice of topLevelSlices(body)) {
    if (/^<w:p\b/.test(slice.text) && styleOf(slice.text) === styleName) count += 1;
  }
  return count;
}

/** 删掉一个 docPartGallery 对应的整块 `w:sdt`（连「List of Tables」标题一起） */
function stripGallerySection(documentXml: string, gallery: string): string {
  const escaped = gallery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<w:sdt\\b[^>]*>(?:(?!</w:sdt>)[\\s\\S])*?<w:docPartGallery\\b[^>]*w:val="${escaped}"[\\s\\S]*?</w:sdt>`,
    "g",
  );
  return documentXml.replace(pattern, "");
}

/**
 * pandoc 的 `--toc/--lof/--lot` 只按标志插域，不看内容：源里没有标题、表格没有题注、
 * 图片没有题注时，产物会多出空的「Table of Contents / List of Tables / List of Figures」
 * 标题。这里按**产物里真实的事实**裁：
 *   - TOC：有 Heading1–6 才留；
 *   - LOT：有真实表格（顶层 `w:tbl`）且至少一个 TableCaption 才留；
 *   - LOF：有图片（`w:drawing` / `w:pict`）且至少一个 ImageCaption 才留。
 * 返回裁完之后还留下的节，工具摘要与 `lists` 都读这一份（不再按源码正则猜）。
 */
export function pruneEmptyLists(documentXml: string): { xml: string; lists: DocxLists } {
  const body = bodyInner(documentXml);
  if (body === null) return { xml: documentXml, lists: { toc: false, figures: false, tables: false } };
  const headings = (body.match(/<w:pStyle\b[^>]*w:val="Heading[1-6]"/g) ?? []).length;
  const tableCaptions = countStyledParagraphs(body, "TableCaption");
  const figureCaptions = countStyledParagraphs(body, "ImageCaption");
  const tables = topLevelSlices(body).filter((slice) => /^<w:tbl\b/.test(slice.text)).length;
  const figures = (body.match(/<w:drawing\b/g) ?? []).length + (body.match(/<w:pict\b/g) ?? []).length;
  const lists: DocxLists = {
    toc: headings > 0,
    tables: tables > 0 && tableCaptions > 0,
    figures: figures > 0 && figureCaptions > 0,
  };
  let xml = documentXml;
  if (!lists.toc) xml = stripGallerySection(xml, "Table of Contents");
  if (!lists.tables) xml = stripGallerySection(xml, "List of Tables");
  if (!lists.figures) xml = stripGallerySection(xml, "List of Figures");
  return { xml, lists };
}

// ─── 4. updateFields ───────────────────────────────────────────────────────

/** settings.xml 里打开 updateFields（目录 / 页码 / SEQ 域在 Word 打开时重算） */
export function setUpdateFields(settingsXml: string): { xml: string; applied: boolean } {
  if (/<w:updateFields\b[^>]*\/>/.test(settingsXml)) {
    if (/<w:updateFields\b[^>]*w:val="(?:true|1|on)"/.test(settingsXml)) return { xml: settingsXml, applied: true };
    return {
      xml: settingsXml.replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>'),
      applied: true,
    };
  }
  if (/<w:settings\s*\/>/.test(settingsXml)) {
    return {
      xml: settingsXml.replace(/<w:settings\s*\/>/, '<w:settings><w:updateFields w:val="true"/></w:settings>'),
      applied: true,
    };
  }
  if (!/<\/w:settings>/.test(settingsXml)) return { xml: settingsXml, applied: false };
  return {
    xml: settingsXml.replace(/<\/w:settings>/, '<w:updateFields w:val="true"/></w:settings>'),
    applied: true,
  };
}

// ─── 5. 公式守门 + 统计 ────────────────────────────────────────────────────

function textOfRuns(xml: string): string[] {
  const out: string[] = [];
  const pattern = /<(?:w|m):t\b[^>]*>([\s\S]*?)<\/(?:w|m):t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out.push(decodeXml(match[1] ?? ""));
  return out;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 公式降级的证据：pandoc 把不认识的 TeX 写成字面 `$...$` 文本。返回原文片段
 * （去重、最多 8 条），由调用方决定报错还是只告警——这里是纯事实。
 */
export function findMathResidue(documentXml: string): string[] {
  const found = new Set<string>();
  for (const text of textOfRuns(documentXml)) {
    const pattern = /\$[^$\n]{1,300}\$/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      found.add(match[0].trim());
      if (found.size >= 8) return [...found];
    }
  }
  return [...found];
}

export function countDocumentStats(documentXml: string): Pick<DocxExportStats, "paragraphs" | "headings" | "tables" | "fields"> {
  return {
    paragraphs: documentXml.match(/<w:p\b/g)?.length ?? 0,
    headings: documentXml.match(/<w:pStyle\b[^>]*w:val="Heading[1-6]"/g)?.length ?? 0,
    tables: documentXml.match(/<w:tbl\b/g)?.length ?? 0,
    fields: documentXml.match(/<w:instrText\b/g)?.length ?? 0,
  };
}

// ─── 6. 整包处理 ───────────────────────────────────────────────────────────

export interface PostProcessResult {
  bytes: Uint8Array;
  lists: DocxLists;
  stats: Omit<DocxExportStats, "bytes">;
  warnings: string[];
  /** 公式降级的原文片段（非空即调用方应判失败） */
  mathResidue: string[];
}

/**
 * 对 pandoc 的产物做完整后处理。**只替换 document.xml / settings.xml**，图片、
 * 字体、关系等条目一个字节不动（rewriteZipEntries 的保证）。
 * rewriteZipEntries 不支持 ZIP64：万一撞上（超大图片包），退回 JSZip 整包重写，
 * 并留一条 warning——产物仍然正确，只是与「一个字节不动」的承诺有出入。
 */
export async function postProcessDocx(bytes: Uint8Array): Promise<PostProcessResult> {
  let documentAfter = "";
  let settingsAfter: string | null = null;
  let updateFieldsApplied = false;
  const warnings: string[] = [];
  let numberedEquations = 0;
  let threeLineTables = 0;
  let coverSection = false;
  let lists: DocxLists = { toc: false, figures: false, tables: false };

  const transformDocument = (text: string): string => {
    const tables = applyThreeLineTables(text);
    const cover = applyCoverSection(tables.xml);
    // 图表题注先盖书签，目录条目才有 PAGEREF 的落点；空 TOC 域再展开成缓存条目
    const captions = insertCaptionBookmarks(cover.xml);
    const pruned = pruneEmptyLists(captions.xml);
    lists = pruned.lists;
    const toc = fillTocEntries(pruned.xml);
    const equations = numberEquations(toc.xml);
    documentAfter = equations.xml;
    threeLineTables = tables.count;
    coverSection = cover.applied;
    numberedEquations = equations.count;
    return equations.xml;
  };
  const transformSettings = (text: string): string => {
    const next = setUpdateFields(text);
    settingsAfter = next.xml;
    updateFieldsApplied = next.applied;
    return next.xml;
  };
  const transformStyles = (text: string): string => ensureTocStyles(text);

  let output: Uint8Array;
  try {
    output = rewriteZipEntries(bytes, ["word/document.xml", "word/settings.xml", "word/styles.xml"], (name, text) =>
      name === "word/document.xml" ? transformDocument(text) : name === "word/styles.xml" ? transformStyles(text) : transformSettings(text),
    );
  } catch (cause) {
    warnings.push(
      `The DOCX package uses a structure the fast writer cannot edit (${cause instanceof Error ? cause.message : String(cause)}); rewrote it with the full repack instead.`,
    );
    output = await postProcessWithJsZip(bytes, transformDocument, transformSettings, transformStyles);
  }

  if (documentAfter === "") {
    throw new Error("The generated DOCX has no word/document.xml");
  }
  if (!updateFieldsApplied) {
    warnings.push("Could not enable field update (word/settings.xml is missing or unreadable); Word will not refresh the table of contents on open.");
  }

  const stats = countDocumentStats(documentAfter);
  return {
    bytes: output,
    lists,
    stats: {
      paragraphs: stats.paragraphs,
      headings: stats.headings,
      tables: Math.max(0, stats.tables - numberedEquations),
      numberedEquations,
      threeLineTables,
      fields: stats.fields,
      coverSection,
    },
    warnings,
    mathResidue: findMathResidue(documentAfter),
  };
}

async function postProcessWithJsZip(
  bytes: Uint8Array,
  documentTransform: (text: string) => string,
  settingsTransform: (text: string) => string,
  stylesTransform: (text: string) => string,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const document = zip.file("word/document.xml");
  if (document === null) throw new Error("The generated DOCX has no word/document.xml");
  zip.file("word/document.xml", documentTransform(await document.async("string")));
  const settings = zip.file("word/settings.xml");
  if (settings !== null) zip.file("word/settings.xml", settingsTransform(await settings.async("string")));
  const styles = zip.file("word/styles.xml");
  if (styles !== null) zip.file("word/styles.xml", stylesTransform(await styles.async("string")));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
