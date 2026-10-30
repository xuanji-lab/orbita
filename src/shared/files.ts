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
  | { kind: "text"; text: string; size: number; modifiedAt: number }
  /**
   * 文本比 PREVIEW_TEXT_LIMIT 大：**一个字节的正文都不过 IPC**（只嗅了开头 8 KB 确认不是二进制），
   * 面板改走 `fs:line-index` + `fs:read-lines` 按行取窗。原先是先读 16 MB 的开头再让
   * renderer 丢掉——100 MB 日志白白搬一遍 16 MB，而分段预览只有「超长单行」那条退路才用得上它
   * （那条路现在由 `FileLineIndex` 的 long-line 回执自带开头）。
   */
  | { kind: "large-text"; size: number; modifiedAt: number }
  /** 图片：`mime` 由扩展名定（Chromium 的 <img> 画得了的那几种），`base64` 不带 data: 前缀 */
  | { kind: "image"; mime: string; base64: string; size: number; modifiedAt: number }
  /** 二进制（开头有 NUL 字节，或是 Chromium 画不了的图片格式）：不读内容，面板给「用默认应用打开」 */
  | { kind: "binary"; size: number; modifiedAt: number }
  /** 图片比 PREVIEW_IMAGE_LIMIT 大：不读，同样给「用默认应用打开」 */
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number };

/**
 * `fs:line-index` 的请求：与 `fs:list` / `fs:read` 同一道白名单（`root` 必须是
 * `fs:roots` 回过的，`dir` 就是文件路径、realpath 后必须在 root 之内）。
 *
 * `requestId` 是 renderer 自己起的一次性号码，只为 `fs:line-index-cancel`：换标签 / 关面板时
 * 通知主进程停掉还在扫的那一遍。它只在发起请求的那个窗口之内有效，不是权限凭证。
 */
export interface FileLineIndexRequest extends FileListRequest {
  requestId: string;
}

/**
 * 行索引的回执（`fs:line-index`）：大于 PREVIEW_TEXT_LIMIT 的文本可能比一次 IPC 装得下的
 * 大得多，renderer 于是只问「这个文件有多少行」、随后按行窗口向主进程要内容。
 *
 * `indexId` 是主进程铸的**不透明令牌**，`fs:read-lines` 只认它、不接受路径：令牌只发给
 * 刚过完白名单的文件，renderer 没有任何办法拿它去读别的东西。同一个文件只留一条索引
 * （LRU，条数见主进程），**文件只是变长且前面没改时在原索引上接着扫、令牌不变**；
 * 被改写 / 截断才换新令牌。
 *
 * 几种「不做分段」的结果不是错误，而是明确的能力边界，renderer 各有退路：
 * - `long-line`：单行超过 PREVIEW_MAX_LINE_BYTES。分段是按行窗口化的，而**一条行本身
 *   无法再窗口化**——退回「前 PREVIEW_TEXT_LIMIT + 长行硬切」那条路，开头文本由这条回执
 *   带上（只有这一种情形才让 16 MB 过 IPC）；
 * - `too-large`：文件超过 PREVIEW_MAX_INDEX_BYTES，扫一遍的代价不值得，如实给「用默认应用打开」；
 * - `cancelled`：renderer 自己取消了这次请求（换标签 / 卸载），不需要处理。
 *
 * 注意**没有「行数太多」**：能不能滚到底取决于 renderer 运行时量出来的滚动高度上限
 * （随显示器缩放与页面缩放变），主进程不知道也不该猜；它只如实回 `totalLines`。
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
  /** 单行超过 PREVIEW_MAX_LINE_BYTES：一条行没法再窗口化，`headText` 是前 PREVIEW_TEXT_LIMIT 的文本 */
  | { kind: "long-line"; headText: string; size: number; modifiedAt: number }
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number }
  | { kind: "cancelled" };

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
 * - `text.totalLines` 可能比建索引时大：文件只是变长（正在写的日志）时，主进程先把索引
 *   接着扫到新末尾再取窗，renderer 据此撑高滚动容器；
 * - `stale`：文件被改写 / 截断 / 替换，旧检查点不再可信，不猜内容，让 renderer 重新索引
 *   （renderer 自动重建，有次数上限）；
 * - `expired`：令牌不认识（缓存把它挤掉了 / 应用重启过）。同样让 renderer 重新索引——
 *   以前这条是 reject，用户只能看到一行红字再手点重试。
 * 二进制与过大都在 `fs:line-index` 那一步就挡掉了，走不到这条通道。
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
  | { kind: "stale"; size: number; modifiedAt: number }
  | { kind: "expired" };

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
 * PDF 预览（`fs:read-pdf` 的回执，实验功能「PDF 引用」）。字节原样过 IPC
 * （Uint8Array 走结构化克隆，不转 base64），renderer 交给 pdf.js 渲染。白名单与
 * fs:read 同一道。上限与外部附件的复制上限同值：再大的 PDF 本来也不会被复制进会话。
 */
