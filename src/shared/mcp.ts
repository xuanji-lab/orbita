/**
 * MCP 契约 —— IPC 四层的第 1 层。
 *
 * 配置格式**照抄 Claude Desktop 的 `mcpServers`**，不自创一套：用户手上现成的
 * server 配置能直接粘过来，社区文档也不用重讲一遍。落在 `<userData>/mcp.json`。
 *
 * 启停沿用 skills 的哲学——**配置文件就是全部状态**，不另存一份启用清单。
 * 区别是 MCP 不像 skill 那样能靠移动目录表达，所以用一个 `disabled` 字段
 * （Cursor / Windsurf 同款），仍然只有一份真相。
 */

/** 本地子进程。绝大多数 MCP server 是这种。 */
export interface McpStdioServer {
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

/** 远端 HTTP。Streamable HTTP，不是已废弃的 SSE。 */
export interface McpHttpServer {
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
  };
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
