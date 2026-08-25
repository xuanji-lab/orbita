/**
 * 工作区契约 —— IPC 四层的第 1 层。
 *
 * **工作区 = 用户面的命名容器**：一个加进来的文件夹，可起名、可有多个、可切换，
 * 各自记着自己的会话。**不是**架构文档 `07-infrastructure.md §10` 里那个并行 agent
 * 的隔离执行副本（那个将来叫 worktree）——见 `docs/ubiquitous-language.md`。
 */

/** 名字上限。侧栏只有 288px，名字要和分支、计数挤在一行。 */
export const WORKSPACE_NAME_MAX = 40;

export interface Workspace {
  /**
   * **稳定 id，与路径无关。**会话按 id 归属而不是按路径：用户挪个文件夹或改个名，
   * 它的会话不该成孤儿。（这条与 `28-session-storage.md` 的 `Session.workspaceId` 对齐，
   * 也与 proma 的 `AgentSessionMeta.workspaceId` 是同一个做法。）
   */
  id: string;
  /** 用户起的名字。没起过就是路径的最后一段。 */
  name: string;
  path: string;
  createdAt: number;
}

/** 没起名字时的默认名：路径的最后一段。 */
export function deriveWorkspaceName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  const last = parts[parts.length - 1];
  return last === undefined || last === "" ? path : last;
}

/** 用户输入的名字 → 落盘的名字。空白名退回路径末段，而不是留一个看不见的空行。 */
export function normalizeWorkspaceName(name: string, path: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return deriveWorkspaceName(path);
  return trimmed.length > WORKSPACE_NAME_MAX ? trimmed.slice(0, WORKSPACE_NAME_MAX) : trimmed;
}

/**
 * 解析磁盘上的一条工作区。**坏了返回 null，调用方跳过这条**——
 * 与 `parseSessionMeta` 同一个理由：一条路径是编出来的工作区，
 * 会把 agent 指向一个不存在的目录。
 */
export function parseWorkspace(raw: unknown): Workspace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value["id"] === "string" && value["id"] !== "" ? value["id"] : null;
  const path = typeof value["path"] === "string" && value["path"] !== "" ? value["path"] : null;
  if (id === null || path === null) return null;
  return {
    id,
    name: normalizeWorkspaceName(typeof value["name"] === "string" ? value["name"] : "", path),
    path,
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : 0,
  };
}
