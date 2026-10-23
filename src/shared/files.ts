/**
 * 文件面板契约 —— IPC 四层的第 1 层（文件系统 2026-09-22 裁决）。
 *
 * 面板回答「这条会话的 agent 能去哪、里面有什么」。根有三种来源，顺序固定：
 *   session    本会话工作台 `<userData>/workbenches/<id>/`（唯一随会话变的根，排最前）
 *   workspace  工作区文件夹（cwd；Home 会话是 `~/Orbita/Home`）
 *   attached   工作区挂的附加目录，按用户挂上的顺序
 *   attachments 本会话已发送附件的副本目录 `sessions/<id>.attachments/`——**不进树**，
 *               只为白名单：拖进来的外部文件发送时复制到这里（不在上面三根之内），
 *               没有它，附件列表与 PDF 引用都打不开这份副本
 *
 * **renderer 侧 IPC 有白名单，agent 工具面没有**——两者不冲突：工具面「只告知」是
 * 关于模型的（Q2）；这里的白名单是关于 renderer 的：sandbox 里的 renderer 只能列
 * 主进程算出来的这几个根之内的路径，不能拿这条通道当通用文件浏览器。
 */

import { pathTail } from "./path.ts";

export type FileRootKind = "session" | "workspace" | "attached" | "attachments";

export interface FileRoot {
  kind: FileRootKind;
  /** 面板上显示的名字：session 是会话标题、workspace 是工作区名、attached 是路径末段 */
  label: string;
  /** 绝对路径，也是 `fs:list` 的 root 参数 */
  path: string;
  /**
   * 目录此刻存不存在。session 根常为 false（工作台首次写入才建），面板显示一行占位；
   * attached 根为 false 说明用户把目录挪走了，面板要如实标出而不是静默空列表。
   */
  exists: boolean;
}

export type FileEntryKind = "file" | "directory" | "symlink" | "other";

export interface FileEntry {
  name: string;
  kind: FileEntryKind;
  /** 文件的字节数；目录 / 其他类型不带 */
  size?: number;
  /** mtime，Unix 毫秒 */
  modifiedAt: number;
}

/**
 * `fs:roots` 的请求：主进程按 workspaceId 找工作区（null = Home）、按 sessionId 派生工作台。
 * sessionId 为 null = 还没有会话（新任务没发首条消息，id 尚未铸）：不出 session 根，其余照常。
 */
export interface FileRootsRequest {
  sessionId: string | null;
  workspaceId: string | null;
  /**
   * 专注 / 浏览态的**只读预览根**：左栏正在看的工作区（专注中双击左栏文件树，
   * 文件面板要能预览它——而面板的根跟着当前会话走，不一定包含这个工作区）。
   * **主进程从 WorkspaceStore 按 id 解路径**，renderer 只传 id、从不传路径——
   * 白名单的边界一寸不放宽：多出来的根 = 存储里真实存在的工作区目录本身。
   * 与 workspaceId 相同时不重复出根。缺席 / 指到不存在的 id = 没有额外根。
   */
  extraWorkspaceId?: string | null;
}

/**
 * `fs:list` 的请求。`dir` 必须落在 `root` 之内（realpath 后判前缀），否则主进程拒绝；
 * `root` 必须是 `fs:roots` 回过的路径之一——两道都在主进程，renderer 传什么都不信。
 */
export interface FileListRequest {
  sessionId: string | null;
  workspaceId: string | null;
  root: string;
  dir: string;
  /**
   * 同 FileRootsRequest.extraWorkspaceId：这次列目录 / 读文件 / 预览的额外预览根。
   * 白名单在主进程按同一份 resolveFileRoots 现算（fs:list / fs:read / fs:read-pdf /
   * fs:open 共用），带着它，落在该工作区内的路径才放行。
   */
  extraWorkspaceId?: string | null;
}

/** `fs:list` 的回执：目录在前、同类按名字（locale、大小写不敏感）排；`.` 开头的照列，面板自己决定显不显 */
export interface FileListResponse {
  dir: string;
  entries: FileEntry[];
}

