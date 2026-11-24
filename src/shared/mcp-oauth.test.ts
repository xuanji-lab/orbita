import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMcpConfig, parseServer } from "./mcp.ts";
import { sameMcpUrl } from "./mcp-oauth.ts";

describe("sameMcpUrl：凭据绑定登录时的地址", () => {
  test("同源同路径同查询串算同一个；末尾斜杠、大小写的主机名不算不同", () => {
    assert.equal(sameMcpUrl("https://mcp.notion.com/mcp", "https://mcp.notion.com/mcp"), true);
    assert.equal(sameMcpUrl("https://mcp.notion.com/mcp", "https://mcp.notion.com/mcp/"), true);
    assert.equal(sameMcpUrl("https://MCP.notion.com/mcp", "https://mcp.notion.com/mcp"), true);
    assert.equal(sameMcpUrl("https://x.com", "https://x.com/"), true);
  });

  test("换了主机、协议、端口、路径、查询串，或者认不出的地址：一律不同（不把 token 带过去）", () => {
    assert.equal(sameMcpUrl("https://mcp.notion.com/mcp", "https://evil.example.com/mcp"), false);
    assert.equal(sameMcpUrl("https://mcp.notion.com/mcp", "http://mcp.notion.com/mcp"), false);
    assert.equal(sameMcpUrl("https://mcp.notion.com/mcp", "https://mcp.notion.com:8443/mcp"), false);
    assert.equal(sameMcpUrl("https://mcp.notion.com/mcp", "https://mcp.notion.com/sse"), false);
    assert.equal(sameMcpUrl("https://a.com/mcp?x=1", "https://a.com/mcp?x=2"), false);
    assert.equal(sameMcpUrl("https://a.com/mcp", "not a url"), false);
    assert.equal(sameMcpUrl("", ""), false);
  });
});

describe("mcp.json 里的 auth 标记", () => {
  test('远端条目写 "auth": "oauth" 会被保留；别的值、stdio 条目上的 auth 一律丢掉', () => {
    assert.deepEqual(parseServer({ url: "https://mcp.notion.com/mcp", auth: "oauth" }), { transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" });
    assert.deepEqual(parseServer({ type: "sse", url: "https://x.com/sse", auth: "oauth" }), { transport: "sse", url: "https://x.com/sse", auth: "oauth" });
    assert.deepEqual(parseServer({ url: "https://x.com/mcp", auth: "bearer" }), { transport: "http", url: "https://x.com/mcp" });
    assert.deepEqual(parseServer({ command: "node", auth: "oauth" }), { transport: "stdio", command: "node" });
  });

  test("整份配置读回不丢标记，且不会把任何 token 字段当成配置带出来", () => {
    const parsed = parseMcpConfig({
      mcpServers: { notion: { url: "https://mcp.notion.com/mcp", auth: "oauth", access_token: "leak", refresh_token: "leak" } },
    });
    assert.deepEqual(parsed, { notion: { transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" } });
  });
});
