/**
 * MCP 契约 —— IPC 四层的第 1 层。
 *
 * 配置格式**照抄 Claude Desktop 的 `mcpServers`**，不自创一套：用户手上现成的
 * server 配置能直接粘过来，社区文档也不用重讲一遍。落在 `<userData>/mcp.json`。
 *
 * 启停沿用 skills 的哲学——**配置文件就是全部状态**，不另存一份启用清单。
 * 区别是 MCP 不像 skill 那样能靠移动目录表达，所以用一个 `disabled` 字段
 * （Cursor / Windsurf 同款），仍然只有一份真相。
 *
 * **工作区限定**也走同一条哲学：`workspaces` 白名单 + 配置里的 `${workspaceFolder}`
 * 变量，两者都写在 server 条目上，不另开一份「哪个工作区用哪些 server」的清单。
 */

/**
 * 这台 server 限定只在哪些工作区里启用。
 *
 * **缺席 / 空数组 = 所有工作区都启用**（含没有工作区的 Home 会话），这是向后兼容的默认。
 * 匹配按**工作区名或 id**任一命中——名字是给人读的（`4cc7bad3-…` 读不出是哪篇论文），
 * id 是给「改名之后仍然生效」兜底的：只认名字的话，一次 rename 就会让这台 server
 * 静默从那个工作区消失，而静默消失正是本项目一直在治的病。
 */
export interface McpWorkspaceScope {
  workspaces?: string[];
}

/** 本地子进程。绝大多数 MCP server 是这种。 */
export interface McpStdioServer extends McpWorkspaceScope {
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

/** 远端 HTTP。Streamable HTTP，不是已废弃的 SSE。 */
export interface McpHttpServer extends McpWorkspaceScope {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export type McpServer = McpStdioServer | McpHttpServer;

export interface McpConfigFile {
  mcpServers?: Record<string, McpServer>;
}

/** 一台 server 此刻怎么样了。**连接状态不落盘**，它是运行时事实。 */
export type McpStatus =
  | { kind: "disabled" }
  | { kind: "connecting" }
  | { kind: "ready"; tools: string[] }
  | { kind: "failed"; message: string };

/** 管理面列出来的一条。 */
export interface McpServerInfo {
  name: string;
  /** 给人看的一行：stdio 显示命令，http 显示 URL */
  detail: string;
  status: McpStatus;
  /** 配的 `workspaces` 白名单原样带出来给面板显示。空 = 所有工作区都能用。 */
  scopedTo: string[];
}

export function isHttpServer(server: McpServer): server is McpHttpServer {
  return server.transport === "http";
}

/**
 * 工具在模型那边叫什么：`mcp__<server>__<tool>`。
 *
 * **加前缀不是为了好看**：多台 server 很容易各自都有 `search`，
 * 不隔离就会互相覆盖，而模型看到两个同名工具时的选择是不确定的。
 * 这个前缀是 MCP 生态的通行写法（Claude Code、DSH 都用它）。
 */
export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * server 名字要能安全地拼进工具名。
 * 工具名会进 LLM 的 tool schema，各家 provider 对它的字符集都有要求
 * （OpenAI 是 `^[a-zA-Z0-9_-]+$`），所以这里从严。
 */
/**
 * 拆 `mcp__<server>__<tool>`（4-5）：聊天面的工具卡要按 server 名归组展示，
 * 拆法只此一份——renderer 不自己写正则。不是这个形状返回 null。
 */
export function parseQualifiedToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([a-zA-Z0-9_-]+)__(.+)$/.exec(name);
  if (match === null) return null;
  return { server: match[1] ?? "", tool: match[2] ?? "" };
}

export function isMcpServerName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * 解析 mcp.json。**坏掉的一条跳过，不让它挡住其它 server**——
 * 同 parseWorkspace / parseSessionMeta 的理由。
 */
export function parseMcpConfig(raw: unknown): Record<string, McpServer> {
  if (typeof raw !== "object" || raw === null) return {};
  const servers = (raw as McpConfigFile).mcpServers;
  if (typeof servers !== "object" || servers === null) return {};
  const parsed: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!isMcpServerName(name)) continue;
    const server = parseServer(value);
    if (server !== null) parsed[name] = server;
  }
  return parsed;
}

function parseServer(raw: unknown): McpServer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const disabled = value["disabled"] === true;
  if (value["transport"] === "http") {
    const url = str(value["url"]);
    if (url === null) return null;
    return {
      transport: "http",
      url,
      ...(record(value["headers"]) !== null ? { headers: record(value["headers"]) as Record<string, string> } : {}),
      ...(disabled ? { disabled } : {}),
      ...scoped(value["workspaces"]),
    };
  }
  const command = str(value["command"]);
  if (command === null) return null;
  const args = Array.isArray(value["args"])
    ? value["args"].filter((a): a is string => typeof a === "string")
    : undefined;
  const cwd = str(value["cwd"]);
  return {
    transport: "stdio",
    command,
    ...(args !== undefined ? { args } : {}),
    ...(record(value["env"]) !== null ? { env: record(value["env"]) as Record<string, string> } : {}),
    ...(cwd !== null ? { cwd } : {}),
    ...(disabled ? { disabled } : {}),
    ...scoped(value["workspaces"]),
  };
}