export type PdfFile =
  | { kind: "pdf"; data: Uint8Array; size: number; modifiedAt: number }
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number };

export function isPdfFile(path: string): boolean {
  return /\.pdf$/i.test(path);
}

// ───────────────────────────────────────────────────────────────────────────────
// 文件预览的尺寸门槛——**只有这一处**
//
// 预览管线上每一道「超过多大就换一条路」都在下面。renderer 的 preview-view / range-view /
// RangeTextPreview、主进程的 read / lines 都从这里取，别的地方不再写死数字
// （之前散在 preview-view.ts、range-view.ts、lines.ts、read.ts 四个文件里，read.ts 与
// lines.ts 各抄了一份「嗅二进制看多少字节」）。边界只收**文件预览**：终端缓冲、图片
// 预算、git maxBuffer、会话尾窗保护的是别的东西，不进这张表。
//
// | 门槛                          | 值        | 保护什么                         | 超过之后                         |
// | ----------------------------- | --------- | -------------------------------- | -------------------------------- |
// | PREVIEW_BINARY_SNIFF_BYTES    | 8 KB      | 判二进制只看开头                 | —                                |
// | PREVIEW_MARKDOWN_LIMIT        | 64 KB     | MarkdownBlock 的 DOM 代价        | 退到等宽原文                     |
// | PREVIEW_MAX_LINE_BYTES        | 64 KB     | 分段预览里一条行的渲染代价       | long-line，退回前 16 MB 硬切     |
// | PREVIEW_HIGHLIGHT_LIMIT       | 200 KB    | shiki 高亮的耗时与缓存           | 退到等宽原文                     |
// | PREVIEW_WINDOW_LIMIT          | 256 KB    | 单个文本节点的整篇重排           | 窗口化，只渲染可视区附近的行     |
// | PREVIEW_ROW_CHARS             | 4096 字符 | 一条显示行的长度                 | 硬切成多条显示行                 |
// | PREVIEW_LINES_PER_READ        | 600 行    | 一次 `fs:read-lines` 的载荷      | 主进程夹取                       |
// | PREVIEW_TEXT_LIMIT            | 16 MB     | 整份文本进 renderer 堆 / 一次 IPC | 分段预览（按行取窗）             |
// | PREVIEW_IMAGE_LIMIT           | 20 MB     | base64 过 IPC 再进 <img>         | 空态 + 默认应用打开              |
// | PREVIEW_MAX_INDEX_BYTES       | 1 GiB     | 主进程扫一遍换行的耗时           | 空态 + 默认应用打开              |
// | PREVIEW_PDF_LIMIT             | 100 MB    | PDF 字节过 IPC                   | 空态 + 默认应用打开              |
//
// **不在表里的两个数是运行时才知道的**：滚动容器能撑多高（Chromium 的上限按物理像素算，
// 随显示器缩放与页面缩放变——同一台 Mac 上页面缩放 0.5 / 1 / 2 实测 33.5M / 16.7M / 8.4M px）
// 由 renderer 的探针现量（`useScrollHeightLimit.ts`）；由它除以行高得到的「最多能浏览多少行」
// 因此也不是常量。
// ───────────────────────────────────────────────────────────────────────────────

