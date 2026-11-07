/**
 * 记忆构建的轮次跟踪器（turn-tracker.ts）——事件流判定（正常结束才交）、
 * 根会话 / 信封 / 收尾扫描的门禁、轮号与回答正文的提取、丢弃诊断。纯模块直测
 * （node --test）：intent-ingest.test 的同款事件夹具；末尾两条复现用真
 * SessionStore + recorder。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryTurnTracker, memoryBuildEligible, turnNumberOf } from "./turn-tracker.ts";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import { LEGACY_CLOSING_SCAN_PROMPT } from "../../shared/wrapup-scan.ts";
import type { SessionRecord } from "../../shared/session.ts";
import type { MemoryChoreModel } from "../../shared/memory.ts";
import type { MemoryTurnPayload } from "./host-core.ts";
import { createSessionRecorder } from "../session/recorder.ts";
import { SessionStore } from "../session/store.ts";

const ENVELOPE = `<channel from="parent" kind="task" peer="p1" message="m1">父会话投来的任务</channel>`;
assert.notEqual(parseChannelPrompt(ENVELOPE), null); // 夹具自证

test("memoryBuildEligible：根会话的用户原话才算，子会话 / 信封 / 收尾扫描不算", () => {
  assert.equal(memoryBuildEligible(null, "帮我改一下 bug"), true);
  assert.equal(memoryBuildEligible({}, "帮我改一下 bug"), true);
  assert.equal(memoryBuildEligible({ parentId: "p1" }, "子会话的话"), false);
  // 自动化新开的会话：指令是排期时定好的，不是用户此刻亲口说的
  assert.equal(memoryBuildEligible({ automationId: "au1" }, "[定时任务「x」第 1 次 · 10-31 01:45]\n\n看日志"), false);
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
    content: [{ type: "text", text: "回答" }],
    timestamp: 222,
  },
];

test("turnNumberOf：回显条目在 user 记录里的位置；还没落盘（找不到 id）时是下一条", () => {
  assert.equal(turnNumberOf(TRANSCRIPT, "u1"), 1);
  const two: SessionRecord[] = [
    ...TRANSCRIPT,
    { role: "user", id: "u2", content: [{ type: "text", text: "第二句" }], timestamp: 333 },
  ];
  assert.equal(turnNumberOf(two, "u1"), 1);
  assert.equal(turnNumberOf(two, "u2"), 2);
  assert.equal(turnNumberOf(two, "u3"), 3); // 本轮回显还在写入链上
  assert.equal(turnNumberOf(two, null), 3);
});

function makeHarness(overrides: {
  transcript?: SessionRecord[] | null;
  on?: boolean;
  meta?: { workspaceId: string | null; cwd: string } | null;
  /** null = 没配家务活模型；缺席 = 装一份默认的 */
  chore?: MemoryChoreModel | null;
  settle?: (payload: MemoryTurnPayload) => void | Promise<void>;
} = {}) {
  const settled: MemoryTurnPayload[] = [];
  const logs: string[] = [];
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
    settle: overrides.settle ?? ((payload) => {
      settled.push(payload);
    }),
    log: (message, ...args) => logs.push([message, ...args.map(String)].join(" ")),
  });
  return { tracker, settled, logs };
}

function userEcho(at: number, id = "u1"): AgentEvent {
  return {
    type: "progress",
    sessionId: "s1",
    progress: { type: "item_started", item: { role: "user", id, content: [], timestamp: at } },
  } as unknown as AgentEvent;
}

function assistantDone(
  text = "回答的前半段",
  more = "回答的后半段",
  status: "complete" | "error" | "aborted" = "complete",
  stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
): AgentEvent {
  return {
    type: "progress",
    sessionId: "s1",
    progress: {
      type: "item_finished",
      item: {
        role: "assistant",
        id: "a1",
        status,
        stopReason,
        content: [{ type: "text", text }, { type: "text", text: more }],
      },
    },
  } as unknown as AgentEvent;
}

