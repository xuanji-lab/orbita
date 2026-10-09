/**
 * 文件面板契约 —— IPC 四层的第 1 层（文件系统 2026-09-22 裁决）。
 *
 * 面板回答「这条会话的 agent 能去哪、里面有什么」。根有三种来源，顺序固定：
 *   session    本会话工作台 `<userData>/workbenches/<id>/`（唯一随会话变的根，排最前）
 *   workspace  工作区文件夹（cwd；Home 会话是 `~/Orbita/Home`）
 *   attached   工作区挂的附加目录，按用户挂上的顺序
 *
 * **renderer 侧 IPC 有白名单，agent 工具面没有**——两者不冲突：工具面「只告知」是
 * 关于模型的（Q2）；这里的白名单是关于 renderer 的：sandbox 里的 renderer 只能列
 * 主进程算出来的这几个根之内的路径，不能拿这条通道当通用文件浏览器。
 */

import { pathTail } from "./path.ts";

export type FileRootKind = "session" | "workspace" | "attached";

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
  if (kind === "attached") {
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
 * 网页类文件：浏览器能直接渲染、在内置浏览器里打开有意义的那几种。文件面板据此给「在内置
 * 浏览器打开」，agent 的 browser_navigate 打开本地文件也只认这几种（main/browser/local-file.ts）。
 */
const WEB_PAGE_EXTENSIONS = /\.(?:html?|xhtml|svg)$/i;

export function isWebPageFile(path: string): boolean {
  return WEB_PAGE_EXTENSIONS.test(path);
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
