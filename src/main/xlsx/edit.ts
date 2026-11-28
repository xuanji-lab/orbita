/**
 * `fs:write-xlsx` 的实做（契约在 `shared/xlsx.ts`）。**纯模块**（同 `read.ts` 的先例）：
 * 不 import electron，白名单校验在 ipc.ts 做完才把真实路径传进来，`node --test` 能直接加载。
 *
 * **只动目标单元格的那段 XML，别的部件一个字节不改。** 这件事是本模块的全部理由：
 *
 *   - 用 ExcelJS「读进来 → 改一格 → 整份写回去」会把所有它不认识的部件悄悄丢掉——图表、
 *     数据透视表、切片器、自定义 XML 都不在它的模型里。用户改一个数字，图表就没了，
 *     而且没有任何提示。这与「不改坏别的东西」正好相反。
 *   - 所以这里走 **OOXML zip 级补丁**：JSZip 只解出目标工作表的 `xl/worksheets/sheetN.xml`，
 *     在其中定位到那一格的 `<c>`（没有就按列序插一个），替换成新的 `<c>`；样式（`s="…"`）
 *     原样带上，公式、合并区、条件格式、数据验证、图片、列宽、冻结窗格都在**别的 XML
 *     部件里**，我们连碰都不碰。写测试时逐条比对 zip 条目的字节可以证明这一点。
 *
 * 几条硬规矩：
 *   1. **原子写**：先写同目录的临时文件再 rename 盖过去；失败就删临时文件，原文件不动。
 *   2. **冲突闸**：调用方带来的指纹（mtime + size）与盘上不符就回 `conflict`、不写盘——
 *      agent 的 `edit_office` 改过同一份文件时，人这边的未保存改动不会被悄悄覆盖。
 *   3. **只认可编辑窗口**（`XLSX_PREVIEW_ROWS × XLSX_PREVIEW_COLS`）：面板没显示过的格
 *      不写，越界回 `out-of-window`，不静默丢弃。
 *   4. **不重算**：写进去的公式只有 `<f>` 没有 `<v>`——我们不是计算引擎，假装算过就是
 *      在表里放假数据。界面据此标「未计算」，数值要 Excel 打开后才更新。
 *
 * 共享公式（`<f t="shared" ref="C2:C100" si="0">`）：组长格的定义是整组公式的来源。
 * 改它的**公式原文**没问题（组还在，新文本就是新的定义）；往它里面写**值**或清空会让
 * 整组失去定义、成员格全废——那种情况拒绝，回 `shared-formula`。成员格随便改（它不
 * 是别人的来源）。
 *
 * **带前缀的 OOXML**（`<x:worksheet>` / `<x:row>`，OfficeCLI 重写过的文件）：写回时
 * 沿用文件自己的前缀，不去改它的写法——`read.ts` 的兼容模式只归一化内存副本，原文件
 * 一直是带前缀的样子，我们改一个格不该顺手把它整份重写成另一种风格。
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import JSZip from "jszip";
import { xlsxColumnIndex, xlsxColumnLabel } from "../../shared/office.ts";
import {
  XLSX_MAX_BYTES,
  XLSX_PREVIEW_COLS,
  XLSX_PREVIEW_ROWS,
  type XlsxCellEdit,
  type XlsxFingerprint,
  type XlsxWriteResult,
} from "../../shared/xlsx.ts";

export interface XlsxEditOptions {
  /** 以下三个只为测试注入更小的上限，生产路径用契约常量 */
  limit?: number;
  maxRows?: number;
  maxCols?: number;
  /** 测试注入：「临时文件 → 原文件」那一步（验原子写失败时原文件不动、临时文件不残留） */
  commit?: (from: string, to: string) => Promise<void>;
}

/** 归一化之后的一格改动：坐标已过窗口校验，公式已去掉前导 `=` */
interface CellEdit {
  sheet: string;
  row: number;
  col: number;
  /** null = 清空；`formula` 有值时忽略它 */
  value: string | number | null;
  formula: string | null;
}