/** 白名单：非数组、非字符串项一律丢掉；全丢光就当作没写（= 所有工作区）。 */
function scoped(value: unknown): { workspaces?: string[] } {
  if (!Array.isArray(value)) return {};
  const names = value.filter((item): item is string => typeof item === "string" && item !== "");
  return names.length === 0 ? {} : { workspaces: [...new Set(names)] };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** 给人看的一行摘要。 */
export function describeServer(server: McpServer): string {
  return isHttpServer(server)
    ? server.url
    : [server.command, ...(server.args ?? [])].join(" ");
}

/**
 * 配置里唯一支持的变量：**这条会话所属工作区的根目录**。
 *
 * 只有这一个，不做 `${env:...}` / `${input:...}` 那一整套——那套的第二个消费者还没出现
 * （AGENTS.md 的消费者纪律）。语法跟 Cursor / VS Code 一致，用户不必另学一套。
 */
export const WORKSPACE_FOLDER_VAR = "${workspaceFolder}";

/** 工作区在解析期的样子。`path` 就是 `${workspaceFolder}` 的值。 */
export interface McpWorkspace {
  id: string;
  name: string;
  path: string;
}

/** 这台 server 的配置里用了工作区变量吗。 */
export function usesWorkspaceFolder(server: McpServer): boolean {
  const hit = (text: string): boolean => text.includes(WORKSPACE_FOLDER_VAR);
  if (isHttpServer(server)) {
    return hit(server.url) || Object.values(server.headers ?? {}).some(hit);
  }
  return (
    hit(server.command) ||
    (server.args ?? []).some(hit) ||
    Object.values(server.env ?? {}).some(hit) ||
    (server.cwd !== undefined && hit(server.cwd))
  );
}

/** 白名单是否放行这条会话。`null` = 会话不属于任何工作区（Home）。 */
export function appliesToWorkspace(
  server: McpServer,
  workspace: { id: string; name: string } | null,
): boolean {
  const scoped = server.workspaces;
  if (scoped === undefined || scoped.length === 0) return true;
  if (workspace === null) return false;
  return scoped.includes(workspace.name) || scoped.includes(workspace.id);
}

/**
 * 把 `${workspaceFolder}` 换成工作区根。
 *
 * 覆盖 `command` / `args` / `env` / `cwd` / `url` / `headers`——一个字符串都不漏，
 * 漏一个就是「用户以为写对了、实际没生效」。`disabled` 与 `workspaces` 原样保留
 * （后者还要给工具描述标绑定用）。
 */
export function substituteWorkspaceFolder(server: McpServer, folder: string): McpServer {
  const sub = (text: string): string => text.split(WORKSPACE_FOLDER_VAR).join(folder);
  const subAll = (bag: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(bag)) out[key] = sub(value);
    return out;
  };
  if (isHttpServer(server)) {
    return {
      ...server,
      url: sub(server.url),
      ...(server.headers === undefined ? {} : { headers: subAll(server.headers) }),
    };
  }
  return {
    ...server,
    command: sub(server.command),
    ...(server.args === undefined ? {} : { args: server.args.map(sub) }),
    ...(server.env === undefined ? {} : { env: subAll(server.env) }),
    ...(server.cwd === undefined ? {} : { cwd: sub(server.cwd) }),
  };
}

/**
 * 把一份 mcp.json 解析成**某一条会话该看到的那一份**：按白名单筛，再把工作区变量换掉。
 *
 * 解析放在主进程——只有它知道工作区路径（与 `skillsDirs` 同一条纪律：agent 进程只收数据）。
 */
export function resolveServersForWorkspace(
  configured: Record<string, McpServer>,
  workspace: McpWorkspace | null,
): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(configured)) {
    if (!appliesToWorkspace(server, workspace)) continue;
    if (usesWorkspaceFolder(server)) {
      /*
       * Home 会话没有工作区根可换。**跳过，不塞默认值**——塞一个猜的值正是
       * aw-mcp 那类 server 静默空转 / 串号的来源（它的 `AW_PAPER_ROOT` 配错时
       * 引用检查、快照、期刊迁移会全部对着错误的论文跑）。
       */
      if (workspace === null) continue;
      out[name] = substituteWorkspaceFolder(server, workspace.path);
    } else {
      out[name] = server;
    }
  }
  return out;
}
