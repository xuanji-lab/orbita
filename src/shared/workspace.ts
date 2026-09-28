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
  /**
   * 用户起的名字。没起过就是路径的最后一段。**自由显示文本**——含 `/` 也行
   * （如 `PhD/Year1`），显示层原样显示、不截尾。早期只切 `/` 的派生在 Windows 上把
   * 整条路径铸成了名字，这一类由 store 的 v2 → v3 迁移治一次（`looksLikePathDerivedName`
   * 是它的指纹），**读路径上不再有治愈**——parseWorkspace 只解析，不改数据。
   * create 用名字当目录名，另有更严的守卫（见 store 的 assertLegalName）。
   */
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

/**
 * 盘符、UNC / 设备命名空间、当前盘根相对起头：Windows 形路径。
 *
 * 分隔符按**路径自己的形**认，不按宿主 OS——POSIX 路径里 `\` 是文件夹名里的合法
 * 字符（Mac 的 `/Users/x/my\folder` 尾段就是 `my\folder`），只有 Windows 形才把
 * `\` 当分隔符。按形不按 OS 的另一个好处：从 Windows 机器导入 / 迁移来的路径，
 * 在 Mac 上也取对尾段。
 *
 * 盘符后面**不要求**跟分隔符：`C:proj` 也是 Windows 形（盘符相对）。代价是以 `\`
 * 起头的 POSIX **相对**路径（`\weird/proj`）会被当成 Windows 形——调用方喂进来的
 * 都是绝对路径，误判朝「多切一个分隔符」那一侧，是想要的那一边。
 */
export function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\");
}

/**
 * 没起名字时的默认名：路径的最后一段。服务的是**路径**：cwd 的目录尾段（scope 芯片）、
 * add / v1 迁移 / 导入铸名，以及 v2 → v3 迁移把老脏名治回来（store 的 healNames）。
 * 不服务名字本身——名字是自由显示文本，显示层原样显示不过这个函数。
 * **不受 40 上限约束**：WORKSPACE_NAME_MAX 约束的是用户输入（normalize），从路径派生
 * 出来的名字照实取——截一刀只会得到分尸名，而磁盘上的目录名是完整的。
 */
export function deriveWorkspaceName(path: string): string {
  const parts = (looksLikeWindowsPath(path) ? path.split(/[\\/]/) : path.split("/")).filter(
    (part) => part !== "",
  );
  return parts[parts.length - 1] ?? path;
}

/** 用户输入的名字 → 落盘的名字。空白名退回路径末段，而不是留一个看不见的空行。 */
export function normalizeWorkspaceName(name: string, path: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return deriveWorkspaceName(path);
  return trimmed.length > WORKSPACE_NAME_MAX ? trimmed.slice(0, WORKSPACE_NAME_MAX) : trimmed;
}

/**
 * 老数据的精确指纹：这个名字是**机器从路径铸的**，不是用户起的。
 *
 * 只给 store 的 v2 → v3 一次性迁移用（`healNames`），**不在读路径上跑**——
 * 每次读都改一个用户可见字段是隐藏的数据变更，磁盘也永远脏。两类：
 *   1. 整条路径当名字：`add` / v1 迁移铸的（早期只切 `/` 的派生在 Windows 的产物）
 *   2. 路径被 WORKSPACE_NAME_MAX 切过：`addImported` / `rename` 落库前过的 normalize
 * 判定必须收得这么窄：用户自己起的名字是自由显示文本（`PhD/Year1`、Mac 的 `a\b`），
 * 「像路径」不是理由，只有「跟这条记录自己的 path 对得上」才是。第 1 类里超长的那些
 * 在 parseWorkspace 里已经被 normalize 切过，正好落进第 2 类——两条一起才没有缝。
 */
export function looksLikePathDerivedName(name: string, path: string): boolean {
  // 大小写只在 Windows 形路径上折：POSIX 的文件名区分大小写，折了会误伤用户的名字；
  // 盘符大小写在同一条路径上可以两样（`c:\…` 与 `C:\…` 是同一个盘）
  const fold = (value: string): string => (looksLikeWindowsPath(path) ? value.toLowerCase() : value);
  const folded = fold(name);
  const wanted = fold(path);
  return folded === wanted || (folded.length === WORKSPACE_NAME_MAX && wanted.startsWith(folded));
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
    // 纯解析：名字原样过 normalize（trim + 40 上限 + 空回退），一个字不改语义。
    // 老脏名（机器从路径铸的那些）不在这里治——**解析函数不该改用户看得见的数据**，
    // 那是 store 的 v2 → v3 一次性迁移的事（looksLikePathDerivedName 判指纹）
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
