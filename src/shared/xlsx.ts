/**
 * `.xlsx` 只读预览的契约 —— IPC 四层的第 1 层（契约与实做同一次提交）。
 *
 * **只读，不做编辑**，也**不做应用内表格渲染**（HTML 表没有列宽 / 颜色 / 冻结窗格，
 * 照它画出来用户会以为原文件坏了）。这里只回答两件事：这张表里**有什么数据**
 * （裁剪到上限的二维值），以及**这份工作簿有哪些表**。真正的排版靠 Excel / WPS
 * ——「用默认应用打开」那个按钮。
 *
 * 数值与文字分开：`text` 是显示值（公式取缓存值，与 Excel 打开时看到的一致），
 * `formula` 是公式原文（只在 tooltip 里出现），`numeric` 让渲染层右对齐 + 等宽数字。
 *
 * 上限是**面板的尺度，不是文件的尺度**：20 万行的表也照常打开，只喂前 2000 行 ×
 * 50 列进来（`rowCount` / `colCount` 仍是整表的数，面板据此如实标「已截断」）。
 */
import type { FileListRequest } from "./files.ts";

/**
 * 一个非空单元格。空单元格在 `rows` 里是 null（合并区里被盖住的那些也是 null），
 * 渲染层据此画空格 / 让位给左上角的跨行跨列格。
 */
export interface XlsxCell {
  /** 显示值：公式取缓存值（与 Excel 一致），数值按纯数字、百分比按 numFmt 还原 */
  text: string;
  /** 公式原文，不带前导 `=`（ExcelJS 的 `cell.formula`）；非公式格没有 */
  formula?: string;
  /** 数值（含公式算出的数值）：渲染层右对齐、等宽数字 */
  numeric?: boolean;
  /** 错误值（`#DIV/0!` 这类）：渲染层用危险色——它不是数据，是坏掉的公式 */
  error?: boolean;
}

/** 合并区间：0-based，含端点，与 `rows` 的下标同一套坐标 */
export interface XlsxMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 工作簿里的一张表（标签页只需要名字；计数与合并区只给当前打开的那张） */
export interface XlsxSheetTab {
  name: string;
}

export interface XlsxSheet {
  name: string;
  /** 整份表用到的行 / 列数（不是裁剪后的）；空表为 0 */
  rowCount: number;
  colCount: number;
  /** 合并区间，已裁到返回的窗口内：窗口外的整段丢掉，跨窗口边界的截到边界 */
  merges: XlsxMerge[];
  /** 冻结窗格：Excel 里被标题占住的前 n 行 / 前 n 列。**只作提示**，预览不冻结滚动 */
  frozen: { rows: number; cols: number };
  /** 裁剪后的二维数据：`rows[r][c]`，行优先，空单元格为 null */
  rows: (XlsxCell | null)[][];
}

/**
 * `fs:read-xlsx` 的回执。三种非数据状态都是**可读的结论**而不是异常：文件内容是
 * 用户的东西，读不动要说清是哪种读不动（太大 / 有密码 / 坏了），渲染层按 reason
 * 说人话（文案在 messages 表里），`detail` 只作技术副行。
 */
export type XlsxPreview =
  | {
      kind: "workbook";
      /** 全部工作表的名字，按工作簿顺序（标签页） */
      sheets: XlsxSheetTab[];
      /** 请求的那张表（`sheet` 超范围时夹到第一张 / 最后一张），`active` 是它的下标 */
      sheet: XlsxSheet;
      active: number;
      size: number;
      modifiedAt: number;
    }
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number }
  | {
      kind: "unreadable";
      /**
       * password：OLE2 容器（加密工作簿，或旧版 .xls 改了后缀）；corrupt：解不开的 zip / 坏的 XML；
       * hidden：工作簿里没有任何**可见**工作表（全部被隐藏，或只有图表页）
       */
      reason: "password" | "corrupt" | "hidden";
      /** 技术细节（异常原文），渲染层只在副行里给，不指望它可读 */
      detail: string;
      size: number;
      modifiedAt: number;
    };

/** `fs:read-xlsx` 的请求：白名单字段与 fs:read 完全相同，只多一个「看第几张表」 */
export interface XlsxReadRequest extends FileListRequest {
  /** 工作表下标（0-based）；不给 = 第一张 */
  sheet?: number;
}

/** `.xlsx` 预览上限（50 MB）：再大的工作簿整份解压进内存会拖垮主进程 */
export const XLSX_MAX_BYTES = 50 * 1024 * 1024;

/** 面板一次最多显示的行 / 列数（见文件顶注释） */
export const XLSX_PREVIEW_ROWS = 2000;
export const XLSX_PREVIEW_COLS = 50;

/** 本面板认的表格格式。只认 .xlsx：.xls（旧二进制格式）、.xlsm、ods 都不进这条通道 */
export function isXlsxFile(path: string): boolean {
  return /\.xlsx$/i.test(path);
}

/** 旧版二进制工作簿（.xls）：预览不了，面板要明说而不是当普通二进制文件 */
export function isLegacyXlsFile(path: string): boolean {
  return /\.xls$/i.test(path);
}
