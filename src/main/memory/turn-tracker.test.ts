/**
 * 记忆构建的轮次跟踪器（turn-tracker.ts）——事件流判定（正常结束才交）、
 * 根会话 / 信封 / 收尾扫描的门禁、轮号与回答正文的提取。纯模块直测
 * （node --test）：intent-ingest.test 的同款事件夹具。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  completedAssistantText,
  MemoryTurnTracker,
  memoryBuildEligible,
} from "./turn-tracker.ts";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import { LEGACY_CLOSING_SCAN_PROMPT } from "../../shared/wrapup-scan.ts";
import type { SessionRecord } from "../../shared/session.ts";
import type { MemoryChoreModel } from "../../shared/memory.ts";
import type { MemoryTurnPayload } from "./host-core.ts";

const ENVELOPE = `<channel from="parent" kind="task" peer="p1" message="m1">父会话投来的任务</channel>`;
assert.notEqual(parseChannelPrompt(ENVELOPE), null); // 夹具自证

test("memoryBuildEligible：根会话的用户原话才算，子会话 / 信封 / 收尾扫描不算", () => {
  assert.equal(memoryBuildEligible(null, "帮我改一下 bug"), true);
  assert.equal(memoryBuildEligible({}, "帮我改一下 bug"), true);
  assert.equal(memoryBuildEligible({ parentId: "p1" }, "子会话的话"), false);
  assert.equal(memoryBuildEligible({}, ENVELOPE), false);
  assert.equal(memoryBuildEligible({}, LEGACY_CLOSING_SCAN_PROMPT), false);
  assert.equal(memoryBuildEligible({}, "   "), false);
});

const TRANSCRIPT: SessionRecord[] = [
  { role: "user", id: "u1", content: [{ type: "text", text: "第一句" }], timestamp: 111 },
  {
    role: "assistant",
    id: "a1",
    status: "complete",
    stopReason: "stop",
    model: { provider: "p", id: "m" },
    content: [{ type: "text", text: "回答的前半段" }, { type: "text", text: "回答的后半段" }],
    timestamp: 222,
  },
];

test("completedAssistantText：取最后一条 complete 的 assistant 的全部文字块", () => {
  assert.equal(completedAssistantText(TRANSCRIPT), "回答的前半段回答的后半段");
  // 尾巴上只有被打断的回答 → 不算正常结束
  const aborted: SessionRecord[] = [
    ...TRANSCRIPT,
    { role: "user", id: "u2", content: [{ type: "text", text: "第二句" }], timestamp: 333 },
    {
      role: "assistant",
      id: "a2",
      status: "aborted",
      stopReason: "aborted",
      model: { provider: "p", id: "m" },
      content: [{ type: "text", text: "半截回答" }],
      timestamp: 444,
    },
  ];
  assert.equal(completedAssistantText(aborted), "回答的前半段回答的后半段");
});

function makeHarness(overrides: {
  transcript?: SessionRecord[] | null;
  on?: boolean;
  meta?: { workspaceId: string | null; cwd: string } | null;
  /** null = 没配家务活模型；缺席 = 装一份默认的 */
  chore?: MemoryChoreModel | null;
} = {}) {
  const settled: MemoryTurnPayload[] = [];
  const tracker = new MemoryTurnTracker({
    load: async () => {
      if (overrides.transcript === null) return null;
      return { transcript: overrides.transcript ?? TRANSCRIPT };
    },
    readMeta: async () =>
      overrides.meta === undefined ? { workspaceId: "ws-1", cwd: "/c" } : overrides.meta,
    isMemoryOn: async () => overrides.on ?? true,
    readChore: async () =>
      overrides.chore === undefined
        ? { provider: { id: "p", api: "openai", baseUrl: "https://x", apiKey: "k", models: [] }, modelId: "m" }
        : overrides.chore ?? undefined,
    settle: (payload) => settled.push(payload),
  });
  return { tracker, settled };
}

function userEcho(at: number): AgentEvent {
  return {
    type: "progress",
    sessionId: "s1",
    progress: { type: "item_started", item: { role: "user", id: "u1", content: [], timestamp: at } },
  } as unknown as AgentEvent;
}

function assistantDone(): AgentEvent {
  return {
    type: "progress",
    sessionId: "s1",
    progress: { type: "item_finished", item: { role: "assistant", id: "a1", status: "complete", content: [] } },
  } as unknown as AgentEvent;
}

function phase(value: "turn" | "idle"): AgentEvent {
  return { type: "phase", sessionId: "s1", phase: value };
}

test("正常结束的一轮：settle 交给服务，轮号按转录 user 记录数，at 取回显时间戳", async () => {
  const { tracker, settled } = makeHarness();
  tracker.begin("s1", "帮我改一下 bug");
  tracker.onEvent(userEcho(111));
  tracker.onEvent(assistantDone());
  tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.turn, 1);
  assert.equal(settled[0]?.at, 111);
  assert.equal(settled[0]?.userText, "帮我改一下 bug");
  assert.equal(settled[0]?.assistantText.includes("后半段"), true);
  assert.equal(settled[0]?.scopeId, "ws-1");
  assert.notEqual(settled[0]?.chore, undefined);
});

test("没回答完（无 complete）或没回显的轮不交；新一轮开始重置", async () => {
  const { tracker, settled } = makeHarness();
  tracker.begin("s1", "第一句");
  tracker.onEvent(userEcho(111));
  tracker.onEvent(phase("idle")); // 没有回答完成
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled.length, 0);

  tracker.begin("s1", "第二句");
  tracker.onEvent(assistantDone()); // 回显丢了（不该发生，但别炸）
  tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled.length, 0);
});

test("开关在 settle 时关了 / meta 读不到 / 没配家务活模型：都不交或照交（chore 缺席）", async () => {
  const off = makeHarness({ on: false });
  off.tracker.begin("s1", "x");
  off.tracker.onEvent(userEcho(1));
  off.tracker.onEvent(assistantDone());
  off.tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(off.settled.length, 0); // 开关关了：不构建

  const noMeta = makeHarness({ meta: null });
  noMeta.tracker.begin("s1", "x");
  noMeta.tracker.onEvent(userEcho(1));
  noMeta.tracker.onEvent(assistantDone());
  noMeta.tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(noMeta.settled.length, 0); // 作用域读不到：宁可不记

  const noChore = makeHarness({ chore: null });
  noChore.tracker.begin("s1", "x");
  noChore.tracker.onEvent(userEcho(1));
  noChore.tracker.onEvent(assistantDone());
  noChore.tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(noChore.settled.length, 1); // 照交，服务侧记日志后跳过
  assert.equal(noChore.settled[0]?.chore, undefined);
});

test("forget：会话删了，挂着的轮直接丢", async () => {
  const { tracker, settled } = makeHarness();
  tracker.begin("s1", "x");
  tracker.onEvent(userEcho(1));
  tracker.onEvent(assistantDone());
  tracker.forget("s1");
  tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled.length, 0);
});