/** 「有没有 NUL 字节」判定只看开头这一段（`fs:read` 与 `fs:line-index` 共用，与文本截断上限是两个独立的尺度） */
export const PREVIEW_BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Markdown 渲染上限（64 KB）：**超过就走等宽原文 + 顶部提示**，不进 MarkdownBlock。
 *
 * 依据（2026-10-23 实测，隔离实例 paper0 + CDP，面板宽 ~540px，正文节点数 / 最长一次
 * 主线程 longtask / 点击到首帧）：
 *
 * | md 体积 | 正文 DOM 节点 | 最长 longtask | 点击→首帧 |
 * | --- | ---: | ---: | ---: |
 * | 32 KB | 4,713 | 488 ms | 669 ms |
 * | 64 KB | 9,330 | 755 ms | 1,081 ms |
 * | 128 KB | 18,545 | 1,311 ms | 1,944 ms |
 * | 256 KB | 36,234 | 2,296 ms | 3,473 ms |
 * | 1 MB | 97,921 | 5,636 ms | 7,714 ms（JS 堆 +73 MB） |
 *
 * MarkdownBlock 为整篇建 DOM（每个段落 / 列表项 / 表格单元 / 代码块都是节点），
 * 代价与体积近似线性但常数极大：1 MB 那一次窗口冻结了近 6 秒。64 KB 落在「小于
 * 50 KB 的现有渲染行为不变」这条底线之上、单次打开已经要 0.8 秒的位置。
 */
export const PREVIEW_MARKDOWN_LIMIT = 64 * 1024;

/**
 * 代码高亮的体积上限（200 KB）：shiki 在几 MB 的文件上会明显卡顿，且
 * `highlight.ts` 的 HTML 缓存没有上限——超过这个数退回等宽原文，不进高亮管线。
 */
export const PREVIEW_HIGHLIGHT_LIMIT = 200 * 1024;

/**
 * 大文本窗口化阈值（256 KB）：超过它只在 DOM 里放可视区附近的行（±WINDOW_OVERSCAN，在 preview-view.ts）。
 *
 * 依据（同一轮实测，等宽原文 `<pre>` 全文渲染）：
 *
 * | 文本 | 正文节点 | 最长 longtask | 点击→首帧 |
 * | --- | ---: | ---: | ---: |
 * | 300 KB / 3,151 行 | 1 个文本节点 | 0 | 224 ms（= 50 KB 的基线） |
 * | 600 KB / 3,654 行 | 1 | 117 ms（.bib） | 242 ms |
 * | 2 MB / 21,083 行 | 1 | 142 ms | 203 ms |
 *
 * 单个文本节点本身很便宜，贵的是它在**每次布局**（打开、面板拖宽、滚到没缓存过的
 * 段）上都要重排整篇：2 MB 时一次 142 ms 的阻塞、600 KB × 每行 100–200 字符时 117 ms。
 * 256 KB 是「全文 `<pre>` 仍然只有一次廉价布局」的上界（300 KB 已与 50 KB 基线同价），
 * 再往上行数与字符数都开始把布局推过 100 ms。窗口化之后任何体积的代价都是常数：
 * 最多 2 × 200 + 一屏的行进 DOM。
 */
export const PREVIEW_WINDOW_LIMIT = 256 * 1024;

