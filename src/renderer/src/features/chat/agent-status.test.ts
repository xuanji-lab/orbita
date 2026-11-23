import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentLineOf, headerStatusOf } from "./agent-status.ts";

const base = { waiting: 0, running: 0, lastTitle: null, total: 0, waitingId: null };

describe("agentLineOf —— 侧栏行第二行", () => {
  test("等你压过在跑，在跑压过最近标题", () => {
    assert.deepEqual(agentLineOf({ ...base, waiting: 2, running: 5, lastTitle: "x", total: 9 }), { kind: "waiting", count: 2 });
    assert.deepEqual(agentLineOf({ ...base, running: 3, lastTitle: "x", total: 9 }), { kind: "working", count: 3 });
    assert.deepEqual(agentLineOf({ ...base, lastTitle: "整理文献", total: 1 }), { kind: "last", title: "整理文献" });
  });
  test("没有会话（或只有没标题的会话）是空态", () => {
    assert.deepEqual(agentLineOf(base), { kind: "empty" });
    assert.deepEqual(agentLineOf({ ...base, total: 4 }), { kind: "empty" });
  });
});

describe("headerStatusOf —— 页头胶囊说真话", () => {
  test("等你 > 在外面干活 > 就绪；等你时带直达的会话 id", () => {
    assert.deepEqual(headerStatusOf({ waiting: 1, running: 4, waitingId: "s1" }), { kind: "waiting", count: 1, sessionId: "s1" });
    assert.deepEqual(headerStatusOf({ waiting: 0, running: 4, waitingId: null }), { kind: "working", count: 4 });
    assert.deepEqual(headerStatusOf({ waiting: 0, running: 0, waitingId: null }), { kind: "ready" });
  });
});
