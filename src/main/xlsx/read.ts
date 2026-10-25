/**
 * `fs:read-xlsx` 的实做（契约在 `shared/xlsx.ts`）。**纯模块**（同 `files/read.ts`
 * 的先例）：不 import electron，白名单校验在 ipc.ts 做完才把真实路径传进来，这里只管
 * 「给一条路径，读出可预览的结构」，`node --test` 能直接加载测。
 *
 * **读全量、只喂一页**：ExcelJS 解一份工作簿要建全部单元格模型（20000 行 × 60 列实测
 * 2.3 s、一件 390 MB 的堆），所以这里没有「只读前 2000 行」的取巧办法——合并区、冻结
 * 窗格、公式缓存值都只在整份解析完才齐。代价是这 2 s 必须**离开主进程的事件循环**：
 * 解析跑在 worker 线程里（`worker.ts` / `service.ts`），主进程只等着拿结果，窗口不卡。
 * 因此本模块的返回值就是 worker 的返回值。
 *
 * 数字格式只还原**百分比**：ExcelJS 不做数字格式排版，`text` 是原始值，而百分比格
 * 存的是 0.1234——原样显示成「0.1234」是把 12.34% 说错了一个数量级。千分位 / 货币
 * 这类只是「不够好看」，保持原值不猜。日期由 ExcelJS 还原成 Date（带日期格式的格），
 * 这里按本地时区排成 `YYYY-MM-DD [HH:mm]`。
 */
import { open, stat } from "node:fs/promises";
import ExcelJS from "exceljs";
import {
  XLSX_MAX_BYTES,
  XLSX_PREVIEW_COLS,
  XLSX_PREVIEW_ROWS,
  type XlsxCell,
  type XlsxMerge,
  type XlsxPreview,
  type XlsxSheet,
} from "../../shared/xlsx.ts";

export interface XlsxReadOptions {
  /** 要看哪一张表（0-based，越界夹到范围内）；不给 = 第一张 */
  sheet?: number;
  /** 以下三个只为测试注入小上限，生产路径用契约常量 */
  limit?: number;
  maxRows?: number;
  maxCols?: number;
}

/** zip 的本地文件头（真正的 .xlsx 是 OOXML = zip 容器） */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** OLE2 复合文档头：加密的 .xlsx 与旧版 .xls 都长这样 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * ExcelJS 的 `_merges`（master 地址 → Range）。**用私有字段是有意的**：公开的
 * `worksheet.model.merges` 会先把每一行每一格序列化成 model，20000 行的工作簿上
 * 比整份解析还慢；而 `_merges` 在 4.4.0（本仓精确锁的版本）里就是 Range 字典。
 * 取不到就当没有合并区——合并区画不出来是遗憾，读不动整份表是故障。
 */
interface MergeRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface WorksheetInternals {
  _merges?: Record<string, MergeRange>;
}

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 文件头是不是指定的那几个字节（文件比 magic 短就当不是） */
async function startsWith(path: string, magic: readonly number[]): Promise<boolean> {
  const buffer = Buffer.alloc(magic.length);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, magic.length, 0);
    if (bytesRead < magic.length) return false;
  } finally {
    await handle.close();
  }
  return magic.every((byte, index) => buffer[index] === byte);
}

/** 百分比格式里小数点后的位数；不是百分比格式回 null */
function percentDecimals(numFmt: string | undefined): number | null {
  if (numFmt === undefined || !numFmt.includes("%")) return null;
  const section = numFmt.split(";")[0] ?? "";
  const match = /^[^%]*?0(?:\.(0+))?%/.exec(section);
  if (match === null) return null;
  return match[1]?.length ?? 0;
}

/**
 * 数字的显示文本。整数值原样；小数值按 15 位有效数字收掉浮点噪声（`0.1+0.2` 那种
 * `0.30000000000000004` 不是表里的数）。百分比格按格式还原成 12.34%。
 */
function numberText(value: number, numFmt: string | undefined): string {
  const decimals = percentDecimals(numFmt);
  if (decimals !== null) return `${(value * 100).toFixed(decimals)}%`;
  return String(Number(value.toPrecision(15)));
}