/** zip 的本地文件头（真正的 .xlsx 是 OOXML = zip 容器） */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** OLE2 复合文档头：加密的 .xlsx 与旧版 .xls 都长这样 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** XML 文本 / 属性值转义（`'` 与 `"` 都转：属性可能用任意一种引号写） */
const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/**
 * 读一个属性值。属性名可带命名空间前缀（`r:id`）、也接受 `x:name` 这种带前缀的变体
 * （OfficeCLI 重写过的文件可能整份换前缀）。`sheetId` 不会被当成 `id`：正则要求
 * 名字前面是空白或文档开头，所以「前面紧贴 `sheet`」的写法匹配不上。
 */
export function attributeOf(attributes: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  );
  const match = pattern.exec(attributes);
  if (match === null) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * A1 写法 → 1-based 列号；不像单元格引用就回 null。
 * 列字母的换算与面板 / officecli 的路径同一套（`shared/office.ts` 的 xlsxColumn*）。
 */
function columnOfRef(ref: string): number | null {
  const match = /^([A-Za-z]{1,3})\d+$/.exec(ref.trim());
  if (match === null) return null;
  return xlsxColumnIndex(match[1] ?? "") + 1;
}

const refOf = (row: number, col: number): string => `${xlsxColumnLabel(col - 1)}${row}`;

/** 文件头是不是指定的那几个字节 */
function startsWithBytes(buffer: Uint8Array, magic: readonly number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, index) => buffer[index] === byte);
}

/** 工作簿里的一张表：名字 + 关系 id（再经 rels 换到 sheetN.xml） */
interface SheetRef {
  name: string;
  rid: string | null;
}

/** `<sheets>` 里的 `<sheet name="…" r:id="…"/>`（前缀容忍） */
function parseSheets(workbookXml: string): SheetRef[] {
  const block = /<([A-Za-z_][\w.-]*:)?sheets\b[^>]*>([\s\S]*?)<\/\1?sheets>/.exec(workbookXml);
  const inner = block?.[2] ?? "";
  const sheets: SheetRef[] = [];
  const pattern = /<([A-Za-z_][\w.-]*:)?sheet\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    const attributes = match[2] ?? "";
    const name = attributeOf(attributes, "name");
    if (name === null) continue;
    sheets.push({ name, rid: attributeOf(attributes, "id") });
  }
  return sheets;
}

/** `xl/_rels/workbook.xml.rels`：rId → 相对 workbook 的部件路径 */
function parseRels(relsXml: string): Map<string, string> {
  const targets = new Map<string, string>();
  const pattern = /<([A-Za-z_][\w.-]*:)?Relationship\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(relsXml)) !== null) {
    const attributes = match[2] ?? "";
    // 只看工作表关系：styles / sharedStrings 这些 id 撞不上，但 Type 判定更稳
    const type = attributeOf(attributes, "Type") ?? "";
    if (type !== "" && !/\/worksheet$/.test(type)) continue;
    const id = attributeOf(attributes, "Id");
    const target = attributeOf(attributes, "Target");
    if (id === null || target === null) continue;
    targets.set(id, target);
  }
  return targets;
}

/** rels 里的目标（可能绝对 `/xl/…`、可能相对 `worksheets/…`）→ zip 里的键 */
function resolvePartKey(workbookPath: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const base = workbookPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}

/** `_rels/.rels` 里的 officeDocument 目标（正常就是 `xl/workbook.xml`） */
function officeDocumentKey(relsXml: string): string | null {
  const pattern = /<([A-Za-z_][\w.-]*:)?Relationship\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(relsXml)) !== null) {
    const attributes = match[2] ?? "";
    const type = attributeOf(attributes, "Type") ?? "";
    if (!/\/officeDocument$/.test(type)) continue;
    const target = attributeOf(attributes, "Target");
    if (target !== null) return target.replace(/^\/+/, "");
  }
  return null;
}

