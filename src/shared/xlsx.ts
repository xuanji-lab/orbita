/**
 * `.xlsx` 的契约 —— IPC 四层的第 1 层（契约与实做同一次提交）。
 *
 * **读**：只回答两件事——这张表里**有什么数据**（裁剪到上限的二维值），以及**这份
 * 工作簿有哪些表**。不做排版（HTML 表没有列宽 / 颜色 / 冻结窗格，照它画出来用户
 * 会以为原文件坏了），排版靠 Excel / WPS——「用默认应用打开」那个按钮。
 *
 * **写**（2026-11-22 起）：只改**格子里的值 / 公式**，坐标 1-based（与 A1 写法一致），
 * 一次调用是一批（一次保存 = 一批）。写回在内核里只动目标单元格的 XML，其它 zip 部件
 * 一个字节不改（见 `main/xlsx/edit.ts` 顶注释），所以样式、合并区、列宽、冻结窗格、
 * 条件格式、数据验证、图片都不在「可能被改坏」的范围里。
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
      /**
       * 这份工作簿是**按兼容模式**读出来的：解析失败后去掉 OOXML 的 `x:` 前缀重试成功
       * （OfficeCLI 重写过的文件带前缀，ExcelJS 4.4.0 不认）。原文件一个字节没动。
       * 界面据此标一句「由 Office 工具重写过，已按兼容模式读取」。
       */
      normalized?: true;
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

/** 面板一次最多显示的行 / 列数（见文件顶注释）。**也是可编辑窗口**：写回只认这块范围 */
export const XLSX_PREVIEW_ROWS = 2000;
export const XLSX_PREVIEW_COLS = 50;

/**
 * 一次写回里的一格改动。
 *
 * 坐标是 **1-based**（`row: 1, col: 1` 就是 A1）：写回要从 A1 写法反推格子，面板的
 * 公式栏与行号列标也都在说 1-based，中间再换一次坐标系只会多一处 off-by-one。
 * `sheet` 是**表名**（标签页上写的就是它），不是下标——下标会随表被删 / 藏而漂移。
 */
export interface XlsxCellEdit {
  sheet: string;
  row: number;
  col: number;
  /**
   * 字面值：数字按数字写、字符串按内联字符串写、**null = 清空这格**（保留样式）。
   * 给了 `formula` 就忽略它（公式优先）。
   */
  value?: string | number | null;
  /** 公式原文（带不带前导 `=` 都行）。写进去的格**不会重算**：盘上没有缓存值 */
  formula?: string;
  /**
   * 改动清单里「旧值」的显示文本（写回**不用它**，内核也不看它）。只有做这次改动的那
   * 一侧知道用户当时看到的是什么，所以由面板带上来；省略 = 不知道旧值
   */
  before?: string | null;
}

/** 写前比对的文件指纹：预览回执里的 `modifiedAt` + `size`，原样交回来 */
export interface XlsxFingerprint {
  mtimeMs: number;
  size: number;
}

/** `fs:write-xlsx` 的请求：白名单字段同 fs:read；`expected` 缺席 = 不比对指纹 */
export interface XlsxWriteRequest extends FileListRequest {
  /**
   * 预览时看到的指纹。写前重新 stat，对不上就回 `conflict`、**一个字节都不写**——
   * 这样 agent 的 `edit_office` 改过同一份文件时，人这边的未保存改动会被闸住。
   */
  expected?: XlsxFingerprint;
  edits: XlsxCellEdit[];
}

/**
 * 写回的回执。**每种拒绝都是结构化结论**而不是异常：界面要按它说人话（冲突给
 * 「重新加载」、越界说清可编辑范围），异常只剩「这不是一个文件」这类调用方的错。
 */
export type XlsxWriteResult =
  | {
      kind: "ok";
      /** 真正写进去的格数（同一格给了多次只算一次，后给的覆盖先给的） */
      cells: number;
      /** 写完之后的盘上指纹（下一次保存拿它当 expected） */
      size: number;
      modifiedAt: number;
    }
  /** 文件在外部被改过（mtime / size 变了）：没写盘，界面提示刷新 */
  | { kind: "conflict"; size: number; modifiedAt: number }
  /** 超出可编辑窗口（行列给的是 1-based；规则见 XLSX_PREVIEW_ROWS / COLS） */
  | { kind: "out-of-window"; rows: number; cols: number; edits: XlsxCellEdit[] }
  | { kind: "too-large"; limit: number; size: number }
  /**
   * 读不开：password（加密 / 旧版 .xls）、corrupt（不是 zip / XML 坏了）、
   * sheet-missing（表被改名或删了——`sheets` 是现在的表名）
   */
  | {
      kind: "unreadable";
      reason: "password" | "corrupt" | "sheet-missing";
      detail: string;
      sheets?: string[];
    }
  /**
   * 这格是**共享公式的组长**（`<f t="shared" ref="…">`），而这次要往它里面写值 / 清空：
   * 组长一没了定义，整组引用它的成员格就全废了。写公式进去不受影响（组的定义还在）。
   * 拒绝比悄悄改坏别处的公式好——界面上说清「先在 Excel 里改它」。
   */
  | { kind: "shared-formula"; sheet: string; row: number; col: number; detail: string }
  /** 其它没料到的失败（临时文件写不了、rename 被占用 …）：原文件没动 */
  | { kind: "failed"; error: string };

/** 本面板认的表格格式。只认 .xlsx：.xls（旧二进制格式）、.xlsm、ods 都不进这条通道 */
export function isXlsxFile(path: string): boolean {
  return /\.xlsx$/i.test(path);
}

/** 旧版二进制工作簿（.xls）：预览不了，面板要明说而不是当普通二进制文件 */
export function isLegacyXlsFile(path: string): boolean {
  return /\.xls$/i.test(path);
}
