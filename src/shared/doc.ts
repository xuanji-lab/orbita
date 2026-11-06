/**
 * 文档 / 演示文稿面板契约 —— IPC 四层的第 1 层。
 *
 * 一份文档就是工作区里的一个 `.md` 文件：本地优先、可移植，agent 用现有的 read / edit /
 * write 就能改，改动审查面板现成能看 diff。Word（.docx）与 PDF 是**导出**动作，不是存储格式。
 * 演示文稿是同一种文件，`---` 分页（见 `doc-slides.ts`）。
 *
 * **白名单**同文件面板（`files.ts`）：路径必须落在这条会话的根（工作台 / 工作区 / 附加目录）
 * 之内，realpath 后再判；只认 `.md`。renderer 传什么都不信。
 *
 * **写入是比较后交换**：请求带 `expectedHash`（renderer 上次读到 / 写成功时盘上的内容摘要），
 * 盘上现在的内容摘要对不上 = 这期间 agent（或别的程序）改过文件，**不写**，把盘上的现状还回来，
 * 由 renderer 三向合并后重试。renderer 因此不会把 agent 刚写的段落盖回旧版本。
 * 摘要只由主进程算（renderer 不自己算），所以两边不需要约定哈希。
 */

/** 文档 / 演示文稿 */
export type DocKind = "doc" | "slides";

/** 一份文档的定位：绝对路径 + 用来算白名单根的会话 / 工作区 */
export interface DocTarget {
  sessionId: string | null;
  workspaceId: string | null;
  path: string;
}

/** `doc:read` 的回执 */
export interface DocFile {
  text: string;
  /** 内容摘要（主进程算）：写入时原样带回作为 expectedHash */
  hash: string;
  modifiedAt: number;
}

/** `doc:write` 的请求 */
export interface DocWriteRequest extends DocTarget {
  text: string;
  /** renderer 认为盘上现在是什么（上次读 / 写成功拿到的 hash） */
  expectedHash: string;
}

export type DocWriteResult =
  | { ok: true; hash: string; modifiedAt: number }
  /** 盘上已被改过：没写，附盘上的现状 */
  | { ok: false; reason: "conflict"; file: DocFile }
  /** 文件是只读的：没写（不绕过只读去覆盖，也不偷偷改回权限位）。面板说「这个文件是只读的」+「另存为…」 */
  | { ok: false; reason: "readonly" };

/**
 * 文件被移走 / 删除了：`doc:read` / `doc:write` / `doc:watch` 抛的错误消息以它起头。
 * Electron 的 IPC 错误只剩消息文本、没有 code，所以 renderer 靠这个标记认。
 */
export const DOC_GONE = "DOC_GONE";

/** `doc:save-as`：把这段文字另存成一个新文件（系统保存对话框选位置；文件已被删也能用，只取目录与名字做默认值） */
export interface DocSaveAsRequest extends DocTarget {
  text: string;
}

export interface DocSaveAsResult {
  /** 写到哪了；用户取消 = null */
  saved: string | null;
  /** 新文件是否落在这条会话的可写根之内（是 = 面板可以直接切过去打开它） */
  inside: boolean;
}

/** `doc:create`：在当前会话的工作区根下新建一份（重名加序号） */
export interface DocCreateRequest {
  sessionId: string | null;
  workspaceId: string | null;
  kind: DocKind;
}

export interface DocCreated extends DocFile {
  path: string;
}

/** `doc:list`：工作区里的 .md 文件（打开已有文档用） */
export interface DocListRequest {
  sessionId: string | null;
  workspaceId: string | null;
}

export interface DocListEntry {
  path: string;
  /** 文件名（含 .md） */
  name: string;
  /** 工作区根下的相对路径（根目录下的就是文件名） */
  relative: string;
  kind: DocKind;
  modifiedAt: number;
}

/** 列表的体量闸：工作区里 .md 再多也只回这么多（最近改的在前） */
export const DOC_LIST_LIMIT = 200;
/** 列表扫描的目录深度（工作区根 = 0） */
export const DOC_LIST_DEPTH = 3;

/** `doc:changed` 事件（主进程 → renderer）：被 watch 的文件在盘上变了 */
export interface DocChangedEvent {
  path: string;
}

/** 文档能读写的最大体量（字节）：再大不是「文档」，是日志——拒绝而不是卡死 */
export const DOC_MAX_BYTES = 8 * 1024 * 1024;

export type DocExportFormat = "docx" | "pdf";

/**
 * `doc:export`：文档导出 docx、演示文稿导出 PDF。
 * - docx：主进程读盘上那份 `.md` 转（renderer 已先把未落盘的改动写盘）；
 * - pdf：renderer 渲染好整份幻灯片的**自包含 HTML**（每页一个 `<section class="slide">`，
 *   `markdown → HTML` 复用 renderer 的管线，主进程没有 react），主进程用隐藏窗口
 *   `printToPDF`，页数 = `pages`。HTML 在隐藏窗口里**禁用脚本**加载。
 * 都先弹系统保存对话框，取消回 `saved: null`。
 */
export type DocExportRequest =
  /** text：renderer 此刻的全文（含没写进盘的——文件只读存不进去时，导出的也该是用户眼前这份）；缺席读盘 */
  | (DocTarget & { format: "docx"; text?: string })
  | (DocTarget & { format: "pdf"; html: string; pages: number });

export interface DocExportResult {
  /** 写到哪了；用户在保存对话框里取消 = null */
  saved: string | null;
}

/** 新建文档的默认名（重名加序号由主进程做） */
export const NEW_DOC_NAME = "未命名文档";
export const NEW_DECK_NAME = "未命名演示文稿";

/** 面板上显示的名字：去掉 .md */
export function docTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.md$/i, "");
}