/** 一行 `<row>`：`start`/`end` 是它在 sheetData 里的位置（`inner` 只在不自闭合时有值） */
interface RowElement {
  number: number;
  prefix: string;
  attributes: string;
  inner: string;
  selfClosing: boolean;
  start: number;
  end: number;
}

/** 一格 `<c>`：`start`/`end` 是它在行内的位置，`body` 是不含开闭标签的内容 */
interface CellElement {
  col: number;
  attributes: string;
  body: string;
  start: number;
  end: number;
}

const OPEN_TAG = (name: string): RegExp => new RegExp(`<([A-Za-z_][\\w.-]*:)?${name}\\b([^>]*?)(/?)>`, "g");

/** 扫出 sheetData 里的行（行不嵌套，所以找下一个闭合标签就够） */
function scanRows(inner: string): RowElement[] | null {
  const rows: RowElement[] = [];
  const open = OPEN_TAG("row");
  let match: RegExpExecArray | null;
  let previous = 0;
  while ((match = open.exec(inner)) !== null) {
    const prefix = match[1] ?? "";
    const attributes = match[2] ?? "";
    const selfClosing = (match[3] ?? "") === "/";
    const start = match.index;
    const afterOpen = open.lastIndex;
    let body = "";
    let end = afterOpen;
    if (!selfClosing) {
      const close = inner.indexOf(`</${prefix}row>`, afterOpen);
      if (close < 0) return null; // 结构坏了：让调用方按 corrupt 拒绝
      body = inner.slice(afterOpen, close);
      end = close + `</${prefix}row>`.length;
    }
    const raw = attributeOf(attributes, "r");
    const parsed = raw === null ? null : Number.parseInt(raw, 10);
    const number = parsed !== null && Number.isFinite(parsed) ? parsed : previous + 1;
    rows.push({ number, prefix, attributes, inner: body, selfClosing, start, end });
    previous = number;
    open.lastIndex = end;
  }
  return rows;
}

/** 扫出一行里的格（格也不嵌套） */
function scanCells(inner: string): CellElement[] | null {
  const cells: CellElement[] = [];
  const open = OPEN_TAG("c");
  let match: RegExpExecArray | null;
  let previous = 0;
  while ((match = open.exec(inner)) !== null) {
    const prefix = match[1] ?? "";
    const attributes = match[2] ?? "";
    const selfClosing = (match[3] ?? "") === "/";
    const start = match.index;
    const afterOpen = open.lastIndex;
    let body = "";
    let end = afterOpen;
    if (!selfClosing) {
      const close = inner.indexOf(`</${prefix}c>`, afterOpen);
      if (close < 0) return null;
      body = inner.slice(afterOpen, close);
      end = close + `</${prefix}c>`.length;
    }
    const raw = attributeOf(attributes, "r");
    const col = raw === null ? null : columnOfRef(raw);
    cells.push({ col: col ?? previous + 1, attributes, body, start, end });
    previous = cells[cells.length - 1]?.col ?? previous + 1;
    open.lastIndex = end;
  }
  return cells;
}

/** 单元格 body 里的 `<f …>`（共享公式判定要用它的属性） */
function formulaTagOf(body: string): { attributes: string; text: string } | null {
  const match = /<([A-Za-z_][\w.-]*:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1?f>)/.exec(body);
  if (match === null) return null;
  return { attributes: match[2] ?? "", text: match[3] ?? "" };
}

/** 这一格是不是共享公式的**组长**（`t="shared"` 且带 `ref="…"`） */
function sharedMasterOf(body: string): { attributes: string; formulaAttrs: string } | null {
  const tag = formulaTagOf(body);
  if (tag === null) return null;
  if ((attributeOf(tag.attributes, "t") ?? "") !== "shared") return null;
  const ref = attributeOf(tag.attributes, "ref");
  if (ref === null || ref.trim() === "") return null;
  return { attributes: tag.attributes, formulaAttrs: tag.attributes };
}

