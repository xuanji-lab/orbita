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
 * `fs:line-index` 的请求：与 `fs:list` / `fs:read` 同一道白名单（`root` 必须是
 * `fs:roots` 回过的，`dir` 就是文件路径、realpath 后必须在 root 之内）。
 */
export type FileLineIndexRequest = FileListRequest;

/**
 * 行索引的回执（`fs:line-index`）：大于 PREVIEW_TEXT_LIMIT 的文本可能比一次 IPC 装得下的
 * 大得多，renderer 于是只问「这个文件有多少行」、随后按行窗口向主进程要内容。
 *
 * `indexId` 是主进程铸的**不透明令牌**，`fs:read-lines` 只认它、不接受路径：令牌只发给
 * 刚过完白名单的文件，renderer 没有任何办法拿它去读别的东西。缓存键是
 * `realpath + size + mtimeMs`（LRU 3）——文件一改，旧令牌自然失效。
 *
 * 两种「不做分段」的结果不是错误，而是明确的能力边界，renderer 各有退路：
 * - `long-line`：单行超过 PREVIEW_MAX_LINE_BYTES。分段是按行窗口化的，而**一条行本身
 *   无法再窗口化**——退回「前 PREVIEW_TEXT_LIMIT + 长行硬切」那条路；
 * - `too-many-lines`：行数超过 PREVIEW_MAX_INDEXED_LINES。Chromium 的原生滚动高度上限
 *   是 33,554,430 px，1.8 M 行 × 18.6 px 正好贴边，再往上滚动条就没法映射了——
 *   如实给「用默认应用打开」，不假装能浏览。
 */
export type FileLineIndex =
  | {
      kind: "ok";
      indexId: string;
      totalLines: number;
      size: number;
      modifiedAt: number;
    }
  /** 空文件（0 字节）：没有行可读，面板给空态 */
  | { kind: "empty"; size: number; modifiedAt: number }
  /** 开头 8 KB 有 NUL 字节：文件在 fs:read 之后变成了二进制（改名 / 被重写），不读内容 */
  | { kind: "binary"; size: number; modifiedAt: number }
  /** 单行超过 PREVIEW_MAX_LINE_BYTES：一条行没法再窗口化，退回去看前 PREVIEW_TEXT_LIMIT */
  | { kind: "long-line"; size: number; modifiedAt: number }
  | { kind: "too-many-lines"; limit: number; size: number; modifiedAt: number };

/**
 * `fs:read-lines` 的请求：一个索引令牌 + 要第几行起的几行。**没有路径**——令牌已经
 * 绑定了白名单校验过的文件，多传一条路径只会多一个可被伪造的入口。
 * `startLine` / `count` 都由主进程夹到合法范围（负数、越界、非整数一律夹取）。
 */
export interface FileLinesRequest {
  indexId: string;
  startLine: number;
  count: number;
}

/**
 * `fs:read-lines` 的回执。行按 `\n` 切（`\r\n` 的 `\r` 已去掉），末尾换行**不**多出
 * 一个空行（`"a\nb\n"` 是 2 行，与 `wc -l` 的口径一致，日志末尾不会挂一条空白行）。
 *
 * `stale` = 索引建好之后文件的大小或 mtime 变了（被替换 / 追加）：不猜内容，让 renderer
 * 重新索引。二进制与太小 / 太多行都在 `fs:line-index` 那一步就挡掉了，走不到这条通道。
 */
export type FileLines =
  | {
      kind: "text";
      lines: string[];
      /** 这批行的首行行号（0 起；主进程夹取后的真实值） */
      startLine: number;
      totalLines: number;
      size: number;
      modifiedAt: number;
    }
  | { kind: "stale"; size: number; modifiedAt: number };

/**
 * 每次 `fs:read-lines` 最多给多少行（主进程夹取的上限）：一份 600 行的窗口在
 * 18.6 px 行高下是 11,000 px，比最长的桌面还高，滚一次窗口不会露出空白；
 * 同时它把一次 IPC 的载荷压在几十 KB（一条 200 字符的行约 200 B）。
 */
export const PREVIEW_LINES_PER_READ = 600;

/**
 * 行索引最多记多少行（1.8 M）：Chromium 的原生滚动高度是 33,554,430 px，按
 * 18.59 px 一行算出 1,804,650 行——超过这个数滚动条就无法映射到全文位置了。
 * 取 1.8 M 留一点余量（约 200 MB 的常规日志），再大的文件给「用默认应用打开」。
 */
export const PREVIEW_MAX_INDEXED_LINES = 1_800_000;

/**
 * 分段预览能容忍的单行字节上限（64 KB）：分段是按行窗口化的，一行再长也只能整条渲染，
 * 而一条 8 MB 的行建 DOM 就要 460 ms（PR #279 实测）。超过它的文件退回
 * 「前 PREVIEW_TEXT_LIMIT + 长行硬切」，那是长行唯一可行的渲染方式。
 */
export const PREVIEW_MAX_LINE_BYTES = 64 * 1024;

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

/**
 * 文本预览最多读的字节数（16 MB）：再大的日志 / 数据文件只读开头，截断如实标出。
 *
 * 这个上限现在的含义已经变了：窗口化（`WINDOW_TEXT_LIMIT`）之后它**不再是渲染上限**
 * （DOM 里最多只有可视区附近那几百行），它只保护两件事——整份文本进 renderer 的 JS
 * 堆（保留内存约 1.2× 文件体积），以及一次 IPC 结构化克隆的耗时。
 *
 * 依据（2026-10-25 实测，Electron 43 + 同一套窗口化 DOM，page cache 热读、窗口可见）：
 * 16 MB 在 harness 里首帧 21–26 ms，真应用里点击→首帧 64 ms（外壳那一段是不随体积
 * 增长的常数），renderer 堆 +20 MB，无长任务；32 MB 也稳（harness 39–48 ms / +40 MB），
 * 但慢机按 2–3× 折价后 32 MB 就要 100+ ms，所以默认取 16 MB 给慢机留余量。
 * 超过它的文件面板给「用默认应用打开」。
 */
export const PREVIEW_TEXT_LIMIT = 16 * 1024 * 1024;

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
