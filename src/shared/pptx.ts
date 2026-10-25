/**
 * `.pptx` 只读大纲预览的契约 —— IPC 四层的第 1 层（契约与实做同一次提交）。
 *
 * **不做渲染、不做缩略图**：没有可靠的纯 JS pptx 渲染器（`officeparser` 要拖进
 * 31 MB + tesseract；`pptx-glimpse` 自己声明不承诺与 PowerPoint 一致；`pptx-preview`
 * 闭源付费），照 HTML 硬画一版用户会以为原文件坏了。这里只回答「这份演示文稿有哪几页、
 * 每页讲了什么」：页序、版式名、标题、正文段落层级、表格、备注。真正的排版交给
 * PowerPoint / WPS ——「用默认应用打开」那个按钮。
 *
 * 样式继承（layout → master → theme）第一版不做：字号、颜色、项目符号的最终形态
 * 都要沿三层链求值，读错了比不读更误导。这里只认 `slideN.xml` 里**显式**写的
 * 层级（`a:pPr/@lvl`）与项目符号（`a:buChar` / `a:buNone` / `a:buAutoNum`）。
 */
import type { FileListRequest } from "./files.ts";

/**
 * 正文里的一个段落。`level` 是 PowerPoint 的缩进层级（0–8），渲染层据此缩进；
 * `bullet` 是「这里有一个项目符号」——显式的 `a:buChar` / `a:buAutoNum`，或正文
 * 占位符里没写 `a:buNone`（PowerPoint 的正文默认带符号，纯文本框默认不带）。
 */
export interface PptxParagraph {
  level: number;
  text: string;
  bullet: boolean;
}

/** 一张表：行优先的单元格文字（单元格里的多段文字用换行连起来） */
export interface PptxTable {
  rows: string[][];
}

export interface PptxSlide {
  /** 页序，1-based（与 PowerPoint 的「第 N 页」一致） */
  number: number;
  /** 版式名（`slideLayout` 的 `cSld/@name`）；读不到时是空串，界面只显示页码 */
  layoutName: string;
  /** 标题占位符（`ph type="title" | "ctrTitle"`）的文字；没有标题时是空串 */
  title: string;
  /** 正文段落（按原文顺序，含多级缩进） */
  body: PptxParagraph[];
  /** 这页上的表格，按文档顺序 */
  tables: PptxTable[];
  /** 演讲者备注的纯文字（跳过页码 / 页脚 / 日期占位符）；没有备注时是空串 */
  notes: string;
  /** 图片数量：只报数，让「这页为什么没有文字」有个诚实的解释 */
  pictureCount: number;
  /** 这一页的文字超过了单页上限，已截断 */
  truncated: boolean;
}

/**
 * `fs:read-pptx` 的回执。三种非数据状态都是**可读的结论**而不是异常：文件内容是
 * 用户的东西，读不动要说清是哪种读不动（太大 / 有密码 / 坏了），渲染层按 reason
 * 说人话，`detail` 只作技术副行。
 */
export type PptxPreview =
  | {
      kind: "deck";
      /** 解析出的页（最多 `PPTX_MAX_SLIDES` 页，按页序） */
      slides: PptxSlide[];
      /** 整份演示文稿的页数（没被上限裁掉的真实页数） */
      slideCount: number;
      /** 页数超过上限、只解析了前 `PPTX_MAX_SLIDES` 页 */
      truncated: boolean;
      size: number;
      modifiedAt: number;
    }
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number }
  | {
      kind: "unreadable";
      /** password：OLE2 容器（加密演示文稿，或旧版 .ppt 改了后缀）；corrupt：解不开的 zip / 缺件 / 坏的 XML */
      reason: "password" | "corrupt";
      /** 技术细节（异常原文），渲染层只在副行里给，不指望它可读 */
      detail: string;
      size: number;
      modifiedAt: number;
    };

/** `.pptx` 预览上限（50 MB）：与 xlsx 同口径，再大的包解压进内存不划算 */
export const PPTX_MAX_BYTES = 50 * 1024 * 1024;

/** 一次最多解析多少页（再多就不是「大纲」而是整本报告了） */
export const PPTX_MAX_SLIDES = 300;

/** 单页文字上限：投影片本来就不该有大段文字，超出的部分对大纲没有价值 */
export const PPTX_SLIDE_TEXT_LIMIT = 2000;

/** 本面板认的演示文稿格式。只认 .pptx：.ppt（旧二进制格式）、.key、.odp 都不进这条通道 */
export function isPptxFile(path: string): boolean {
  return /\.pptx$/i.test(path);
}

/** 旧版二进制演示文稿（.ppt）：预览不了，面板要明说而不是当普通二进制文件 */
export function isLegacyPptFile(path: string): boolean {
  return /\.ppt$/i.test(path);
}

/** `fs:read-pptx` 的请求：与 fs:read 完全相同（页序由文件自己决定，没有可选参数） */
export type PptxReadRequest = FileListRequest;