/**
 * 日期：Excel 的日期格是**墙钟时间**，ExcelJS 把它塞在 Date 的 UTC 字段里（实测：
 * 表里写 2024-03-05 14:30，读回来是 `2024-03-05T14:30:00.000Z`，本地时区是 +08 时
 * `getHours()` 会给 22:30）。所以必须用 `getUTC*` 读，用本地 getter 会把每个日期按
 * 时区平移——UTC+8 上全体 +8 小时，连「整天」的日期都会变成 08:00。
 * 整天的不带时分。
 */
function dateText(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  if (hours === 0 && minutes === 0) return day;
  return `${day} ${pad(hours)}:${pad(minutes)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** 公式格的缓存结果（`result` 可能是数字 / 字符串 / 布尔 / 日期 / 错误值，也可能缺席） */
function formulaResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("formula" in value || "sharedFormula" in value) return value["result"];
  return value;
}

/** 一格值的显示文本；空串表示「这格没内容」（调用方据此给 null） */
function valueText(value: unknown, numFmt: string | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return numberText(value, numFmt);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return dateText(value);
  if (isRecord(value)) {
    // 错误值在 Cell 上会自己转成 "#DIV/0!" 文本；这里只兜底不是公式模型的几种
    if ("error" in value) return String(value["error"]);
    if ("richText" in value && Array.isArray(value["richText"])) {
      return value["richText"]
        .map((run) => (isRecord(run) && typeof run["text"] === "string" ? run["text"] : ""))
        .join("");
    }
    if ("text" in value && typeof value["text"] === "string") return value["text"];
  }
  return String(value);
}

/**
 * 一格的预览形态。公式格优先显示缓存值（与 Excel 打开时看到的一致），公式原文
 * 放进 `formula` 走 tooltip；没有缓存值的公式（Excel 没算过就存盘）文字留空，
 * 但 `formula` 仍然带出去，面板 hover 才看得到它算的是什么。
 */
function cellPreview(cell: ExcelJS.Cell): XlsxCell | null {
  const raw = cell.value;
  if (raw === null || raw === undefined) return null;
  const result = formulaResult(raw);
  // 未缓存结果的公式：result 缺席时 valueText 回空串，公式文本单独带出去
  const text = valueText(result, cell.numFmt);
  const formula = typeof cell.formula === "string" && cell.formula !== "" ? cell.formula : undefined;
  if (text === "" && formula === undefined) return null;
  const preview: XlsxCell = { text };
  if (formula !== undefined) preview.formula = formula;
  if (typeof result === "number") preview.numeric = true;
  if (isRecord(result) && "error" in result) preview.error = true;
  return preview;
}

/**
 * 合并区裁到窗口内：整段落在窗口外的丢掉，跨边界的截到边界（左上角不在窗口里
 * 的合并块只剩被盖住的部分——那种块没有锚点可画，也丢掉）。
 */
function clippedMerges(worksheet: ExcelJS.Worksheet, shownRows: number, shownCols: number): XlsxMerge[] {
  const internals = worksheet as unknown as WorksheetInternals;
  const merges = Object.values(internals._merges ?? {});
  const clipped: XlsxMerge[] = [];
  for (const merge of merges) {
    const top = merge.top - 1;
    const left = merge.left - 1;
    if (top < 0 || left < 0 || top >= shownRows || left >= shownCols) continue;
    const bottom = Math.min(merge.bottom, shownRows) - 1;
    const right = Math.min(merge.right, shownCols) - 1;
    if (bottom <= top && right <= left) continue;
    clipped.push({ top, left, bottom, right });
  }
  return clipped;
}

/** 冻结窗格：Excel 的视图里被标题占住的前 n 行 / 前 n 列 */
function frozenOf(worksheet: ExcelJS.Worksheet): { rows: number; cols: number } {
  // 没设过视图的表（新建 / 空表）views 是 undefined，不是空数组
  const views = Array.isArray(worksheet.views) ? worksheet.views : [];
  for (const view of views) {
    if (view.state === "frozen") return { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 };
  }
  return { rows: 0, cols: 0 };
}

/** 一张表的可预览形态：计数是整表的，数据裁到 maxRows × maxCols */
function buildSheet(worksheet: ExcelJS.Worksheet, maxRows: number, maxCols: number): XlsxSheet {
  // 用 rowCount / columnCount 而不是 dimensions：后者的 Range getter 是 `model.bottom || 1`，
  // 空表会报成 1 行 1 列（把空表画成一个空格）
  const rowCount = worksheet.rowCount;
  const colCount = worksheet.columnCount;
  const shownRows = Math.min(rowCount, maxRows);
  const shownCols = Math.min(colCount, maxCols);
  const merges = clippedMerges(worksheet, shownRows, shownCols);

  // 合并区里被左上角盖住的格子输出 null：跨行跨列由锚点那格画，其余位置不能再画一遍
  const covered = new Set<number>();
  for (const merge of merges) {
    for (let row = merge.top; row <= merge.bottom; row++) {
      for (let col = merge.left; col <= merge.right; col++) {
        if (row !== merge.top || col !== merge.left) covered.add(row * shownCols + col);
      }
    }
  }

  const rows: (XlsxCell | null)[][] = [];
  for (let rowNumber = 1; rowNumber <= shownRows; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const cells: (XlsxCell | null)[] = [];
    for (let colNumber = 1; colNumber <= shownCols; colNumber++) {
      if (covered.has((rowNumber - 1) * shownCols + (colNumber - 1))) {
        cells.push(null);
        continue;
      }
      cells.push(cellPreview(row.getCell(colNumber)));
    }
    rows.push(cells);
  }

  return {
    name: worksheet.name,
    rowCount,
    colCount,
    merges,
    frozen: frozenOf(worksheet),
    rows,
  };
}

/**
 * 读一份 .xlsx 的可预览结构。调用方（ipc.ts）已过白名单并确认 `.xlsx` 扩展名。
 *
 * 读不了的文件**不抛错**，回 `unreadable`：文件内容是用户的东西，说清是「太大 /
 * 有密码 / 坏了」比抛一句英文异常有用得多。抛错的只有「这不是一个文件」这类
 * 调用方的错。
 */
export async function readXlsxPreview(path: string, options: XlsxReadOptions = {}): Promise<XlsxPreview> {
  const limit = options.limit ?? XLSX_MAX_BYTES;
  const maxRows = options.maxRows ?? XLSX_PREVIEW_ROWS;
  const maxCols = options.maxCols ?? XLSX_PREVIEW_COLS;
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  const size = stats.size;
  const modifiedAt = stats.mtimeMs;
  if (size > limit) return { kind: "too-large", limit, size, modifiedAt };

  if (await startsWith(path, OLE2_MAGIC)) {
    return { kind: "unreadable", reason: "password", detail: "OLE2 container (encrypted workbook or legacy .xls)", size, modifiedAt };
  }
  if (!(await startsWith(path, ZIP_MAGIC))) {
    return { kind: "unreadable", reason: "corrupt", detail: "Not a zip container — not an .xlsx file", size, modifiedAt };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path);
  } catch (cause) {
    return { kind: "unreadable", reason: "corrupt", detail: failMessage(cause), size, modifiedAt };
  }

  // 隐藏表（hidden / veryHidden）不上标签、不读数据：用户在 Excel 里把一张表藏起来，
  // 就是不想它出现在眼前；预览不能把它俩又摊开。下标也只数可见的那几张。
  const worksheets = workbook.worksheets.filter((worksheet) => (worksheet.state ?? "visible") === "visible");
  const first = worksheets[0];
  if (first === undefined) {
    // 没有任何可见工作表：可能是只有图表页（chartsheet），也可能全部被隐藏
    return {
      kind: "unreadable",
      reason: workbook.worksheets.length === 0 ? "corrupt" : "hidden",
      detail:
        workbook.worksheets.length === 0
          ? "The workbook has no worksheet"
          : `All ${workbook.worksheets.length} worksheets are hidden`,
      size,
      modifiedAt,
    };
  }
  // 请求里的表号可能是 NaN / 小数 / 负数（renderer 传什么都不信）：夹成范围内的整数
  const requested = options.sheet ?? 0;
  const index = Number.isFinite(requested) ? Math.trunc(requested) : 0;
  const active = Math.min(Math.max(index, 0), worksheets.length - 1);
  const target = worksheets[active] ?? first;
  return {
    kind: "workbook",
    sheets: worksheets.map((worksheet) => ({ name: worksheet.name })),
    sheet: buildSheet(target, maxRows, maxCols),
    active,
    size,
    modifiedAt,
  };
}
