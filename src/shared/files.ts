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
    const last = path.split("/").filter((part) => part !== "").pop();
    return last === undefined || last === "" ? path : last;
  }
  return title.trim() === "" ? fallback : title.trim();
}
