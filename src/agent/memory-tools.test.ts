/**
 * 记忆工具（memory-tools.ts）——参数翻成 memoryToolRequest、回执翻成工具结果、失败抛给模型、
 * 使用说明讲判断力。纯模块直测（node --test）：broker 的发送端用桩接住请求事件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import {
  createMemoryTools,
  describeMemoryOutcome,
  MEMORY_TOOL_NAMES,
  MEMORY_TOOLS_GUIDELINE,
} from "./memory-tools.ts";
import { MEMORY_TOOLS } from "../shared/permission.ts";
import type { MemoryEntry } from "../shared/memory.ts";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_1a2b3c4d-0000-4000-8000-000000000000",
    type: "preference",
    text: "用户要求汇报写成三条要点",
    keywords: [],
    layer: "workspace",
    scopeId: "ws-1",
    sessionId: "s1",
    turns: [3],
    at: new Date(2026, 9, 29).getTime(),
    episodeId: "",
    source: "agent",
    ...overrides,
  };
}

function setup() {
  const sent: Record<string, unknown>[] = [];
  const broker = new RequestBroker((event) => sent.push(event as Record<string, unknown>));
  const tools = createMemoryTools(broker, "s1", { scope: { workspaceId: "ws-1", cwd: "/repo" }, turn: () => 3 });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { sent, broker, byName };
}

type Execute = (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }>;

test("工具名与权限名单同源（三档放行靠 MEMORY_TOOLS）", () => {
  assert.deepEqual([...MEMORY_TOOL_NAMES], [...MEMORY_TOOLS]);
  assert.deepEqual([...setup().byName.keys()], [...MEMORY_TOOL_NAMES]);
});

test("memory_revise：带会话、轮号、作用域发请求；回执翻成说明改了什么的结果", async () => {
  const { sent, broker, byName } = setup();
  const run = (byName.get("memory_revise")!.execute as unknown as Execute)("t1", {
    id: " mem_1a2b3c4d ",
    text: "用户要求汇报写成三条要点",
    reason: "用户说不对",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const request = sent[0]!;
  assert.equal(request["type"], "memoryToolRequest");
  assert.equal(request["sessionId"], "s1");
  assert.equal(request["turn"], 3);
  assert.deepEqual(request["scope"], { workspaceId: "ws-1", cwd: "/repo" });
  assert.deepEqual(request["call"], { op: "revise", entryId: "mem_1a2b3c4d", text: "用户要求汇报写成三条要点", reason: "用户说不对" });
  broker.resolve(String(request["requestId"]), {
    ok: true,
    entries: [entry(), entry({ id: "mem_99999999-x", text: "旧", status: "stale", source: "chat" })],
  });
  const result = await run;
  const text = result.content[0]!.text;
  assert.ok(text.includes("mem_99999999 is now stale"));
  assert.ok(text.includes("[mem_1a2b3c4d · 2026-10-29 · preference · this workspace] 用户要求汇报写成三条要点"));
});

test("失败回执抛给模型；缺参数不发请求", async () => {
  const { sent, broker, byName } = setup();
  const retire = byName.get("memory_retire")!.execute as unknown as Execute;
  await assert.rejects(retire("t1", { id: "mem_1a2b3c4d" }), /reason/);
  assert.equal(sent.length, 0);
  const run = retire("t2", { id: "mem_1a2b3c4d", reason: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  broker.resolve(String(sent[0]!["requestId"]), { ok: false, error: "找不到 mem_1a2b3c4d" });
  await assert.rejects(run, /找不到/);
});

test("search 的结果列出 id · 日期 · 类型 · 层；空结果明说", () => {
  assert.equal(describeMemoryOutcome({ op: "search", query: "q" }, []), "No matching memory entries.");
  const text = describeMemoryOutcome({ op: "search", query: "q" }, [entry({ layer: "user" })]);
  assert.ok(text.includes("· all workspaces]"));
});

test("使用说明：讲纠错要动手、不要每轮动、不要拿它存新东西、不要让用户确认", () => {
  assert.ok(MEMORY_TOOLS_GUIDELINE.includes("memory_revise"));
  assert.ok(MEMORY_TOOLS_GUIDELINE.includes("Do not just agree in your reply"));
  assert.ok(MEMORY_TOOLS_GUIDELINE.includes("do not touch it every turn"));
  assert.ok(MEMORY_TOOLS_GUIDELINE.includes("do not store new facts"));
  assert.ok(MEMORY_TOOLS_GUIDELINE.includes("do not ask the user to confirm"));
});