/**
 * 窗口化时一条显示行最多放多少字符（超出就硬切成多条显示行）。
 *
 * 窗口化是**按行**切窗口的，而一行本身无法再窗口化：一行有多长，它的行盒就有多长。
 * 依据（2026-10-25 实测，面板 540 × 700）：8 MB 一行 → 建 DOM 460 ms + 465 ms 长任务；
 * 32 MB 一行 → 到屏 1.9 s；按 4,096 字符硬切后同样的 32 MB 一行只要 24 ms、无长任务。
 * 4,096 远宽于面板（12 px 等宽字在 540 px 里约 45 字符），用户照样要横向滚动——
 * 它只是把「一条显示行的长度」从无界变成有界，不改文本内容、不插换行符。
 */
export const PREVIEW_ROW_CHARS = 4096;

/**
 * 一整份文本最多读进 renderer 的字节数（16 MB）：再大的文本不再整份过 IPC，改走分段预览。
 *
 * 这个上限现在的含义已经变了：窗口化（`PREVIEW_WINDOW_LIMIT`）之后它**不再是渲染上限**
 * （DOM 里最多只有可视区附近那几百行），它只保护两件事——整份文本进 renderer 的 JS
 * 堆（保留内存约 1.2× 文件体积），以及一次 IPC 结构化克隆的耗时。
 *
 * 依据（2026-10-25 实测，Electron 43 + 同一套窗口化 DOM，page cache 热读、窗口可见）：
 * 16 MB 在 harness 里首帧 21–26 ms，真应用里点击→首帧 64 ms（外壳那一段是不随体积
 * 增长的常数），renderer 堆 +20 MB，无长任务；32 MB 也稳（harness 39–48 ms / +40 MB），
 * 但慢机按 2–3× 折价后 32 MB 就要 100+ ms，所以默认取 16 MB 给慢机留余量。
 */
export const PREVIEW_TEXT_LIMIT = 16 * 1024 * 1024;

/** 图片预览上限（20 MB）：base64 过 IPC 再进 <img>，再大就不读 */
export const PREVIEW_IMAGE_LIMIT = 20 * 1024 * 1024;

/** PDF 预览上限（100 MB）：与外部附件的复制上限同值，见 `PdfFile` */
export const PREVIEW_PDF_LIMIT = 100 * 1024 * 1024;

/**
 * 每次 `fs:read-lines` 最多给多少行（主进程夹取的上限）：一份 600 行的窗口在
 * 18.6 px 行高下是 11,000 px，比最长的桌面还高，滚一次窗口不会露出空白；
 * 同时它把一次 IPC 的载荷压在几十 KB（一条 200 字符的行约 200 B）。
 */
export const PREVIEW_LINES_PER_READ = 600;

/**
 * 分段预览能容忍的单行字节上限（64 KB）：分段是按行窗口化的，一行再长也只能整条渲染，
 * 而一条 8 MB 的行建 DOM 就要 460 ms（PR #279 实测）。超过它的文件退回
 * 「前 PREVIEW_TEXT_LIMIT + 长行硬切」，那是长行唯一可行的渲染方式。
 */
export const PREVIEW_MAX_LINE_BYTES = 64 * 1024;

/**
 * 主进程愿意为一个文件扫一遍换行的最大字节数（1 GiB）。超过的不扫，回 `too-large`，
 * 面板给「用默认应用打开」。
 *
 * 扫描是 8 MB 一块、块间让出事件循环的，不会卡住主进程，所以它保护的是**等待时间**与
 * 磁盘：page cache 热时约 1.4 GB/s（100 MB 用时 67–79 ms），冷盘 / 网络盘可低至百 MB/s，
 * 1 GiB 在最慢的盘上也只是十几秒，且用户换标签就取消。再往上（几 GB 的转储 / 导出）本来
 * 也不是一个「预览」该做的事。它同时是「几 MB 一行的少行巨文件」的闸：那种文件不会撞
 * 单行上限之外的任何早退，只能靠字节数挡。
 */
export const PREVIEW_MAX_INDEX_BYTES = 1024 * 1024 * 1024;
