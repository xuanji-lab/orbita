/**
 * 意图系统回答存档（/ingest）跟踪器的测试：正常结束才存、出错 / 取消 / 翻页
 * 不存、开关关掉不存、HTTP 失败只记日志。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IntentIngestTracker, type IngestDeps, type IngestHttp } from "./intent-ingest.ts";
import { LEGACY_CLOSING_SCAN_PROMPT as CLOSING_SCAN_PROMPT } from "../../shared/wrapup-scan.ts";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionRecord } from "../../shared/session.ts";

function userItem(text: string): SessionRecord {
  return { role: "user", id: "u", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantDone(text: string): AgentEvent {
  return {
    type: "progress",
    sessionId: "s1",
    progress: {
      type: "item_finished",
      item: {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 2,
        status: "complete",
        stopReason: "stop",
        model: { provider: "p", id: "m" },
      },
    },
  };
}

const recallDone: AgentEvent = {
  sessionId: "s1",
  turnId: "turn-1",
  type: "intentRecall",
  event: {
    type: "done",
    runId: "r1",
    injection: "块",
    needsFeedback: false,
    timing: { totalMs: 1, gateMs: 0, s1Ms: 1, s3Ms: 1, s4Ms: 1 },
  },
};

const phase = (value: "turn" | "idle"): AgentEvent => ({ type: "phase", sessionId: "s1", phase: value });

interface Harness {
  tracker: IntentIngestTracker;
  posts: { url: string; body: unknown }[];
}

function makeHarness(transcript: readonly SessionRecord[] = [userItem("问"), { role: "assistant", id: "a", content: [{ type: "text", text: "答的收尾段" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } } as SessionRecord], intentEnabled = true): Harness {
  const posts: { url: string; body: unknown }[] = [];
  const http: IngestHttp = {
    post: async (url, body) => {
      posts.push({ url, body });
      if (url.endsWith("/boom")) throw new Error("connection refused");
    },
  };
  const deps: IngestDeps = {
    http,
    load: async () => ({ title: "标题", transcript: [...transcript] }),
    readIntent: async () => (intentEnabled ? { baseUrl: "http://127.0.0.1:8723" } : null),
  };
  return { tracker: new IntentIngestTracker(deps), posts };
}

test("正常结束：recall done + assistant complete + idle → 存档，q 保留引用块（2026-10-09）", async () => {
  const quoted = '<quoted_context index="1" role="user" turn="1">\n引用\n</quoted_context>\n\n真正的问题';
  const h = makeHarness([
    userItem(quoted),
    { role: "assistant", id: "a", content: [{ type: "text", text: "答的收尾段" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } } as SessionRecord,
  ]);
  h.tracker.begin("s1", quoted);
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent(assistantDone("答"));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 1);
  const body = h.posts[0]?.body as { sessionId: string; turnId: string; title: string; q: string; a: string };
  assert.equal(h.posts[0]?.url, "http://127.0.0.1:8723/ingest");
  assert.equal(body.turnId, "turn-1");
  assert.equal(body.title, "标题");
  assert.equal(body.q, quoted, "引用块原样进 q，不再剥");
  assert.equal(body.a, "答的收尾段");
});

test("带粘贴文本的轮：全文拼进 q（原话后面、与发给模型同形）；begin 没带 pasted 时照旧只有原话", async () => {
  const h = makeHarness([
    userItem("帮我看这段"),
    { role: "assistant", id: "a", content: [{ type: "text", text: "答的收尾段" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } } as SessionRecord,
  ]);
  h.tracker.begin("s1", "帮我看这段", ["第一段粘贴\n多行也全文", "第二段"]);
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent(assistantDone("答"));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 1);
  assert.equal(
    (h.posts[0]?.body as { q: string }).q,
    "帮我看这段\n\n<pasted-text>\n第一段粘贴\n多行也全文\n</pasted-text>\n\n<pasted-text>\n第二段\n</pasted-text>",
  );
});

test("出错轮（没有 assistant complete）不存档", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", "问");
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 0);
});

test("取消轮（没有 recall done）不存档", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", "问");
  h.tracker.onEvent(assistantDone("答"));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 0);
});

test("abort 的半截回答（status 非 complete）不存档", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", "问");
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent({
    type: "progress",
    sessionId: "s1",
    progress: {
      type: "item_finished",
      item: { id: "a", role: "assistant", content: [{ type: "text", text: "半截" }], timestamp: 2, status: "aborted", stopReason: "aborted", model: { provider: "p", id: "m" } },
    },
  });
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 0);
});

test("被翻页的轮（phase turn 重开）不把旧答案带进新轮", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", "问");
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent(assistantDone("答"));
  h.tracker.onEvent(phase("turn")); // 抢跑翻页：上一轮没 settle，answered 清零
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 0);
});

test("HTTP 失败只记日志（不抛、不影响后续轮）", async () => {
  const posts: { url: string; body: unknown }[] = [];
  const deps: IngestDeps = {
    http: { post: async () => { throw new Error("refused"); } },
    load: async () => ({ title: "t", transcript: [userItem("问"), { role: "assistant", id: "a", content: [{ type: "text", text: "答" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } } as SessionRecord] }),
    readIntent: async () => ({ baseUrl: "http://127.0.0.1:8723" }),
  };
  void posts;
  const tracker = new IntentIngestTracker(deps);
  tracker.begin("s1", "问");
  tracker.onEvent(recallDone);
  tracker.onEvent(assistantDone("答"));
  tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  // 不抛错就是通过（失败只记日志）
});

/* ---------------- v5：会话级开关关的轮照常存档（turnId 从用户回显取） ---------------- */

