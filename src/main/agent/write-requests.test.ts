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
    stats: null, providerId: "p", modelId: "m", mode: "plan", createdAt: 1, updatedAt: 1,
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
    assert.match(result.path ?? "", /skills\/from-agent$/);
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
      stats: null, providerId: "p", modelId: "m", mode: "plan", createdAt: 1, updatedAt: 1,
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
  test("加一台 + reload 被调 + 回执带状态", async () => {
    const reloaded: string[][] = [];
    const result = await applyMcpWrite(
      mcp,
      async (servers) => {
        reloaded.push(Object.keys(servers));
      },
      (name) => (name === "agent-add" ? { kind: "ready" } : undefined),
      { type: "mcpWriteRequest", requestId: "r2", name: "agent-add", server: { transport: "stdio", command: "node" } },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.status, { kind: "ready" });
    assert.deepEqual(Object.keys(await mcp.read()), ["agent-add"]);
    assert.deepEqual(reloaded, [["agent-add"]]);
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
});
