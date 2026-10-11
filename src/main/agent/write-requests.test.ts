/**
 * 写盘请求落地的账（4-3）：真 SkillStore / McpStore（临时目录）走一遍
 * applySkillWrite / applyMcpWrite。scope=workspace 按会话归属解析；
 * 会话没有工作区时报错不猜。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMcpWrite, applySkillWrite } from "./write-requests.ts";
import { SkillStore } from "../skill/store.ts";
import { McpStore } from "../mcp/store.ts";
import { SessionStore } from "../session/store.ts";
import type { AgentEvent } from "../../shared/agent-ipc.ts";

let dir = "";
let skills: SkillStore;
let mcp: McpStore;
let sessions: SessionStore;

const S1 = "11111111-2222-3333-4444-555555555555";
const S2 = "22222222-3333-4444-5555-666666666666";

/** 契约里 server 字段类型是规范后的 McpServer，但模型运行时传什么形状都可能
 *  （applyMcpWrite 的入口校验就是为这个差距立韵）——测试里用这把钥匙进 */
const asServer = (
  value: object,
): Extract<AgentEvent, { type: "mcpWriteRequest" }>["server"] => value as unknown as Extract<AgentEvent, { type: "mcpWriteRequest" }>["server"];

const skillEvent = (over: Partial<Extract<AgentEvent, { type: "skillWriteRequest" }>> = {}): Extract<AgentEvent, { type: "skillWriteRequest" }> => ({
  type: "skillWriteRequest",
  requestId: "r1",
  sessionId: S1,
  slug: "from-agent",
  name: "From Agent",
  description: "工具写进来的",
  body: "# 用法\n照着做。",
  scope: "global",
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-write-req-"));
  skills = new SkillStore(dir);
  mcp = new McpStore(dir);
  sessions = new SessionStore(join(dir, "sessions"));
  await skills.ensureDirs();
  await sessions.ensureSession({
    id: S1, title: "", titleSource: "derived", cwd: "/tmp", workspaceId: "ws-1",
    piSessionFile: "/tmp/pi.jsonl", pinned: false, archived: false, recentQueries: [],
    stats: null, providerId: "p", modelId: "m", mode: "plan", thinkingLevel: "medium", createdAt: 1, updatedAt: 1,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applySkillWrite（真 store）", () => {
  test("global：全文落盘（description/body 不丢——E2E 抓回过只落骨架的实现）+ 建链 + 回执带路径", async () => {
    const result = await applySkillWrite(skills, sessions, skillEvent());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 回执路径的分隔符随平台（Windows 是 \）——断言只认「skills 目录 / slug」这一段结构
    assert.match(result.path ?? "", /skills[/\\]from-agent$/);
    const meta = (await skills.list()).find((s) => s.slug === "from-agent");
    assert.equal(meta?.global, true);
    const content = await skills.read("from-agent");
    assert.equal(content?.name, "From Agent");
    assert.equal(content?.description, "工具写进来的");
    assert.match(content?.body ?? "", /照着做/);
  });

  test("workspace：按会话归属解析到 ws-1", async () => {
    const result = await applySkillWrite(skills, sessions, skillEvent({ scope: "workspace" }));
    assert.equal(result.ok, true);
    const meta = (await skills.list()).find((s) => s.slug === "from-agent");
    assert.deepEqual(meta?.workspaces, ["ws-1"]);
  });

  test("会话没有工作区：报错，不猜成 global", async () => {
    await sessions.ensureSession({
      id: S2, title: "", titleSource: "derived", cwd: "/tmp", workspaceId: null,
      piSessionFile: "/tmp/x.jsonl", pinned: false, archived: false, recentQueries: [],
      stats: null, providerId: "p", modelId: "m", mode: "plan", thinkingLevel: "medium", createdAt: 1, updatedAt: 1,
    });
    const result = await applySkillWrite(skills, sessions, skillEvent({ sessionId: S2, scope: "workspace" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /不属于任何工作区/);
  });

  test("已存在：改写内容并重链（模型改了再试不该被「已存在」卡死）", async () => {
    await applySkillWrite(skills, sessions, skillEvent());
    const again = await applySkillWrite(skills, sessions, skillEvent({ name: "改名了", description: "第二版" }));
    assert.equal(again.ok, true);
    const content = await skills.read("from-agent");
    assert.equal(content?.name, "改名了");
    assert.equal(content?.description, "第二版");
  });
});

describe("applyMcpWrite（真 store）", () => {
  test("并发两台（http + stdio）：两台都要落盘——读-改-写不串行化会丢更新", async () => {
    // 用户实测事故（2026-10-11）：模型一轮并发调两次 add_mcp_server，两次
    // mutate 都从同一份旧文件读起，后写的把先写的整条覆盖掉，而先写的已回
    // 「Server added」。两台必须都在。
    const [http, stdio] = await Promise.all([
      applyMcpWrite(mcp, async () => {}, () => undefined, {
        type: "mcpWriteRequest",
        requestId: "r-a",
        name: "mock-notes",
        server: { transport: "http", url: "http://localhost:4100/mock-notes" },
      }),
      applyMcpWrite(mcp, async () => {}, () => undefined, {
        type: "mcpWriteRequest",
        requestId: "r-b",
        name: "mock-weather",
        server: { transport: "stdio", command: "sleep", args: ["1000"] },
      }),
    ]);
    assert.equal(http.ok, true);
    assert.equal(stdio.ok, true);
    const saved = await mcp.read();
    assert.deepEqual(Object.keys(saved).sort(), ["mock-notes", "mock-weather"]);
  });

  test("加一台 + reload 被调 + 回执带状态", async () => {
    const reloaded: number[] = [];
    const result = await applyMcpWrite(
      mcp,
      async () => {
        reloaded.push(1);
      },
      (name) => (name === "agent-add" ? { kind: "ready", tools: [] } : undefined),
      { type: "mcpWriteRequest", requestId: "r2", name: "agent-add", server: { transport: "stdio", command: "node" } },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.status, { kind: "ready", tools: [] });
    assert.deepEqual(Object.keys(await mcp.read()), ["agent-add"]);
    assert.equal(reloaded.length, 1);
  });

  test("重名：报错不覆盖；reload 不被调", async () => {
    await mcp.add("dup", { transport: "stdio", command: "a" });
    let reloads = 0;
    const result = await applyMcpWrite(
      mcp,
      async () => {
        reloads += 1;
      },
      () => undefined,
      { type: "mcpWriteRequest", requestId: "r3", name: "dup", server: { transport: "stdio", command: "b" } },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /already exists/);
    assert.equal(reloads, 0);
  });

  test("Claude Desktop 的 type:「http」写法：落盘时规范成 transport:「http」，读回还在", async () => {
    const result = await applyMcpWrite(mcp, async () => {}, () => undefined, {
      type: "mcpWriteRequest",
      requestId: "r4",
      name: "remote",
      server: asServer({ type: "http", url: "https://example.com/mcp" }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(await mcp.read(), { remote: { transport: "http", url: "https://example.com/mcp" } });
  });

  test("type:「streamable-http」与只给 url 的极简写法：都规范成 http 落盘", async () => {
    await applyMcpWrite(mcp, async () => {}, () => undefined, {
      type: "mcpWriteRequest",
      requestId: "r5",
      name: "a",
      server: asServer({ type: "streamable-http", url: "https://a.example/mcp" }),
    });
    const bare = await applyMcpWrite(mcp, async () => {}, () => undefined, {
      type: "mcpWriteRequest",
      requestId: "r6",
      name: "b",
      server: asServer({ url: "https://b.example/mcp" }),
    });
    assert.equal(bare.ok, true);
    const saved = await mcp.read();
    assert.deepEqual(saved["a"], { transport: "http", url: "https://a.example/mcp" });
    assert.deepEqual(saved["b"], { transport: "http", url: "https://b.example/mcp" });
  });

  test("认不出的配置：报错不落盘，不回「Server added」；reload 不被调", async () => {
    let reloads = 0;
    const result = await applyMcpWrite(
      mcp,
      async () => {
        reloads += 1;
      },
      () => undefined,
      { type: "mcpWriteRequest", requestId: "r7", name: "broken", server: asServer({ type: "http" }) },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /认不出来/);
    assert.deepEqual(await mcp.read(), {});
    assert.equal(reloads, 0);
  });

  test("非法名字（拼不进工具名）：报错不落盘", async () => {
    const result = await applyMcpWrite(mcp, async () => {}, () => undefined, {
      type: "mcpWriteRequest",
      requestId: "r8",
      name: "bad name!",
      server: { transport: "stdio", command: "node" },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /非法 server 名/);
    assert.deepEqual(await mcp.read(), {});
  });
});
