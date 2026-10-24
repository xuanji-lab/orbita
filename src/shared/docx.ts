/**
 * 应用内 docx 轻量编辑的契约 —— IPC 四层的第 1 层。
 *
 * 范围（v1，issue #273）：在文件面板里打开 .docx、改字、粗/斜/下划线、撤销/重做、
 * 保存。表格 / 图片 / 批注 / 修订 / 查找替换 / 页眉页脚 / 样式管理器 / 域编辑都不做，
 * 留给后续 PR。渲染与编辑全部交给 `@stll/folio`（Apache-2.0），本仓只负责：
 * 读字节、读之前判大小与完整性、保存时判冲突、原子写、留上一版备份。
 *
 * **白名单与 fs:read 同一道**：请求形状就是 `FileListRequest`（root / dir / 额外预览根），
 * 主进程用同一个 `resolveFileRoots` + `whitelistedPath` 现算，这条通道不能变成
 * 「读写任意文件」。判据用 realpath 之后的路径：改名成 foo.docx 的软链接指向别的
 * 类型同样被拒。
 */
import type { FileListRequest } from "./files.ts";

/**
 * 打开上限（50 MB）。比它大的文档不让 renderer 去解析：整份解析 + 分页 + 编辑的
 * 内存与主线程开销都在 renderer 里，撞上就是「面板卡死」而不是「慢一点」。
 * 超限如实返回 too-large，面板给「用默认应用打开」。
 */
export const DOCX_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 页数上限（500 页）。页数是渲染之后才知道的（分页由引擎按版式算），所以打开后
 * 由 renderer 读 `getTotalPages()` 判：超过就整份转只读并提示，不再自动保存——
 * 编辑几百页的文档会让输入延迟肉眼可见，那不是这一刀要解决的问题。
 */
export const DOCX_MAX_PAGES = 500;

/**
 * 停手多久自动保存（1.5 s）。与文件域其它自动保存同一条纪律：不抢用户每一次敲键，
 * 也不能让改动在后台悄悄滞留。
 */
export const DOCX_AUTOSAVE_DELAY_MS = 1500;

/**
 * 一页大约装多少段（Word 默认版式、正文 12pt 量级）。只在**挂载引擎之前**粗估页数时用：
 * 精确页数只有排完版才知道，而排版 800 页的文档会把面板冻住两分钟（实测 828 页的
 * 样本要 125 s）——所以这里宁可用一个粗估数先把「这份文档不该在应用内打开」说出来。
 */
const PARAGRAPHS_PER_PAGE = 40;

/**
 * 主进程从包里数出来的两件事：段落数（`w:p`）与显式分页符（`w:br w:type="page"`）。
 * 表格单元格里的段落也算段落——粗估页数不需要区分。
 */
export interface DocxPackageStats {
  paragraphs: number;
  pageBreaks: number;
}

/** 挂载前的页数粗估：显式分页符 +1 与「段落数 ÷ 每页段数」取大者 */
export function estimateDocxPages(stats: DocxPackageStats): number {
  return Math.max(stats.pageBreaks + 1, Math.ceil(stats.paragraphs / PARAGRAPHS_PER_PAGE));
}

export function isDocxFile(path: string): boolean {
  return /\.docx$/i.test(path);
}

/** docx 的读写请求：形状与 `fs:read` 完全一致（root/dir 白名单同一道） */
export type DocxTarget = FileListRequest;

/**
 * 打不开的原因：`password` 是加密包（OLE2 容器），`not-docx` 不是 zip，`corrupt` 是
 * zip 里没有正文，`missing` 是文件在打开这一刻已经不在了（外部删除 / 改名——
 * 同一份文档可能正开着编辑器，用户在别处把它删了，再点刷新）。
 */
export type DocxInvalidReason = "password" | "not-docx" | "corrupt" | "missing";

/**
 * `docx:open` 的回执。`data` 是整份字节（Uint8Array 走结构化克隆，不转 base64），
 * `hash` 是这一份磁盘内容的 sha256 —— 保存时回传它，主进程拿磁盘现状比对，
 * 不一致就拒绝覆盖（冲突而不是覆盖）。
 */
export type DocxOpenResult =
  | {
      kind: "docx";
      data: Uint8Array;
      size: number;
      modifiedAt: number;
      hash: string;
      /** 挂载前的页数粗估依据（见 estimateDocxPages） */
      stats: DocxPackageStats;
    }
  /** 超过 DOCX_MAX_BYTES：不读内容，面板给「用默认应用打开」 */
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number }
  | { kind: "invalid"; reason: DocxInvalidReason; size: number; modifiedAt: number };

export interface DocxSaveRequest {
  target: DocxTarget;
  /** 打开（或上次保存）时那份磁盘内容的 hash；与磁盘现状不一致 = 冲突 */
  expectedHash: string;
  /** 引擎序列化出来的整份 docx */
  data: Uint8Array;
}

/**
 * `docx:save` 的回执。**冲突是值不是异常**：外部改了文件是正常会发生的事，
 * renderer 要拿它弹出「重新加载 / 放弃保存」，不能走 catch 混进「保存失败」。
 */
export type DocxSaveResult =
  /**
   * 写入成功。`backupPath` 是上一版被复制到应用数据目录的位置（首次保存 / 磁盘上
   * 原本没有文件时是 null）；`hash` 是新内容的 hash，renderer 拿它做下一次的 expectedHash。
   */
  | { kind: "saved"; size: number; modifiedAt: number; hash: string; backupPath: string | null }
  /** 磁盘内容与 expectedHash 不一致（`missing` = 文件在外部被删了）：一个字节都没写 */
  | { kind: "conflict"; reason: "changed" | "missing"; modifiedAt: number | null };
