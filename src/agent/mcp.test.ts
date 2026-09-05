/**
 * MCP 桥接的端到端：拉起一台真的 stdio server，验证工具能列出来、能调用。
 *
 * 不 mock SDK——这一刀的全部风险都在「我们和真实 server 的握手对不对」，
 * mock 掉就等于什么都没验。
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { McpHub } from "./mcp.ts";
import { parseMcpConfig, qualifiedToolName } from "../shared/mcp.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture-server.ts", import.meta.url));

const hub = new McpHub();

before(async () => {
  await hub.start({
    demo: { transport: "stdio", command: process.execPath, args: [FIXTURE] },
    off: { transport: "stdio", command: process.execPath, args: [FIXTURE], disabled: true },
    broken: { transport: "stdio", command: "definitely-not-a-real-command-xyz", args: [] },
  });
});

after(async () => {
  await hub.dispose();
});

describe("McpHub", () => {
  test("连上的 server 的工具带 mcp__ 前缀进来", () => {
    const names = hub.currentTools().map((t) => t.name).sort();
    assert.deepEqual(names, [qualifiedToolName("demo", "boom"), qualifiedToolName("demo", "echo")]);
  });

  // 多台 server 很容易各自都有 search，不加前缀就会互相覆盖
  test("前缀是 mcp__<server>__<tool>", () => {
    assert.equal(qualifiedToolName("demo", "echo"), "mcp__demo__echo");
  });

  test("server 给的 JSON Schema 原样成为工具参数", () => {
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.deepEqual(echo?.parameters, {
      type: "object",
      properties: { text: { type: "string", description: "要回显的内容" } },
      required: ["text"],
    });
  });

  test("description 从 server 带过来", () => {
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.equal(echo?.description, "把收到的话原样回一遍");
  });

  test("真的能调用，拿到文本结果", async () => {
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("call-1", { text: "在" }, undefined, undefined, undefined as never);
    assert.match(String(result.output), /echo: 在/);
  });

  // 凭空丢掉会让模型以为工具什么都没返回
  test("非文本内容块降级成一行说明，不整个丢掉", async () => {
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("call-2", { text: "x" }, undefined, undefined, undefined as never);
    assert.match(String(result.output), /image content omitted/);
  });

  test("server 报的业务失败如实带上 isError", async () => {
    const boom = hub.currentTools().find((t) => t.name === "mcp__demo__boom");
    assert.ok(boom);
    const result = await boom.execute("call-3", {}, undefined, undefined, undefined as never);
    assert.equal(result.isError, true);
    assert.match(String(result.output), /炸了/);
  });

  // MCP server 是外部程序，装错命令是常态，不该让一台坏的挡住全部
  test("一台连不上不影响其它台", () => {
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("demo"), "ready");
    assert.equal(statuses.get("broken"), "failed");
  });

  test("disabled 的不连，也不出现在工具里", () => {
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("off"), "disabled");
    assert.equal(hub.currentTools().some((t) => t.name.startsWith("mcp__off__")), false);
  });
});

describe("parseMcpConfig", () => {
  test("认 Claude Desktop 的 mcpServers 格式", () => {
    const parsed = parseMcpConfig({
      mcpServers: { fs: { command: "npx", args: ["-y", "server-filesystem", "/tmp"] } },
    });
    assert.deepEqual(parsed["fs"], {
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-filesystem", "/tmp"],
    });
  });

  test("http 传输另算一支", () => {
    const parsed = parseMcpConfig({
      mcpServers: { remote: { transport: "http", url: "https://example.com/mcp" } },
    });
    assert.deepEqual(parsed["remote"], { transport: "http", url: "https://example.com/mcp" });
  });

  test("坏掉的一条跳过，不挡住其它 server", () => {
    const parsed = parseMcpConfig({
      mcpServers: { good: { command: "node" }, bad: { nothing: true }, alsoBad: null },
    });
    assert.deepEqual(Object.keys(parsed), ["good"]);
  });

  // 工具名会进 LLM 的 tool schema，各家 provider 对字符集都有要求
  test("名字不能拼进工具名的 server 直接跳过", () => {
    const parsed = parseMcpConfig({ mcpServers: { "bad name!": { command: "node" } } });
    assert.deepEqual(Object.keys(parsed), []);
  });

  test("整个文件不是对象时返回空，不抛", () => {
    assert.deepEqual(parseMcpConfig(null), {});
    assert.deepEqual(parseMcpConfig("nope"), {});
    assert.deepEqual(parseMcpConfig({}), {});
  });
});
