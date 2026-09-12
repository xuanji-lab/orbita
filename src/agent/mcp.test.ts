/**
 * MCP 桥接的端到端：拉起一台真的 stdio server，验证工具能列出来、能调用。
 *
 * 不 mock SDK——这一刀的全部风险都在「我们和真实 server 的握手对不对」，
 * mock 掉就等于什么都没验。
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  /**
   * 返回形状必须是 pi 的 `AgentToolResult`：`content` 块数组 + `details`。
   * 上一版返的是 `{ output }`，pi 收到后 `content` 为空——模型看到一个什么都没说的工具结果。
   */
  test("真的能调用，结果是 pi 的 content 块数组", async () => {
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("call-1", { text: "在" }, undefined, undefined, undefined as never);
    assert.ok(Array.isArray(result.content));
    assert.deepEqual(result.content[0], { type: "text", text: "echo: 在" });
  });

  // 图片块的形状和 pi 的 ImageContent 完全一致，直接透传，不再降级成一行说明
  test("图片内容块原样透传给 pi", async () => {
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("call-2", { text: "x" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[1], { type: "image", data: "AAAA", mimeType: "image/png" });
  });

  /**
   * pi 只在 execute **抛出**时才把结果标成 isError（返回值上没有这个字段），
   * 所以 server 的业务失败必须翻成抛出，且 message 就是 server 给的文本。
   */
  test("server 报的业务失败翻成抛出，message 带上 server 的话", async () => {
    const boom = hub.currentTools().find((t) => t.name === "mcp__demo__boom");
    assert.ok(boom);
    await assert.rejects(
      boom.execute("call-3", {}, undefined, undefined, undefined as never),
      (error: unknown) => error instanceof Error && /炸了/.test(error.message),
    );
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

/** 热重载（1-1）的专用 hub：不共享上面的全局实例，重连会改它的状态 */
describe("McpHub.restart（热重载）", () => {
  test("换新配置：旧工具消失、新 server 的工具进来", async () => {
    const hub = new McpHub();
    await hub.start({ demo: { transport: "stdio", command: process.execPath, args: [FIXTURE] } });
    assert.ok(hub.currentTools().some((t) => t.name === "mcp__demo__echo"));

    await hub.restart({ two: { transport: "stdio", command: process.execPath, args: [FIXTURE] } });
    const names = hub.currentTools().map((t) => t.name).sort();
    assert.deepEqual(names, ["mcp__two__boom", "mcp__two__echo"]);
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("two"), "ready");
    await hub.dispose();
  });

  // 重连是拆掉重来的：一台坏的只脏它自己那格，别的照常服务
  test("重载后一台变坏不影响其它台", async () => {
    const hub = new McpHub();
    await hub.start({ ok: { transport: "stdio", command: process.execPath, args: [FIXTURE] } });
    await hub.restart({
      ok: { transport: "stdio", command: process.execPath, args: [FIXTURE] },
      bad: { transport: "stdio", command: "definitely-not-a-real-command-xyz", args: [] },
    });
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("ok"), "ready");
    assert.equal(statuses.get("bad"), "failed");
    assert.deepEqual(hub.currentTools().map((t) => t.name).sort(), [
      "mcp__ok__boom",
      "mcp__ok__echo",
    ]);
    await hub.dispose();
  });

  // 1-1 修复的回归锚：工具闭包在开机时定格，restart 换新 client 后旧会话照样能用
  test("跨 restart 的调用落到新 client——已开会话的工具在 reload 后照常工作", async () => {
    const hub = new McpHub();
    const server = { transport: "stdio" as const, command: process.execPath, args: [FIXTURE] };
    await hub.start({ demo: server });
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    await hub.restart({ demo: server }); // 同一台 server 拆掉重连
    const result = await echo.execute("call-reload", { text: "重载后" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[0], { type: "text", text: "echo: 重载后" });
    await hub.dispose();
  });

  test("server 被移除后，旧会话的调用报干净错误（不是撞死连接）", async () => {
    const hub = new McpHub();
    await hub.start({ demo: { transport: "stdio", command: process.execPath, args: [FIXTURE] } });
    const echo = hub.currentTools().find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    await hub.restart({}); // 配置里不再有 demo
    await assert.rejects(
      echo.execute("call-gone", { text: "x" }, undefined, undefined, undefined as never),
      /not connected.*removed by a reload/,
    );
    await hub.dispose();
  });

  /** stdio 的子进程随 stdin 关闭而退出——旧 client close 后不许有孤儿 */
  test("旧 client 全部 close，子进程真的退了（无孤儿）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-mcp-reload-"));
    const pidFile = join(dir, "child.pid");
    const hub = new McpHub();
    await hub.start({
      demo: {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
        env: { ORBITA_MCP_FIXTURE_PID_FILE: pidFile },
      },
    });
    assert.ok(hub.currentTools().some((t) => t.name === "mcp__demo__echo"));
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(pid));

    await hub.restart({});
    // close 是异步的：子进程退出可能晚一点，轮询等它真死（最多 5 秒）
    const deadline = Date.now() + 5_000;
    let dead = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        dead = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(dead, `子进程 ${pid} 在 restart 后 5 秒内没有退出`);
    await rm(dir, { recursive: true, force: true });
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