function toolCallDone(text = ""): AgentEvent {
  return {
    type: "progress",
    sessionId: "s1",
    progress: {
      type: "item_finished",
      item: {
        role: "assistant",
        id: "a-tool",
        status: "complete",
        stopReason: "toolUse",
        content: [
          ...(text === "" ? [] : [{ type: "text", text }]),
          { type: "toolCall", id: "c1", name: "memory_revise", arguments: {} },
        ],
      },
    },
  } as unknown as AgentEvent;
}

function phase(value: "turn" | "idle"): AgentEvent {
  return { type: "phase", sessionId: "s1", phase: value };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("正常结束的一轮：settle 交给服务，轮号按回显在转录里的位置，at 取回显时间戳，正文取事件里的终态帧", async () => {
  const { tracker, settled, logs } = makeHarness();
  tracker.begin("s1", "帮我改一下 bug");
  tracker.onEvent(userEcho(111));
  tracker.onEvent(assistantDone());
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.turn, 1);
  assert.equal(settled[0]?.at, 111);
  assert.equal(settled[0]?.userText, "帮我改一下 bug");
  assert.equal(settled[0]?.assistantText, "回答的前半段回答的后半段");
  assert.equal(settled[0]?.scopeId, "ws-1");
  assert.notEqual(settled[0]?.chore, undefined);
  assert.deepEqual(logs, []); // 正常路径不刷屏
});

test("工具调用轮：调工具前的那一帧不算回答，最终那帧才是；正文只取最终那帧", async () => {
  const { tracker, settled } = makeHarness();
  tracker.begin("s1", "不对，我现在汇报的要求变了");
  tracker.onEvent(phase("turn"));
  tracker.onEvent(userEcho(111));
  tracker.onEvent(toolCallDone("我先改一下记忆。"));
  tracker.onEvent(assistantDone("已改成三条要点。", ""));
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.assistantText, "已改成三条要点。");
});

test("最后一帧不是正常说完的轮不交并留痕：调完工具后出错 / 被打断 / 停在工具调用", async () => {
  for (const [label, last] of [
    ["出错", assistantDone("", "", "error", "error")],
    ["打断", assistantDone("半截", "", "aborted", "aborted")],
    ["停在工具调用", toolCallDone("我先查一下。")],
  ] as const) {
    const { tracker, settled, logs } = makeHarness();
    tracker.begin("s1", "x");
    tracker.onEvent(userEcho(111));
    tracker.onEvent(toolCallDone("我先查一下。"));
    tracker.onEvent(last);
    tracker.onEvent(phase("idle"));
    await tick();
    assert.equal(settled.length, 0, label);
    assert.equal(logs.length, 1, label);
    assert.match(logs[0] ?? "", /会话 s1 第 1 轮不进事件段——最后一个 assistant 终态帧不是正常说完/, label);
    assert.match(logs[0] ?? "", /answered=false/, label);
    assert.match(logs[0] ?? "", /工具往返=/, label);
  }
});

test("没回答完或没回显的轮不交，各留一行带路径与状态的诊断", async () => {
  const { tracker, settled, logs } = makeHarness();
  tracker.begin("s1", "第一句");
  tracker.onEvent(userEcho(111));
  tracker.onEvent(phase("idle")); // 没有回答完成
  await tick();
  assert.equal(settled.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /第 1 轮不进事件段——最后一个 assistant 终态帧不是正常说完.*echoedAt=111 answered=false 工具往返=0 末帧=无/);

  tracker.begin("s1", "第二句");
  tracker.onEvent(assistantDone()); // 回显丢了（不该发生，但别炸）
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[1] ?? "", /不进事件段——落定时还没见到用户回显.*echoedAt=null answered=true/);
});

test("回答正文为空的轮不交并留痕", async () => {
  const { tracker, settled, logs } = makeHarness();
  tracker.begin("s1", "x");
  tracker.onEvent(userEcho(1));
  tracker.onEvent(assistantDone("  ", ""));
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 0);
  assert.match(logs[0] ?? "", /不进事件段——回答正文为空/);
});

