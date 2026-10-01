/**
 * MCP 客户端 —— 把外部 server 的工具接进 pi 的 tool registry。
 *
 * **跑在 agent 进程**，理由和 agent 本身跑独立进程是同一条（AGENTS.md「架构边界」）：
 * stdio server 是子进程，工具结果是大字符串，这些都不该和 UI 抢事件循环。
 *
 * **连接是进程级的，不是会话级的。** 一个 agent 进程托管 N 条会话，
 * 每条都各自拉起一份 `npx some-server` 会让子进程数量随会话数线性增长。
 * 所以这里连一次，所有会话共享同一批工具。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// 客户端握手里的版本号随包走，不另放一份字面量——政策是每次改动 patch +1，
// 硬编码的副本会在下一次 bump 时静默说谎。`with { type: "json" }` 是 node --test
// 原生加载本文件的要求（裸导入 JSON 报 ERR_IMPORT_ATTRIBUTE_MISSING）
import packageJson from "../../package.json" with { type: "json" };
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  describeServer,
  isHttpServer,
  qualifiedToolName,
  type McpServer,
  type McpServerInfo,
  type McpStatus,
} from "../shared/mcp.ts";

/** 连不上不该拖住建会话——超过这个时间就放弃这一台，别的照常。 */
const CONNECT_TIMEOUT_MS = 20_000;
/** 一次工具调用最多等这么久。MCP server 可能永远不回。 */
const CALL_TIMEOUT_MS = 120_000;

interface Connected {
  client: Client;
  tools: ToolDefinition[];
}

export class McpHub {
  private readonly clients = new Map<string, Client>();
  private readonly statuses = new Map<string, McpStatus>();
  private tools: ToolDefinition[] = [];
  private started: Promise<void> | null = null;
  private servers: Record<string, McpServer> = {};

  /**
   * 连上所有启用的 server。**只跑一次**——重复调用返回同一个 promise，
   * 因为每轮开机都会调它。
   */
  start(servers: Record<string, McpServer>): Promise<void> {
    if (this.started !== null) return this.started;
    this.servers = servers;
    this.started = this.connectAll(servers);
    return this.started;
  }

  /**
   * 配置变更后的重连（1-1 热重载）。旧 client 全部 close（stdio 的子进程随 stdin
   * 关闭而退出），再按新配置连一遍——同一台 server 也是先拆再连，不增量补。
   *
   * 先等在飞的 start 落定再拆：不等的话它会在拆完后把旧 tools 写回来。
   * 拆完到 start 之间没有 await，同 tick 内不会插进别的 start。
   */
  async restart(servers: Record<string, McpServer>): Promise<void> {
    await this.started?.catch(() => undefined);
    const closing = [...this.clients.values()].map((client) => client.close().catch(() => undefined));
    this.clients.clear();
    this.tools = [];
    this.statuses.clear();
    await Promise.all(closing);
    this.started = null;
    return this.start(servers);
  }

  /** 当前可用的工具。会话创建时取一次，作为 `customTools` 交给 pi。 */
  currentTools(): ToolDefinition[] {
    return this.tools;
  }