const userEcho = (id: string): AgentEvent => ({
  type: "progress",
  sessionId: "s1",
  progress: {
    type: "item_started",
    item: { id, role: "user", content: [{ type: "text", text: "问" }], timestamp: 1 },
  },
});

test("v5 无 recall 的轮（会话级开关关）：用户回显 + assistant complete → 照常 /ingest，turnId 取回显 id", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", "问");
  h.tracker.onEvent(userEcho("echo-1"));
  h.tracker.onEvent(assistantDone("答"));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 1);
  assert.equal((h.posts[0] as { body: { turnId: string } }).body.turnId, "echo-1");
});

test("v5 只认本轮回显的第一条用户消息：召回后的组合文本回显不覆盖 turnId；recall done 与回显同 id 幂等", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", "问");
  h.tracker.onEvent(userEcho("echo-original"));
  h.tracker.onEvent(recallDone); // 同一个 id（runtime 把回显 id 传给 recall）
  h.tracker.onEvent(userEcho("echo-composed")); // 注入块 + 原话的组合回显
  h.tracker.onEvent(assistantDone("答"));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 1);
  assert.equal((h.posts[0] as { body: { turnId: string } }).body.turnId, "echo-original");
});

test("v5 readIntent 按会话读：全局关 + 这条会话手动开 → 存档；全局关 + 会话没开 → 不存", async () => {
  const posts: { url: string; body: unknown }[] = [];
  const deps: IngestDeps = {
    http: { post: async (url, body) => { posts.push({ url, body }); } },
    load: async () => ({ title: "t", transcript: [userItem("问"), { role: "assistant", id: "a", content: [{ type: "text", text: "答" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } } as SessionRecord] }),
    readIntent: async (sessionId) => (sessionId === "s-manual-on" ? { baseUrl: "http://127.0.0.1:8723" } : null),
  };
  const tracker = new IntentIngestTracker(deps);
  const assistantDoneFor = (sessionId: string): AgentEvent => ({
    type: "progress",
    sessionId,
    progress: {
      type: "item_finished",
      item: { id: "a", role: "assistant", content: [{ type: "text", text: "答" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } },
    },
  });
  tracker.begin("s-manual-on", "问");
  tracker.onEvent({ type: "progress", sessionId: "s-manual-on", progress: { type: "item_started", item: { id: "e1", role: "user", content: [{ type: "text", text: "问" }], timestamp: 1 } } });
  tracker.onEvent(assistantDoneFor("s-manual-on"));
  tracker.onEvent({ type: "phase", sessionId: "s-manual-on", phase: "idle" });
  tracker.begin("s-default", "问");
  tracker.onEvent({ type: "progress", sessionId: "s-default", progress: { type: "item_started", item: { id: "e2", role: "user", content: [{ type: "text", text: "问" }], timestamp: 1 } } });
  tracker.onEvent({ type: "progress", sessionId: "s-default", progress: { type: "item_finished", item: { id: "a", role: "assistant", content: [{ type: "text", text: "答" }], timestamp: 2, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } } } });
  tracker.onEvent({ type: "phase", sessionId: "s-default", phase: "idle" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts.length, 1);
  assert.equal((posts[0] as { body: { sessionId: string } }).body.sessionId, "s-manual-on");
});

test("收尾扫描的机器提问不存档（begin 拦）；回退后重发的同一条也拦（2026-10-08 用户定）", async () => {
  const h = makeHarness();
  h.tracker.begin("s1", CLOSING_SCAN_PROMPT);
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent(assistantDone('{"carryovers": []}'));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 0);
  // 扫描轮之后紧跟着一条真实提问：照常存档（begin 没被扫描轮占住）
  h.tracker.begin("s1", "真实的下一个问题");
  h.tracker.onEvent(recallDone);
  h.tracker.onEvent(assistantDone("真回答"));
  h.tracker.onEvent(phase("idle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.posts.length, 1);
  assert.equal((h.posts[0]?.body as { q: string }).q, "真实的下一个问题");
});
