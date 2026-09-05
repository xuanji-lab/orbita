/**
 * 测试夹具：一台最小的 MCP server，走 stdio。
 *
 * 用底层 `Server` 而不是 `McpServer.registerTool`，因为后者要 zod schema，
 * 而我们要验证的恰恰是**「server 给的是裸 JSON Schema，我们能原样转给 pi」**。
 *
 * 由 `mcp.test.ts` 以子进程方式拉起，不在应用调用路径上。
 */
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
  return {
    content: [
      { type: "text", text: `echo: ${text}` },
      // 非文本块：验证我们降级成一行说明而不是整个丢掉
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  };
});

await server.connect(new StdioServerTransport());