/** 一格的 XML。样式（`s`）原样带上；公式优先于值；null 值 = 清空但留样式 */
function cellXml(prefix: string, row: number, col: number, style: string | null, edit: CellEdit, formulaAttrs: string | null): string {
  const p = prefix;
  const attrs = [` r="${refOf(row, col)}"`];
  if (style !== null && style !== "") attrs.push(` s="${escapeXml(style)}"`);
  if (edit.formula !== null) {
    // 共享公式组长：组的属性（t="shared" ref si）必须留着，否则成员格失去定义
    const inner = formulaAttrs === null ? "" : formulaAttrs;
    return `<${p}c${attrs.join("")}><${p}f${inner}>${escapeXml(edit.formula)}</${p}f></${p}c>`;
  }
  if (edit.value === null) return `<${p}c${attrs.join("")}/>`;
  if (typeof edit.value === "number") {
    return `<${p}c${attrs.join("")}><${p}v>${edit.value}</${p}v></${p}c>`;
  }
  return (
    `<${p}c${attrs.join("")} t="inlineStr"><${p}is><${p}t xml:space="preserve">` +
    `${escapeXml(edit.value)}</${p}t></${p}is></${p}c>`
  );
}

interface RowPatchResult {
  inner: string;
  /** 往共享公式组长里写值 / 清空：整组会失去定义，这一格不写 */
  refused: CellEdit | null;
}

/** 一行的改写：目标格替换、缺的格按列序插入，其它格与空白一个字节不动 */
function patchRow(inner: string, prefix: string, row: number, edits: readonly CellEdit[]): RowPatchResult {
  const cells = scanCells(inner);
  if (cells === null) return { inner, refused: null };

  const ops: { start: number; end: number; text: string; order: number }[] = [];
  for (const edit of edits) {
    const existing = cells.find((cell) => cell.col === edit.col);
    if (existing !== undefined) {
      const master = sharedMasterOf(existing.body);
      if (master !== null && edit.formula === null) return { inner, refused: edit };
      const style = attributeOf(existing.attributes, "s");
      const keepFormulaAttrs = master !== null ? master.formulaAttrs : null;
      ops.push({
        start: existing.start,
        end: existing.end,
        text: cellXml(prefix, row, edit.col, style, edit, keepFormulaAttrs),
        order: edit.col,
      });
      continue;
    }
    const anchor = cells.find((cell) => cell.col > edit.col);
    const at = anchor?.start ?? inner.length;
    ops.push({ start: at, end: at, text: cellXml(prefix, row, edit.col, null, edit, null), order: edit.col });
  }
  ops.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);

  let out = "";
  let cursor = 0;
  for (const op of ops) {
    if (op.start < cursor) continue; // 重叠的插入点已经过（不会发生，防御）
    out += inner.slice(cursor, op.start);
    out += op.text;
    cursor = op.end;
  }
  out += inner.slice(cursor);
  return { inner: out, refused: null };
}

/** 一行里最右边那格的列号（新建行的插入点按它算维度） */
function dimensionOf(xml: string): { top: number; left: number; bottom: number; right: number } | null {
  const match = /<([A-Za-z_][\w.-]*:)?dimension\b([^>]*?)\/?>/.exec(xml);
  if (match === null) return null;
  const ref = attributeOf(match[2] ?? "", "ref");
  if (ref === null) return null;
  const parts = ref.split(":");
  const first = parts[0] ?? "";
  const last = parts[1] ?? first;
  const firstCol = columnOfRef(first);
  const lastCol = columnOfRef(last);
  const firstRow = Number.parseInt(first.replace(/^[A-Za-z]+/, ""), 10);
  const lastRow = Number.parseInt(last.replace(/^[A-Za-z]+/, ""), 10);
  if (firstCol === null || lastCol === null || !Number.isFinite(firstRow) || !Number.isFinite(lastRow)) return null;
  return { top: firstRow, left: firstCol, bottom: lastRow, right: lastCol };
}