test("开关在 settle 时关了 / meta 读不到：不交并留痕；没配家务活模型：照交（chore 缺席）", async () => {
  const off = makeHarness({ on: false });
  off.tracker.begin("s1", "x");
  off.tracker.onEvent(userEcho(1));
  off.tracker.onEvent(assistantDone());
  off.tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(off.settled.length, 0); // 开关关了：不构建
  assert.match(off.logs[0] ?? "", /第 1 轮不进事件段——落定时实验开关已关/);

  const noMeta = makeHarness({ meta: null });
  noMeta.tracker.begin("s1", "x");
  noMeta.tracker.onEvent(userEcho(1));
  noMeta.tracker.onEvent(assistantDone());
  noMeta.tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(noMeta.settled.length, 0); // 作用域读不到：宁可不记
  assert.match(noMeta.logs[0] ?? "", /第 1 轮不进事件段——会话 meta 读不到/);

  const gone = makeHarness({ transcript: null });
  gone.tracker.begin("s1", "x");
  gone.tracker.onEvent(userEcho(1));
  gone.tracker.onEvent(assistantDone());
  gone.tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(gone.settled.length, 0);
  assert.match(gone.logs[0] ?? "", /（轮号未知）不进事件段——转录读不到/);

  const noChore = makeHarness({ chore: null });
  noChore.tracker.begin("s1", "x");
  noChore.tracker.onEvent(userEcho(1));
  noChore.tracker.onEvent(assistantDone());
  noChore.tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(noChore.settled.length, 1); // 照交，服务侧记日志后跳过
  assert.equal(noChore.settled[0]?.chore, undefined);
});

test("交给服务那一步抛错（服务拉起失败等）：接住并留痕，不变成未处理的 rejection", async () => {
  const { tracker, logs } = makeHarness({
    settle: async () => {
      throw new Error("fork 失败");
    },
  });
  tracker.begin("s1", "x");
  tracker.onEvent(userEcho(1));
  tracker.onEvent(assistantDone());
  tracker.onEvent(phase("idle"));
  await tick();
  assert.match(logs[0] ?? "", /会话 s1 的这一轮没交给记忆服务.*fork 失败/);
});

test("立即发送抢跑：挂着的上一轮被新一轮顶掉时留痕", async () => {
  const { tracker, settled, logs } = makeHarness();
  tracker.begin("s1", "第一句");
  tracker.onEvent(userEcho(111));
  tracker.begin("s1", "第二句"); // interrupt：旧轮不发 idle
  await tick();
  assert.match(logs[0] ?? "", /第 1 轮不进事件段——上一轮没落定就被新一轮顶掉/);
  tracker.onEvent(userEcho(222, "u2"));
  tracker.onEvent(assistantDone());
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.userText, "第二句");
});

test("会话没有挂着的轮（子会话 / 信封 / 开关关着时开的轮）：落定时不刷日志", async () => {
  const { tracker, settled, logs } = makeHarness();
  tracker.onEvent(userEcho(1));
  tracker.onEvent(assistantDone());
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 0);
  assert.deepEqual(logs, []);
});

test("forget：会话删了，挂着的轮直接丢", async () => {
  const { tracker, settled } = makeHarness();
  tracker.begin("s1", "x");
  tracker.onEvent(userEcho(1));
  tracker.onEvent(assistantDone());
  tracker.forget("s1");
  tracker.onEvent(phase("idle"));
  await tick();
  assert.equal(settled.length, 0);
});

/* ---------- 复现：带工具调用的一轮被静默丢掉（PR #374 真机 b4669e3f 第 3 轮） ---------- */


const REAL_ID = "b4669e3f-b2ad-4b83-93ca-abef24ee969a";

function realProgress(progress: unknown): AgentEvent {
  return { type: "progress", sessionId: REAL_ID, progress } as unknown as AgentEvent;
}

