/**
 * MCP 客户端 —— 把外部 server 的工具接进 pi 的 tool registry。
 *
 * **跑在 agent 进程**，理由和 agent 本身跑独立进程是同一条（AGENTS.md「架构边界」）：
 * stdio server 是子进程，工具结果是大字符串，这些都不该和 UI 抢事件循环。
 *
 * **连接按 (工作区, server) 建，不是进程级一份。** 同一个 server 名在不同工作区
 * 往往是**不同的实例**（参数不同、数据不同）——比如一台论文工具在每个工作区里
 * 都指向那一篇论文的目录。共享一份连接就会串号，而串号是静默的。
 *
 * 粒度停在「工作区」而不是「会话」：同一工作区的多条会话共用一份，否则子进程
 * 数量会随会话数线性增长。**只连当前这轮要用的工作区**——用户没打开的工作区
 * 不会被拉起来；**闲置超时的工作区会被回收**（`SCOPE_IDLE_MS`），下次开机重连。
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
  isHttpServer,
  qualifiedToolName,
  type McpServer,
  type McpStatus,
  type McpStatusSnapshot,
} from "../shared/mcp.ts";

/**
 * 一个工作区多久没有任何开机/调用，它的实例就整批回收（拆连接 → stdio 子进程退出
 * → server 侧的资源随之释放，比如 aw-mcp 挂在论文 state 上的锁）。回收的是「资源占用」
 * 不是「配置」——下次开机 `ensure` 原样重连。30 分钟：写稿节奏里两轮隔多久都正常，
 * 但「上午开过 paper3、下午都在写稿」不该让 paper3 的进程和锁挂一整天。
 */
const SCOPE_IDLE_MS = 30 * 60_000;
/** 清扫节拍。 */
const SWEEP_MS = 60_000;

/** 连不上不该拖住建会话——超过这个时间就放弃这一台，别的照常。 */
const CONNECT_TIMEOUT_MS = 20_000;
/** 一次工具调用最多等这么久。MCP server 可能永远不回。 */
const CALL_TIMEOUT_MS = 120_000;

interface Connected {
  client: Client;
  tools: ToolDefinition[];
}

/** 一个 (工作区, server) 实例。**同一个 server 名在不同工作区是两份不同的东西。** */
interface Instance {
  /** 工作区 id；`""` = 不属于任何工作区（Home 会话）。 */
  scope: string;
  serverName: string;
  server: McpServer;
  /** 绑定给模型看的工作区根（就是 `${workspaceFolder}` 换成的那个值）。`""` = 没绑定 */
  label: string;
  client: Client | null;
  status: McpStatus;
  tools: ToolDefinition[];
}

/** scope 与 server 名都不含 NUL，拼 key 拼不出歧义。 */
const KEY_SEP = "\u0000";

/** 状态优先级：ready > connecting > failed > disabled。 */
function statusRank(status: McpStatus): number {
  if (status.kind === "ready") return 3;
  if (status.kind === "connecting") return 2;
  if (status.kind === "failed") return 1;
  return 0;
}

export class McpHub {
  private readonly instances = new Map<string, Instance>();
  /**
   * 见过的配置（跨工作区取并集）。**只给 `describe()` 用**：管理面是全局的，
   * 一个工作区都没打开时也要看得出「配了哪些 server」。
   */
  private readonly seen = new Map<string, McpServer>();
  /**
   * 重连代数。连接是异步的，拆到一半时在飞的 `connect` 会把旧连接写回来——
   * 每次 `reset` 加一，落地的连接发现代数变了就自我作废（否则热重载后
   * 会留一批指向旧配置的活连接）。
   */
  private generation = 0;
  /** scope → 最近一次开机或调用的时间戳。清扫器按它回收闲置工作区的实例。 */
  private readonly lastUsed = new Map<string, number>();
  private readonly idleMs: number;
  private readonly sweepMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  /** 回收真的拆掉了实例后调一次（runtime 挂它给面板推新快照——不然面板上还是陈旧的就绪）。 */
  onIdleDrop: (() => void) | null = null;

  constructor(options: { idleMs?: number; sweepMs?: number } = {}) {
    this.idleMs = options.idleMs ?? SCOPE_IDLE_MS;
    this.sweepMs = options.sweepMs ?? SWEEP_MS;
  }