/** 新写的格伸出了 `<dimension>` 就把它撑大（只撑不放：缩回去没有意义，也更容易出错） */
function expandDimension(xml: string, maxRow: number, maxCol: number): string {
  const current = dimensionOf(xml);
  if (current === null) return xml;
  if (maxRow <= current.bottom && maxCol <= current.right) return xml;
  const bottom = Math.max(maxRow, current.bottom);
  const right = Math.max(maxCol, current.right);
  const ref = `${xlsxColumnLabel(current.left - 1)}${current.top}:${xlsxColumnLabel(right - 1)}${bottom}`;
  return xml.replace(
    /(<([A-Za-z_][\w.-]*:)?dimension\b[^>]*?\sref\s*=\s*)("[^"]*"|'[^']*')/,
    (_whole, head: string) => `${head}"${ref}"`,
  );
}

/**
 * 把一批改动打进一张表的 XML。返回 null = 结构不像一张工作表（调用方按 corrupt 拒绝）。
 * 除 `sheetData` 里被改的那几格（以及为新行、新格插入的标签）之外，整段 XML 原样保留。
 */
function patchSheetXml(xml: string, edits: readonly CellEdit[]): { xml: string } | { refused: CellEdit } | null {
  const open = /<([A-Za-z_][\w.-]*:)?sheetData\b([^>]*?)(\/?)>/.exec(xml);
  if (open === null) return null;
  const prefix = open[1] ?? "";
  const selfClosing = (open[3] ?? "") === "/";
  const openStart = open.index;
  const openEnd = openStart + open[0].length;
  let body = "";
  // 闭合标签之后的那一段（原样拼回去）
  let tail = xml.slice(openEnd);
  if (!selfClosing) {
    const close = xml.indexOf(`</${prefix}sheetData>`, openEnd);
    if (close < 0) return null;
    body = xml.slice(openEnd, close);
    tail = xml.slice(close + `</${prefix}sheetData>`.length);
  }

  const rows = scanRows(body);
  if (rows === null) return null;

  // 按行分组（同一行的多格一起改写，row 的 XML 只重建一次）
  const byRow = new Map<number, CellEdit[]>();
  for (const edit of edits) {
    const list = byRow.get(edit.row);
    if (list === undefined) byRow.set(edit.row, [edit]);
    else list.push(edit);
  }

  const replacements = new Map<number, string>(); // 行号 → 新的整段 row XML
  const additions: { row: number; text: string }[] = [];
  for (const [rowNumber, rowEdits] of byRow) {
    const existing = rows.find((row) => row.number === rowNumber);
    if (existing !== undefined) {
      const patched = patchRow(existing.inner, existing.prefix, rowNumber, rowEdits);
      if (patched.refused !== null) return { refused: patched.refused };
      // 自闭合的 `<row r="5"/>` 也要展开成带内容的行：新格得有个地方待着
      replacements.set(
        rowNumber,
        `<${existing.prefix}row${existing.attributes}>${patched.inner}</${existing.prefix}row>`,
      );
      continue;
    }
    const inner = rowEdits
      .slice()
      .sort((a, b) => a.col - b.col)
      .map((edit) => cellXml(prefix, rowNumber, edit.col, null, edit, null))
      .join("");
    additions.push({ row: rowNumber, text: `<${prefix}row r="${rowNumber}">${inner}</${prefix}row>` });
  }

  // 重建 sheetData 的内容：逐行复制（改过的换成新的），新增行按行号插到正确位置
  let out = "";
  let cursor = 0;
  const pending = additions.slice().sort((a, b) => a.row - b.row);
  const flushAdditions = (before: number): void => {
    let next = pending[0];
    while (next !== undefined && next.row < before) {
      out += next.text;
      pending.shift();
      next = pending[0];
    }
  };
  for (const row of rows) {
    flushAdditions(row.number);
    out += body.slice(cursor, row.start);
    out += replacements.get(row.number) ?? body.slice(row.start, row.end);
    cursor = row.end;
  }
  out += body.slice(cursor);
  for (const addition of pending) out += addition.text;

  const rebuilt = selfClosing
    ? `<${prefix}sheetData>${out}</${prefix}sheetData>`
    : `<${prefix}sheetData${open[2] ?? ""}>${out}</${prefix}sheetData>`;
  const patchedXml = xml.slice(0, openStart) + rebuilt + tail;
  const maxRow = Math.max(...edits.map((edit) => edit.row));
  const maxCol = Math.max(...edits.map((edit) => edit.col));
  return { xml: expandDimension(patchedXml, maxRow, maxCol) };
}