test("复现：工具调用轮——idle 时最终回答还没落盘，回答正文不能从磁盘读（真 SessionStore + recorder）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-turn-"));
  try {
    const store = new SessionStore(join(dir, "sessions"));
    const record = createSessionRecorder(store);
    await store.ensureSession({
      id: REAL_ID,
      title: "",
      titleSource: "derived",
      stats: null,
      cwd: "/c",
      workspaceId: null,
      piSessionFile: null,
      pinned: false,
      archived: false,
      recentQueries: [],
      providerId: "p",
      modelId: "m",
      mode: "plan",
      thinkingLevel: "medium",
      createdAt: 1,
      updatedAt: 1,
    });
    const settled: MemoryTurnPayload[] = [];
    const tracker = new MemoryTurnTracker({
      load: (id) => store.load(id),
      readMeta: async () => ({ workspaceId: null, cwd: "/c" }),
      isMemoryOn: async () => true, // 真机上 settings.read 有缓存，同样是一个微任务就回来
      readChore: async () => undefined,
      settle: (payload) => {
        settled.push(payload);
      },
    });
    // index.ts 的喂法：同一个事件先喂跟踪器、再喂 recorder
    const feed = (event: AgentEvent): void => {
      tracker.onEvent(event);
      record(event);
    };
    tracker.begin(REAL_ID, "不对，我现在汇报的要求变了：分成三条要点，每条不超过一行。");
    feed({ type: "phase", sessionId: REAL_ID, phase: "turn" });
    feed(realProgress({
      type: "item_started",
      item: { role: "user", id: "u3", content: [{ type: "text", text: "不对，我现在汇报的要求变了" }], timestamp: 300 },
    }));
    // 等用户回显落盘（真机上它在轮首落，离 idle 很远）
    for (let i = 0; i < 100 && ((await store.load(REAL_ID))?.transcript.length ?? 0) < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 第一条 assistant：只有 toolCall、没有文字（status complete / stopReason toolUse）
    feed(realProgress({
      type: "item_finished",
      item: {
        role: "assistant",
        id: "a3-tool",
        status: "complete",
        stopReason: "toolUse",
        model: { provider: "p", id: "m" },
        content: [{ type: "toolCall", id: "call-1", name: "memory_revise", arguments: {} }],
        timestamp: 301,
      },
    }));
    feed(realProgress({
      type: "item_finished",
      item: {
        role: "tool",
        id: "t3",
        toolCallId: "call-1",
        toolName: "memory_revise",
        input: {},
        status: "complete",
        isError: false,
        content: [{ type: "text", text: "Revised." }],
        timestamp: 302,
      },
    }));
    // 工具往返落盘（真机上第二次模型调用要几秒，toolUse 那条与工具结果早已落定）
    for (let i = 0; i < 100 && ((await store.load(REAL_ID))?.transcript.length ?? 0) < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 最终回答与 idle 在同一批到达（utility 进程连发几帧时主进程同一个宏任务里收到）：
    // 此刻磁盘上「最后一条 complete 的 assistant」是那条只有 toolCall 的——文字为空
    feed(realProgress({
      type: "item_finished",
      item: {
        role: "assistant",
        id: "a3-final",
        status: "complete",
        stopReason: "stop",
        model: { provider: "p", id: "m" },
        content: [{ type: "text", text: "我已经把记忆改成三条要点。" }],
        timestamp: 303,
      },
    }));
    feed({ type: "phase", sessionId: REAL_ID, phase: "idle" });
    for (let i = 0; i < 100 && settled.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled.length, 1, "这一轮必须交给记忆服务");
    assert.equal(settled[0]?.turn, 1);
    assert.equal(settled[0]?.assistantText, "我已经把记忆改成三条要点。");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("复现：回答完之后 pi 做阈值自动压缩（compaction_end → phase turn），这一轮照样要交", async () => {
  const { tracker, settled } = makeHarness();
  tracker.begin("s1", "帮我改一下 bug");
  tracker.onEvent(phase("turn"));
  tracker.onEvent(userEcho(111));
  tracker.onEvent(assistantDone());
  // runtime：compaction_start → phase compaction；compaction_end（非压缩轮）→ phase turn
  tracker.onEvent({ type: "phase", sessionId: "s1", phase: "compaction" });
  tracker.onEvent(phase("turn"));
  tracker.onEvent(phase("idle"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled.length, 1);
});