/** 目录排前、同类按名字。**排序在主进程做**：面板每次展开都得到同一顺序，与 skill 列表按 slug 排序同一理由 */
export function sortFileEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = (entry: FileEntry): number => (entry.kind === "directory" ? 0 : 1);
  return [...entries].sort(
    (a, b) =>
      rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  );
}

/**
 * 面板上一个根分组的名字：session / workspace 用传入的标题，attached 用路径末段。
 * 空标题（会话还没命名）退回 fallback，不留空行。
 */
export function fileRootLabel(kind: FileRootKind, path: string, title: string, fallback: string): string {
  if (kind === "attached" || kind === "attachments") {
    const last = pathTail(path);
    return last === "" ? path : last;
  }
  return title.trim() === "" ? fallback : title.trim();
}

/**
 * 文件预览（`fs:read` 的回执）。**读成什么由主进程判**：扩展名是图片 → 读成 base64；
 * 否则看开头有没有 NUL 字节——没有就当文本（`LICENSE`、`Makefile`、`.env` 这类没有
 * 扩展名的文本也能看），有就是二进制、不读内容。怎么排版（markdown 渲染 / 代码高亮 /
 * 等宽原文）是 renderer 按文件名决定的事，不在契约里。
 *
 * 与 fs:list 同一道白名单：root 必须是 fs:roots 回过的、路径 realpath 后必须在 root 之内——
 * 指向根外的 symlink 同样被拒，预览通道不能变成读任意文件的后门。
 */
export type FilePreview =
  /** `truncated`：文件比 PREVIEW_TEXT_LIMIT 大，只读了开头那一段（面板要如实标出） */
  | { kind: "text"; text: string; truncated: boolean; size: number; modifiedAt: number }
  /** 图片：`mime` 由扩展名定（Chromium 的 <img> 画得了的那几种），`base64` 不带 data: 前缀 */
  | { kind: "image"; mime: string; base64: string; size: number; modifiedAt: number }
  /** 二进制（开头有 NUL 字节，或是 Chromium 画不了的图片格式）：不读内容，面板给「用默认应用打开」 */
  | { kind: "binary"; size: number; modifiedAt: number }
  /** 图片比 PREVIEW_IMAGE_LIMIT 大：不读，同样给「用默认应用打开」 */
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number };

/**
 * 编辑器写盘（`fs:write`）的请求。`dir` 是文件绝对路径，白名单与 fs:read 同一道
 * （root 必须是 fs:roots 回过的、路径 realpath 后必须在 root 之内）。
 *
 * `expectedHash` 是编辑器最后一次读到 / 写成功时那份磁盘文本的指纹（contentHash）：
 * 主进程**写前重读一次**，指纹对不上就是「编辑期间被外部改过」——回 conflict，不动盘。
 * 用内容指纹而不是 mtime，是为了让「自身保存」和「外部原样重写」都不算冲突（mtime 会变，
 * 内容没变）；也避开 Windows / 网络盘 mtime 粒度与时钟偏差。**null = 用户已明确选择
 * 「保留我的」**：跳过冲突检查直接写（这是唯一的强制覆盖入口，界面上要有对应的动作）。
 */
export interface FileWriteRequest extends FileListRequest {
  text: string;
  expectedHash: string | null;
}

/**
 * `fs:write` 的回执。
 * - written：已落盘，回新的指纹与 mtime（调用方据此刷新「已保存」基线）
 * - conflict：盘上内容与 expectedHash 不符，**没有写**；回当前全文供「重新加载」直接用，
 *   省一次 fs:read（也避免两次读之间又变了一次）
 * - too-large：超过编辑器写盘上限，不写（这种文件本来也不该在编辑器里打开）
 */
export type FileWriteResult =
  | { kind: "written"; modifiedAt: number; hash: string; size: number }
  | { kind: "conflict"; text: string; modifiedAt: number; hash: string; size: number }
  | { kind: "too-large"; limit: number; size: number };