/** 请求里的一格改动 → 归一化形态；形状不对回一句人话 */
function normalizeEdit(edit: XlsxCellEdit, index: number): CellEdit | string {
  if (!isRecord(edit)) return `第 ${index + 1} 条改动不是对象`;
  if (typeof edit.sheet !== "string" || edit.sheet.trim() === "") return `第 ${index + 1} 条改动缺工作表名`;
  if (!Number.isInteger(edit.row) || !Number.isInteger(edit.col)) {
    return `第 ${index + 1} 条改动的行列不是整数（行列是 1-based）`;
  }
  const formulaRaw = typeof edit.formula === "string" ? edit.formula.trim().replace(/^=/, "").trim() : null;
  const formula = formulaRaw === null || formulaRaw === "" ? null : formulaRaw;
  if (formula !== null) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(formula)) return `第 ${index + 1} 条改动的公式里有控制字符`;
    return { sheet: edit.sheet, row: edit.row, col: edit.col, value: null, formula };
  }
  const value = edit.value ?? null;
  if (value !== null && typeof value !== "string" && typeof value !== "number") {
    return `第 ${index + 1} 条改动的值既不是字符串也不是数字`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `第 ${index + 1} 条改动是 NaN / Infinity，Excel 存不了这种数`;
  }
  return { sheet: edit.sheet, row: edit.row, col: edit.col, value, formula: null };
}

/**
 * 把一批单元格改动写回一份 .xlsx（调用方已过白名单并确认 `.xlsx` 扩展名）。
 *
 * 见文件顶注释：只动目标单元格的 XML，原子写，冲突闸，窗口闸，不重算公式。
 * `expected` 缺席 = 不比对指纹（内部 / 测试用；界面永远带指纹）。
 */
