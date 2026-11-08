/**
 * SSE 传输的端到端：在本机起一台真的 HTTP+SSE MCP server（SDK 的 SSEServerTransport），
 * 要求每个请求都带 `Authorization: Bearer k`（百度网盘就是这个形状），验证
 * 显式 `transport:"sse"` 的配置真能握手、列工具、调用，且 headers 在**开流的 GET**
 * 与**之后的 POST** 上都带了（只带一头的话服务端会 401，握手就过不去）。
 *
 * 不 mock SDK：风险全在「我们和真实 SSE 服务端握手对不对」。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpHub } from "./mcp.ts";

const TOKEN = "Bearer k";

let http: HttpServer;
let base = "";
/** 服务端见到的请求（方法 + 路径 + 是否带了对的 Authorization），断言「两头都带了」靠它 */
const seen: { method: string; path: string; authed: boolean }[] = [];
const transports = new Map<string, SSEServerTransport>();

function newMcpServer(): Server {
  const server = new Server({ name: "sse-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "ping", description: "回 pong", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "pong" }] }));
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", base);
  const authed = req.headers["authorization"] === TOKEN;
  seen.push({ method: req.method ?? "", path: url.pathname, authed });
  if (!authed) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    await newMcpServer().connect(transport);
    return;
  }
  if (req.method === "POST" && url.pathname === "/messages") {
    const transport = transports.get(url.searchParams.get("sessionId") ?? "");
    if (transport === undefined) {
      res.writeHead(404).end();
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }
  res.writeHead(404).end();
}

before(async () => {
  http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("SSE 传输", () => {
  test("transport:sse + Authorization：握手成功、列出工具、调用得到结果；GET 与 POST 都带了头", async () => {
    seen.length = 0;
    const hub = new McpHub();
    try {
      await hub.ensure("", { pan: { transport: "sse", url: `${base}/sse`, headers: { Authorization: TOKEN } } }, "");
      const tool = hub.toolsFor("").find((t) => t.name === "mcp__pan__ping");
      assert.ok(tool, "SSE server 的工具没列出来");
      const result = await tool.execute("id", {}, undefined, undefined, undefined as never);
      assert.deepEqual(result.content[0], { type: "text", text: "pong" });
      assert.equal(hub.describe()[0]?.status.kind, "ready");
      assert.ok(seen.some((r) => r.method === "GET" && r.path === "/sse" && r.authed), "开流的 GET 没带头");
      assert.ok(seen.some((r) => r.method === "POST" && r.path === "/messages" && r.authed), "后续 POST 没带头");
      assert.ok(seen.every((r) => r.authed), "有请求没带 Authorization");
    } finally {
      await hub.dispose();
    }
  });

  test("没带 token：服务端 401，状态是 failed 而不是静默空转", async () => {
    const hub = new McpHub();
    try {
      await hub.ensure("", { pan: { transport: "sse", url: `${base}/sse` } }, "");
      const status = hub.describe()[0]?.status;
      assert.equal(status?.kind, "failed");
      assert.deepEqual(hub.toolsFor(""), []);
    } finally {
      await hub.dispose();
    }
  });

  test("同一地址按 http（Streamable HTTP）去连 SSE 服务端：连不上，不会被悄悄当成 SSE", async () => {
    const hub = new McpHub();
    try {
      await hub.ensure("", { pan: { transport: "http", url: `${base}/sse`, headers: { Authorization: TOKEN } } }, "");
      assert.equal(hub.describe()[0]?.status.kind, "failed");
    } finally {
      await hub.dispose();
    }
  });
});