  /**
   * 工具调用经 hub 查**当前** client（1-1 修复）：热重载会 close 全部旧 client，
   * 而已开会话的工具闭包在开机时就定格了。查当前 client 的语义：同名 server
   * 重连后无缝落到新连接；被移除的 server 报干净错误，不是撞死传输。
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    publicName: string,
  ) {
    const client = this.clients.get(serverName);
    if (client === undefined) {
      throw new Error(
        `${publicName}: server "${serverName}" is not connected (it may have been removed by a reload)`,
      );
    }
    return withTimeout(
      client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal === undefined ? {} : { signal },
      ),
      CALL_TIMEOUT_MS,
      `${publicName} 调用超时`,
    );
  }

  /** 管理面要看的状态。 */
  describe(): McpServerInfo[] {
    return Object.entries(this.servers)
      .map(([name, server]) => ({
        name,
        detail: describeServer(server),
        status: this.statuses.get(name) ?? { kind: "disabled" as const },
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async dispose(): Promise<void> {
    const closing = [...this.clients.values()].map((client) =>
      client.close().catch(() => undefined),
    );
    this.clients.clear();
    this.tools = [];
    this.started = null;
    await Promise.all(closing);
  }

  /**
   * 每台并行连，**一台失败不影响其它台**：MCP server 是外部程序，
   * 装错命令、缺环境变量都是常态，不该让一台坏的挡住全部。
   */
  private async connectAll(servers: Record<string, McpServer>): Promise<void> {
    const entries = Object.entries(servers);
    for (const [name, server] of entries) {
      this.statuses.set(name, server.disabled === true ? { kind: "disabled" } : { kind: "connecting" });
    }
    const results = await Promise.all(
      entries.map(async ([name, server]): Promise<Connected | null> => {
        if (server.disabled === true) return null;
        try {
          return await this.connect(name, server);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.statuses.set(name, { kind: "failed", message });
          console.error(`[mcp] ${name} 连不上：${message}`);
          return null;
        }
      }),
    );
    this.tools = results.flatMap((r) => r?.tools ?? []);
  }

  private async connect(name: string, server: McpServer): Promise<Connected> {
    const client = new Client({ name: "orbita", version: packageJson.version }, { capabilities: {} });
    const transport = createTransport(server);
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 ${name} 超时`);
    this.clients.set(name, client);

    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    // 分页：server 可以分批给，不翻完就会少工具
    do {
      const page = await withTimeout(
        client.listTools(cursor === undefined ? {} : { cursor }),
        CONNECT_TIMEOUT_MS,
        `列 ${name} 的工具超时`,
      );
      for (const tool of page.tools) {
        tools.push(toPiTool(this, name, tool));
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    this.statuses.set(name, { kind: "ready", tools: tools.map((t) => t.name) });
    return { client, tools };
  }
}

function createTransport(server: McpServer): Transport {
  if (isHttpServer(server)) {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.headers === undefined ? {} : { headers: server.headers },
    }) as Transport;
  }
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    // 只把显式给的环境变量加到继承环境上；不做 scrub 是因为这些 server 由用户自己配，
    // 而它们往往正需要 PATH、HOME 这些来找到 node / npx。
    env: { ...filterEnv(process.env), ...(server.env ?? {}) },
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
  });
}

/** `process.env` 里可能有 undefined 值，SDK 的类型要求全是 string。 */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

interface McpToolShape {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** MCP 工具结果里模型看得懂的两种块——形状与 pi 的 `TextContent` / `ImageContent` 相同。 */
type McpResultContent = TextContent | ImageContent;

/**
 * MCP 工具 → pi 的 ToolDefinition。
 *
 * `inputSchema` 直接当 `parameters` 用：MCP 给的就是 JSON Schema，而 pi 只是把它
 * 转交给 provider 的 tool schema，不做 typebox 运行时校验（见
 * `tools/tool-definition-wrapper.js`，parameters 原样透传）。
 *
 * `execute` 的返回必须是 pi 的 `AgentToolResult`（`content` 块数组 + `details`）；
 * **错误靠 throw 表达**——pi 的 agent-loop 只在 execute 抛出时才把结果标成 isError，
 * 返回值上没有这个字段（pi-agent-core `agent-loop.js` 的 executePreparedToolCall）。
 */
/**
 * 调用经 hub 查**当前** client（1-1 修复）：热重载会 close 全部旧 client，而
 * 已开会话的工具闭包在开机时已定格——捕获旧 client 的话，reload 后同一台
 * server 的调用会落在死连接上直接报错。查当前 client 的语义：同名 server
 * 重连后无缝落到新连接；被移除的 server 报干净错误，不是撞死传输。
 */
function toPiTool(hub: McpHub, serverName: string, tool: McpToolShape): ToolDefinition {
  const publicName = qualifiedToolName(serverName, tool.name);
  return {
    name: publicName,
    label: `${serverName}: ${tool.name}`,
    description: tool.description ?? `${tool.name} (MCP: ${serverName})`,
    // JSON Schema 与 TSchema 结构兼容，pi 不做 typebox 校验，直接透传
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
    async execute(_toolCallId, params, signal) {
      const result = await hub.callTool(
        serverName,
        tool.name,
        (params ?? {}) as Record<string, unknown>,
        signal,
        publicName,
      );
      const content = toResultContent(result.content);
      // MCP 的 isError 是业务级失败（不是传输失败），要如实告诉模型——
      // 在 pi 里唯一的途径是抛出，它会把 message 当成结果文本并标 isError
      if (result.isError === true) {
        throw new Error(content.map((c) => (c.type === "text" ? c.text : "(image)")).join("\n"));
      }
      return { content, details: undefined };
    },
  };
}

/**
 * MCP 的返回是内容块数组。文本与图片的形状和 pi 的完全一致，直接透传；
 * 其余（资源引用、音频）降级成一行说明——凭空丢掉会让模型以为工具什么都没返回。
 */
function toResultContent(content: unknown): McpResultContent[] {
  if (!Array.isArray(content)) return [];
  const out: McpResultContent[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      out.push({ type: "text", text: item["text"] });
    } else if (
      item["type"] === "image" &&
      typeof item["data"] === "string" &&
      typeof item["mimeType"] === "string"
    ) {
      out.push({ type: "image", data: item["data"], mimeType: item["mimeType"] });
    } else if (typeof item["type"] === "string") {
      out.push({ type: "text", text: `(${item["type"]} content omitted)` });
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
