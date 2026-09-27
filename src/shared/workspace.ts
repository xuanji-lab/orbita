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
  /**
   * 附加目录（2026-09-22 裁决）：除 `path` 之外，这个工作区的 agent 还能去的目录，绝对路径。
   *
   * **挂在工作区而不是会话上**：用户的实际用法是把 vault、资料库这类目录长期挂着，
   * 不按会话临时加。会话级会带来三个没有必要的问题——detach 后历史消息里的绝对路径悬空、
   * 子会话要不要继承、两套存储与 IPC。工作区级一个都没有：它不写进会话历史，减掉就减掉。
   *
   * **只告知、不硬拦**：这份清单进 systemPrompt 告诉模型「可以去哪」；工具面仍是 cwd 加
   * `protectedPaths` 黑名单。pi 的 read/write 只把相对路径 resolve 到 cwd，不做包含性校验，
   * 白名单硬拦是新功能不是这条字段的事。
   *
   * 磁盘上缺席 = 空数组（字段之前存的工作区不迁移）。顺序是用户挂上的顺序，进 prompt 时也按它。
   */
  attachedDirs: string[];
}

/** 没起名字时的默认名：路径的最后一段。 */
export function deriveWorkspaceName(path: string): string {
  // `/` 与 `\` 都认：Windows 的工作区路径是反斜杠，只切 `/` 会把整条 `C:\…` 当成名字
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
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
    attachedDirs: parseAttachedDirs(value["attachedDirs"]),
  };
}

/**
 * 附加目录列表的解析：不是数组当空；非空字符串才算一条；重复的只留第一条。
 * 一条坏值只丢那一条，不丢整个工作区——它是附加的，不是 agent 的落脚点。
 */
function parseAttachedDirs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const dirs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "" || dirs.includes(item)) continue;
    dirs.push(item);
  }
  return dirs;
}
