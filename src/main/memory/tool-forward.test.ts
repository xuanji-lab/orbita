/**
 * 记忆工具的主进程转发（tool-forward.ts）——子会话的写一律拒、作用域在主进程解析。
 * 纯模块直测（node --test）：meta 与服务注入桩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { forwardMemoryTool, type MemoryToolForwardDeps } from "./tool-forward.ts";
import type { MemoryAgentCall } from "../../shared/memory.ts";

function deps(meta: { parentId?: string } | null, running = true) {
  const forwarded: { scopeId: string; call: MemoryAgentCall; turn: number }[] = [];
  let ensured = 0;
  const value: MemoryToolForwardDeps = {
    readMeta: async () => meta,
    ensureStarted: async () => {
      ensured += 1;
      return true;
    },
    isRunning: () => running,
    agentTool: async (input) => {
      forwarded.push(input);
      return { ok: true, entries: [] };
    },
  };
  return { value, forwarded, ensured: () => ensured };
}

function event(call: MemoryAgentCall) {
  return {
    type: "memoryToolRequest" as const,
    requestId: "r1",
    sessionId: "s1",
    turn: 3,
    scope: { workspaceId: "ws-1", cwd: "/repo" },
    call,
  };
}

const REVISE: MemoryAgentCall = { op: "revise", entryId: "mem_1", text: "新", reason: "r" };

test("根会话：写照转，作用域按 workspaceId ?? cwd 解析", async () => {
  const d = deps({});
  assert.deepEqual(await forwardMemoryTool(d.value, event(REVISE)), { ok: true, entries: [] });
  assert.equal(d.forwarded[0]?.scopeId, "ws-1");
  assert.equal(d.forwarded[0]?.turn, 3);
  const home = deps({});
  await forwardMemoryTool(home.value, { ...event(REVISE), scope: { workspaceId: null, cwd: "/home/x" } });
  assert.equal(home.forwarded[0]?.scopeId, "/home/x");
});

test("子会话（或 meta 读不到）：revise / retire 拒，不转发；search 放行", async () => {
  for (const meta of [{ parentId: "p1" }, null]) {
    const d = deps(meta);
    const revise = await forwardMemoryTool(d.value, event(REVISE));
    assert.equal(revise.ok, false);
    const retire = await forwardMemoryTool(d.value, event({ op: "retire", entryId: "mem_1", reason: "r" }));
    assert.equal(retire.ok, false);
    assert.equal(d.forwarded.length, 0);
    assert.equal((await forwardMemoryTool(d.value, event({ op: "search", query: "q" }))).ok, true);
    assert.equal(d.forwarded.length, 1);
  }
});

test("服务不在先拉一把；转发抛错兜成 ok:false", async () => {
  const d = deps({}, false);
  await forwardMemoryTool(d.value, event({ op: "search", query: "q" }));
  assert.equal(d.ensured(), 1);
  const broken: MemoryToolForwardDeps = { ...d.value, agentTool: async () => Promise.reject(new Error("炸了")) };
  assert.deepEqual(await forwardMemoryTool(broken, event({ op: "search", query: "q" })), { ok: false, error: "炸了" });
});