  /**
   * 让 `scope` 这批 server 连上。**每轮开机都调**，所以必须幂等：
   * 已经在、配置也没变的不动；配置变了或这台被删了就拆掉重来。
   *
   * **只连这一轮要用的工作区**，别的不会被拉起来。连过的留着，直到闲置超时
   * 被清扫器回收（`SCOPE_IDLE_MS`）——那之前换回去不必重连。
   */
  async ensure(scope: string, servers: Record<string, McpServer>, label: string): Promise<void> {
    const generation = this.generation;
    this.touch(scope);
    this.startSweeper();
    for (const [name, server] of Object.entries(servers)) this.seen.set(name, server);
    const wanted = new Set(Object.keys(servers));
    const doomed = [...this.instances.values()].filter(
      (instance) =>
        instance.scope === scope &&
        (!wanted.has(instance.serverName) ||
          JSON.stringify(instance.server) !== JSON.stringify(servers[instance.serverName])),
    );
    await Promise.all(doomed.map((instance) => this.drop(this.key(scope, instance.serverName))));
    await Promise.all(
      Object.entries(servers)
        .filter(([name]) => !this.instances.has(this.key(scope, name)))
        .map(([name, server]) => this.add(scope, name, server, label, generation)),
    );
  }

  /** 这个工作区此刻可用的工具。每轮开机取一次，作为 `customTools` 交给 pi。 */
  toolsFor(scope: string): ToolDefinition[] {
    return this.instancesIn(scope).flatMap((instance) => instance.tools);
  }