/** 编辑器写盘上限（4 MB）：比文本预览上限宽松（预览只读开头，写盘是全量回写），但仍有界 */
export const EDITOR_WRITE_LIMIT = 4 * 1024 * 1024;

/**
 * 内容指纹（FNV-1a 的两个 32 位变体拼成 16 位十六进制）。**只用于「盘上内容还是不是
 * 编辑器手里那份」的相等判定**，不是安全哈希：没有对手会构造碰撞，2^-64 的偶然碰撞
 * 概率远低于其它失效模式。两端共用同一函数（renderer 侧算基线、主进程写前重读比对），
 * 所以它必须留在 shared（renderer 没有 node:crypto）。
 *
 * 按 UTF-16 code unit 进位：同一段文本在两侧都是同一个 JS 字符串（IPC 结构化克隆），
 * 不受编码 / BOM 差异影响——BOM 本身是文本里的一个字符，两边都看得见。
 */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * 网页类文件：浏览器能直接渲染、在内置浏览器里打开有意义的那几种。文件面板据此给「在内置
 * 浏览器打开」，agent 的 browser_navigate 打开本地文件也只认这几种（main/browser/local-file.ts）。
 */
const WEB_PAGE_EXTENSIONS = /\.(?:html?|xhtml|svg)$/i;

export function isWebPageFile(path: string): boolean {
  return WEB_PAGE_EXTENSIONS.test(path);
}

/**
 * 轮尾「网页产物」判定（.html / .htm / .svg）：agent 的轮内 mtime 扫描与轮尾卡片的
 * 网页行用同一张表——扫描收进来的是它、卡片把 changes 里命中的抬成网页行的也是它。
 * 与 isWebPageFile（面板 / 内置浏览器那套，多认 xhtml）是两张表：本表只收文件账
 * 与卡片当作「网页产物」的那几种，浏览器能多开的不自动进卡。
 */
export function isWebArtifactFile(path: string): boolean {
  return /\.(?:html?|svg)$/i.test(path);
}

/**
 * 盘上一条路径的类型（`fs:stat-kind` 的回执字段）。与 `PromptFileRef` / `SentFileRef`
 * （prompt-attachments.ts）的 `kind` 同一套词汇，不与面板的 `FileEntryKind`
 * （还有 symlink / other）混用：这边只回答输入框附件分拣要问的那一问——
 * 发给模型时是按文件（read）还是按目录（尾斜杠）记。
 */
export type FsEntryKind = "file" | "dir";

/**
 * `fs:stat-kind` 的回执行：一条路径的盘上事实。`kind` 为 null = stat 不到
 * （路径已不在、无权限）——调用方自己兑底：附件分拣按 file 收下，文件面板的
 * 已发送附件列表据此如实标「不在盘上」。`size` 只对文件有意义，目录与 stat
 * 不到的都是 null（大文件复制阈值判定只看文件）。
 */
export interface FsEntryFact {
  kind: FsEntryKind | null;
  size: number | null;
}

/** 文本预览最多读的字节数（2 MB）：再大的日志 / 数据文件只读开头，截断如实标出 */
export const PREVIEW_TEXT_LIMIT = 2 * 1024 * 1024;

/** 图片预览上限（20 MB）：base64 过 IPC 再进 <img>，再大就不读 */
export const PREVIEW_IMAGE_LIMIT = 20 * 1024 * 1024;

/**
 * PDF 预览（`fs:read-pdf` 的回执，实验功能「PDF 引用」）。字节原样过 IPC
 * （Uint8Array 走结构化克隆，不转 base64），renderer 交给 pdf.js 渲染。白名单与
 * fs:read 同一道。上限与外部附件的复制上限同值：再大的 PDF 本来也不会被复制进会话。
 */
export type PdfFile =
  | { kind: "pdf"; data: Uint8Array; size: number; modifiedAt: number }
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number };

/** PDF 预览上限（100 MB） */
export const PREVIEW_PDF_LIMIT = 100 * 1024 * 1024;

export function isPdfFile(path: string): boolean {
  return /\.pdf$/i.test(path);
}