export async function writeXlsxCells(
  path: string,
  edits: readonly XlsxCellEdit[],
  expected?: XlsxFingerprint,
  options: XlsxEditOptions = {},
): Promise<XlsxWriteResult> {
  const limit = options.limit ?? XLSX_MAX_BYTES;
  const maxRows = options.maxRows ?? XLSX_PREVIEW_ROWS;
  const maxCols = options.maxCols ?? XLSX_PREVIEW_COLS;
  const commit = options.commit ?? rename;

  const normalized: CellEdit[] = [];
  const byCell = new Map<string, CellEdit>();
  for (const [index, edit] of edits.entries()) {
    const result = normalizeEdit(edit, index);
    if (typeof result === "string") return { kind: "failed", error: result };
    byCell.set(`${result.sheet}\u0000${result.row}\u0000${result.col}`, result);
  }
  for (const edit of byCell.values()) normalized.push(edit);

  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  if (stats.size > limit) return { kind: "too-large", limit, size: stats.size };
  if (expected !== undefined && (stats.size !== expected.size || stats.mtimeMs !== expected.mtimeMs)) {
    return { kind: "conflict", size: stats.size, modifiedAt: stats.mtimeMs };
  }
  // 没有要写的东西：一个字节都不碰（也不算失败——界面本来就不该在这种时候发请求）
  if (normalized.length === 0) {
    return { kind: "ok", cells: 0, size: stats.size, modifiedAt: stats.mtimeMs };
  }

  const outOfWindow = normalized.filter(
    (edit) => edit.row < 1 || edit.col < 1 || edit.row > maxRows || edit.col > maxCols,
  );
  if (outOfWindow.length > 0) {
    return {
      kind: "out-of-window",
      rows: maxRows,
      cols: maxCols,
      edits: outOfWindow.map((edit) => ({
        sheet: edit.sheet,
        row: edit.row,
        col: edit.col,
        ...(edit.formula === null ? { value: edit.value } : { formula: edit.formula }),
      })),
    };
  }

  const bytes = await readFile(path);
  if (startsWithBytes(bytes, OLE2_MAGIC)) {
    return { kind: "unreadable", reason: "password", detail: "OLE2 container (encrypted workbook or legacy .xls)" };
  }
  if (!startsWithBytes(bytes, ZIP_MAGIC)) {
    return { kind: "unreadable", reason: "corrupt", detail: "Not a zip container — not an .xlsx file" };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (cause) {
    return { kind: "unreadable", reason: "corrupt", detail: failMessage(cause) };
  }

  // 工作簿部件：正常在 xl/workbook.xml，位置由 _rels/.rels 说了算（自定义布局也认）
  const rootRels = zip.file("_rels/.rels");
  const workbookKey = (rootRels === null ? null : officeDocumentKey(await rootRels.async("string"))) ?? "xl/workbook.xml";
  const workbookEntry = zip.file(workbookKey);
  if (workbookEntry === null) return { kind: "unreadable", reason: "corrupt", detail: `missing ${workbookKey}` };
  const workbookXml = await workbookEntry.async("string");

  const sheets = parseSheets(workbookXml);
  const names = sheets.map((sheet) => sheet.name);

  // 需要改哪几张表：表名 → 那张表的 zip 键
  const wanted = new Set(normalized.map((edit) => edit.sheet));
  for (const name of wanted) {
    if (!names.includes(name)) {
      return { kind: "unreadable", reason: "sheet-missing", detail: `No sheet named "${name}"`, sheets: names };
    }
  }
  const relsKey = `${dirname(workbookKey).replace(/\\/g, "/")}/_rels/${basename(workbookKey)}.rels`;
  const relsEntry = zip.file(relsKey);
  if (relsEntry === null) return { kind: "unreadable", reason: "corrupt", detail: `missing ${relsKey}` };
  const targets = parseRels(await relsEntry.async("string"));
  const partOf = new Map<string, string>();
  for (const sheet of sheets) {
    const target = sheet.rid === null ? undefined : targets.get(sheet.rid);
    if (target === undefined) continue;
    const key = resolvePartKey(workbookKey, target);
    if (zip.file(key) !== null) partOf.set(sheet.name, key);
  }

  // 逐张表打补丁（先在内存里全部算完，任何一张拒绝就整体不写）
  for (const name of wanted) {
    const key = partOf.get(name);
    if (key === undefined) {
      return { kind: "unreadable", reason: "corrupt", detail: `No worksheet part for "${name}"`, sheets: names };
    }
    const entry = zip.file(key);
    if (entry === null) return { kind: "unreadable", reason: "corrupt", detail: `missing ${key}` };
    const xml = await entry.async("string");
    const sheetEdits = normalized.filter((edit) => edit.sheet === name);
    const patched = patchSheetXml(xml, sheetEdits);
    if (patched === null) return { kind: "unreadable", reason: "corrupt", detail: `${key} has no sheetData` };
    if ("refused" in patched) {
      const refused = patched.refused;
      return {
        kind: "shared-formula",
        sheet: refused.sheet,
        row: refused.row,
        col: refused.col,
        detail: `${refOf(refused.row, refused.col)} 是共享公式的组长格，往里写值会让整组公式失去定义`,
      };
    }
    zip.file(key, patched.xml);
  }

  let output: Buffer;
  try {
    output = await zip.generateAsync({ type: "nodebuffer" });
  } catch (cause) {
    return { kind: "failed", error: `打包失败：${failMessage(cause)}` };
  }

  // 原子写：同目录临时文件 → rename。失败就删临时文件，原文件一个字节不动
  const tempPath = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.orbita-tmp`);
  try {
    await writeFile(tempPath, output);
    await commit(tempPath, path);
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    return { kind: "failed", error: failMessage(cause) };
  }

  const after = await stat(path);
  return { kind: "ok", cells: normalized.length, size: after.size, modifiedAt: after.mtimeMs };
}
