/**
 * 测试夹具：一台最小的 MCP server，走 stdio。
 *
 * 用底层 `Server` 而不是 `McpServer.registerTool`，因为后者要 zod schema，
 * 而我们要验证的恰恰是**「server 给的是裸 JSON Schema，我们能原样转给 pi」**。
 *
 * 由 `mcp.test.ts` 以子进程方式拉起，不在应用调用路径上。
 *
 * 两个环境变量都只给测试用：
 *   ORBITA_MCP_FIXTURE_PID_FILE —— 把 pid 写进去（热重载测试靠它断言「旧 client close 后
 *     子进程真的退出」，以及「同一工作区第二次开机没有重新拉起子进程」）
 *   ORBITA_MCP_FIXTURE_TAG      —— 设了就把身份标记追在 echo 后面。同名 server 在不同
 *     工作区各一份实例时，靠它断言调用真的落到了对的那一份（不设就不加，既有断言不受影响）
 *   ORBITA_MCP_FIXTURE_START_DELAY_MS —— 推迟 connect，模拟「连接比闲置窗口还慢」的
 *     server，专供清扫器「开机中的工作区不算闲置」的回归测试
 */
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "把收到的话原样回一遍",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "要回显的内容" } },
        required: ["text"],
      },
    },
    {
      name: "boom",
      description: "总是返回业务级失败",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name === "boom") {
    return { content: [{ type: "text", text: "炸了" }], isError: true };
  }
  const text = String((request.params.arguments as Record<string, unknown> | undefined)?.["text"] ?? "");
  const tag = process.env["ORBITA_MCP_FIXTURE_TAG"];
  return {
    content: [
      { type: "text", text: tag === undefined ? `echo: ${text}` : `echo: ${text} [${tag}]` },
      // 非文本块：验证我们降级成一行说明而不是整个丢掉
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  };
});

const pidFile = process.env["ORBITA_MCP_FIXTURE_PID_FILE"];
if (pidFile !== undefined) writeFileSync(pidFile, `${process.pid}\n`);

const startDelayMs = process.env["ORBITA_MCP_FIXTURE_START_DELAY_MS"];
if (startDelayMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, Number(startDelayMs)));
}

await server.connect(new StdioServerTransport());
