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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
   * 因为每条会话创建时都会调它。
   */
  start(servers: Record<string, McpServer>): Promise<void> {
    if (this.started !== null) return this.started;
    this.servers = servers;
    this.started = this.connectAll(servers);
    return this.started;
  }

  /** 当前可用的工具。会话创建时取一次，作为 `customTools` 交给 pi。 */
  currentTools(): ToolDefinition[] {
    return this.tools;
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
    const client = new Client({ name: "orbita", version: "0.0.0" }, { capabilities: {} });
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
        tools.push(toPiTool(client, name, tool));
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

/**
 * MCP 工具 → pi 的 ToolDefinition。
 *
 * `inputSchema` 直接当 `parameters` 用：MCP 给的就是 JSON Schema，而 pi 只是把它
 * 转交给 provider 的 tool schema，不做 typebox 运行时校验（见
 * `tools/tool-definition-wrapper.js`，parameters 原样透传）。
 */
function toPiTool(client: Client, serverName: string, tool: McpToolShape): ToolDefinition {
  const publicName = qualifiedToolName(serverName, tool.name);
  return {
    name: publicName,
    label: `${serverName}: ${tool.name}`,
    description: tool.description ?? `${tool.name} (MCP: ${serverName})`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema 与 TSchema 结构兼容，pi 不做 typebox 校验
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
    async execute(_toolCallId, params, signal) {
      const result = await withTimeout(
        client.callTool(
          { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
          undefined,
          signal === undefined ? {} : { signal },
        ),
        CALL_TIMEOUT_MS,
        `${publicName} 调用超时`,
      );
      const text = renderContent(result.content);
      // MCP 的 isError 是业务级失败（不是传输失败），要如实告诉模型
      return result.isError === true
        ? { output: text, isError: true }
        : { output: text };
    },
  } as ToolDefinition;
}

/**
 * MCP 的返回是内容块数组。**只取模型看得懂的部分**：文本直接用，
 * 其余（图片、资源引用）降级成一行说明——凭空丢掉会让模型以为工具什么都没返回。
 */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      parts.push(item["text"]);
    } else if (typeof item["type"] === "string") {
      parts.push(`(${item["type"]} content omitted)`);
    }
  }
  return parts.join("\n");
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