  /**
   * 工具调用按 `(scope, server)` 查**当前** client（1-1 修复）：热重载会 close
   * 全部旧 client，而已开会话的工具闭包在开机时就定格了。查当前 client 的语义：
   * 同名 server 重连后无缝落到新连接；被移除的 server 报干净错误，不是撞死传输。
   */
  async callTool(
    scope: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    publicName: string,
  ) {
    this.touch(scope);
    const client = this.instances.get(this.key(scope, serverName))?.client ?? null;
    if (client === null) {
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

  /**
   * 报给主进程的连接状态快照。**一行一台 server**，不是一行一个实例：一台 server
   * 在几个工作区里各有一份实例，逐实例列出来会把同一台重复 N 遍，而快照要回答的是
   * 「这台 server 能不能用」——取各实例里最可用的那个状态。
   * **只报状态**：列表的真源是配置文件（白名单、定义来源都在文件里），主进程拿
   * 这份快照叠状态，不拿它当列表。
   */
  describe(): McpStatusSnapshot {
    const statuses = new Map<string, McpStatus>();
    for (const instance of this.instances.values()) {
      const previous = statuses.get(instance.serverName);
      statuses.set(
        instance.serverName,
        previous === undefined ? instance.status : mergeStatus(previous, instance.status),
      );
    }
    return [...this.seen.entries()]
      .map(([name, server]) => ({
        name,
        // 没有实例 = 这个工作区还没打开过（或刚 reload 完 / 闲置被回收），如实说「还没连」
        status:
          statuses.get(name) ??
          (server.disabled === true ? { kind: "disabled" as const } : { kind: "connecting" as const }),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * 热重载：全拆。**下一轮开机按新配置重建**——主进程不必再送一份配置过来，
   * 因为每轮开机本来就会送该工作区那一份（`ensure`）。
   */
  async reset(): Promise<void> {
    this.generation += 1;
    await Promise.all([...this.instances.keys()].map((key) => this.drop(key)));
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.reset();
    this.seen.clear();
    this.lastUsed.clear();
  }

  private touch(scope: string): void {
    this.lastUsed.set(scope, Date.now());
  }

  /** 首次有工作区开机时启动；unref——这个计时器不许拖着进程不退。 */
  private startSweeper(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => void this.sweepIdle(), this.sweepMs);
    this.sweepTimer.unref();
  }

  /**
   * 回收闲置 scope 的整批实例（同一生死：一个工作区没人用了，它的 server 都收工）。
   * 「正在跑的轮不受影响」这一保证在这里不成立：一轮闲置窗口内没有任何 MCP 调用的
   * 极端情况会被拆掉，它的下一次调用报「not connected」干净错误，下一轮开机重连。
   */
  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    const doomed = [...this.lastUsed.entries()].filter(([, at]) => now - at > this.idleMs);
    if (doomed.length === 0) return;
    // 记账只删「还是当时那笔」的——清扫在飞的途中这个 scope 又开机了，新时间戳不许抹
    for (const [scope, at] of doomed) {
      if (this.lastUsed.get(scope) === at) this.lastUsed.delete(scope);
    }
    const doomedScopes = new Set(doomed.map(([scope]) => scope));
    const doomedInstances = [...this.instances.values()].filter((instance) =>
      doomedScopes.has(instance.scope),
    );
    await Promise.all(
      doomedInstances.map((instance) => this.drop(this.key(instance.scope, instance.serverName), instance)),
    );
    if (doomedInstances.length > 0) this.onIdleDrop?.();
  }

  private key(scope: string, serverName: string): string {
    return `${scope}${KEY_SEP}${serverName}`;
  }

  /** 按 server 名排序，工具顺序不随 Map 插入序漂移。 */
  private instancesIn(scope: string): Instance[] {
    return [...this.instances.values()]
      .filter((instance) => instance.scope === scope)
      .sort((a, b) => (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0));
  }

  /**
   * 连一台，**失败不影响其它台**：MCP server 是外部程序，装错命令、缺环境变量
   * 都是常态，不该让一台坏的挡住全部。失败如实记在状态里（不抛），面板看得见。
   */
  private async add(
    scope: string,
    serverName: string,
    server: McpServer,
    label: string,
    generation: number,
  ): Promise<void> {
    const instance: Instance = {
      scope,
      serverName,
      server,
      label,
      client: null,
      status: server.disabled === true ? { kind: "disabled" } : { kind: "connecting" },
      tools: [],
    };
    const key = this.key(scope, serverName);
    this.instances.set(key, instance);
    if (server.disabled === true) return;
    try {
      const connected = await this.connect(scope, serverName, server, label);
      // 连接期间发生了热重载（或这一份已被换掉）→ 这份连接作废，别写回表里
      if (generation !== this.generation || this.instances.get(key) !== instance) {
        await connected.client.close().catch(() => undefined);
        return;
      }
      instance.client = connected.client;
      instance.tools = connected.tools;
      instance.status = { kind: "ready", tools: connected.tools.map((tool) => tool.name) };
      // 闲置计时从「能用了」起算，不从「开始连」算——连接慢不该让刚连上的实例立刻被回收
      this.touch(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      instance.status = { kind: "failed", message };
      console.error(`[mcp] ${serverName}（工作区 ${label === "" ? "无" : label}）连不上：${message}`);
    }
  }

  /**
   * 传了 `expected` 就只在这份实例还是表里的那一份时才拆——清扫/重连在飞的途中，
   * 同一个 key 可能已经被 ensure 换上了新实例，新实例不许被旧决策顺手拆掉。
   */
  private async drop(key: string, expected?: Instance): Promise<void> {
    const instance = this.instances.get(key);
    if (instance === undefined) return;
    if (expected !== undefined && instance !== expected) return;
    this.instances.delete(key);
    await instance.client?.close().catch(() => undefined);
  }

  private async connect(
    scope: string,
    serverName: string,
    server: McpServer,
    label: string,
  ): Promise<Connected> {
    const client = new Client({ name: "orbita", version: packageJson.version }, { capabilities: {} });
    await withTimeout(
      client.connect(createTransport(server)),
      CONNECT_TIMEOUT_MS,
      `连接 ${serverName} 超时`,
    );
    try {
      const tools: ToolDefinition[] = [];
      let cursor: string | undefined;
      // 分页：server 可以分批给，不翻完就会少工具
      do {
        const page = await withTimeout(
          client.listTools(cursor === undefined ? {} : { cursor }),
          CONNECT_TIMEOUT_MS,
          `列 ${serverName} 的工具超时`,
        );
        for (const tool of page.tools) tools.push(toPiTool(this, scope, serverName, label, tool));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { client, tools };
    } catch (error) {
      // 握手成了但列工具失败：子进程已经起来了，不 close 就漏一个进程
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}

/** ready > connecting > failed > disabled；都是 ready 就把工具名取并集。 */
function mergeStatus(a: McpStatus, b: McpStatus): McpStatus {
  if (statusRank(b) > statusRank(a)) return b;
  if (statusRank(b) < statusRank(a)) return a;
  if (a.kind === "ready" && b.kind === "ready") {
    return { kind: "ready", tools: [...new Set([...a.tools, ...b.tools])] };
  }
  return a;
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
 *
 * `scope` 在这里被闭包捕获：这个工具对象只属于那一个工作区，调用落回那个工作区的
 * 那份连接（热重载后同名 server 无缝落到新连接）。
 */
function toPiTool(
  hub: McpHub,
  scope: string,
  serverName: string,
  /** 绑定的工作区根；`""` = 没绑定，不往描述里加那一行 */
  label: string,
  tool: McpToolShape,
): ToolDefinition {
  const publicName = qualifiedToolName(serverName, tool.name);
  const description = tool.description ?? `${tool.name} (MCP: ${serverName})`;
  return {
    name: publicName,
    label: `${serverName}: ${tool.name}`,
    /*
     * 绑了工作区的实例要把绑定写进描述：同一个工具名在不同工作区指向不同的 server
     * 实例（不同参数、不同数据），而模型只有看到绑定才可能发现「用户说的不是这一篇」。
     * 这是读侧的失配信号，与 aw-mcp 自己的 P0-1 是同一件事。
     */
    description:
      label === ""
        ? description
        : `${description}\n\n(This MCP instance is bound to the workspace: ${label})`,
    // JSON Schema 与 TSchema 结构兼容，pi 不做 typebox 校验，直接透传
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
    async execute(_toolCallId, params, signal) {
      const result = await hub.callTool(
        scope,
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
