import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent, RetryStatus } from "@shared/agent-ipc";
import type { CompactedRecord, SessionRecord } from "@shared/session";
import {
  EMPTY_ENTRY,
  addPendingSend,
  applyAgentEvent,
  compactionBoundaryText,
  consumePendingSends,
  consumePendingTexts,
  editPendingSend,
  markAllIdle,
  mergeCompactions,
  mergeQueueView,
  parseCompactCommand,
  removeApproval,
  removePendingSend,
  removeSessionEntry,
  replaceQueueOrderKey,
  seedFromDisk,
  setEntryPhase,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";

const assistantDone = (id: string, text: string) => ({
  type: "item_finished" as const,
  item: {
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    model: { provider: "zai", id: "glm-5.3" },
    timestamp: 0,
    status: "complete" as const,
    stopReason: "stop" as const,
  },
});

const progress = (sessionId: string, item: ReturnType<typeof assistantDone>): AgentEvent => ({
  type: "progress",
  sessionId,
  progress: item,
});

const permission = (sessionId: string, requestId: string): AgentEvent => ({
  type: "permission",
  sessionId,
  requestId,
  toolName: "bash",
  input: { command: "ls src" },
});

/** 槽里 transcript 的可读形态：assistant 文本按序 */
function texts(states: SessionStates, sessionId: string): string[] {
  const entry = states.get(sessionId);
  if (entry === undefined) return [];
  return selectTranscript(entry.transcript)
    .filter((item): item is TranscriptItem & { role: "assistant" } => item.role === "assistant")
    .flatMap((item) =>
      item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    );
}

describe("applyAgentEvent —— 每会话一槽", () => {
  test("A/B 事件交错，各槽独立增长、互不含对方内容", () => {
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    states = applyAgentEvent(states, progress("B", assistantDone("b1", "乙一")));
    states = applyAgentEvent(states, progress("A", assistantDone("a2", "甲二")));

    assert.deepEqual(texts(states, "A"), ["甲一", "甲二"]);
    assert.deepEqual(texts(states, "B"), ["乙一"]);
  });

  test("事件照进自己的槽，与「当前看谁」无关——这就是后台累积", () => {
    // 模块没有「当前会话」的概念：老实现按 sessionRef 丢事件，这里没得丢。
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    // 期间来了 B 的 phase / 审批 / 失败，都不影响 A 的槽
    states = applyAgentEvent(states, { type: "phase", sessionId: "B", phase: "turn" });
    states = applyAgentEvent(states, permission("B", "B:tc1"));
    states = applyAgentEvent(states, progress("A", assistantDone("a2", "甲二")));

    assert.deepEqual(texts(states, "A"), ["甲一", "甲二"]);
    assert.equal(states.get("A")?.approvals.length, 0);
    assert.equal(states.get("B")?.approvals.length, 1);
  });

  test("未知会话的事件就地建槽", () => {
    const states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    assert.deepEqual(texts(states, "A"), ["甲一"]);
  });

  test("phase 按槽独立：A turn 与 B idle 并存", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, { type: "phase", sessionId: "B", phase: "idle" });
    assert.equal(states.get("A")?.phase, "turn");
    assert.equal(states.get("B")?.phase, "idle");
  });

  test("审批进对应槽；按 requestId 跨槽摘除；未匹配原样返回", () => {
    let states = applyAgentEvent(new Map(), permission("A", "A:tc1"));
    states = applyAgentEvent(states, permission("B", "B:tc2"));

    const afterRemove = removeApproval(states, "B:tc2");
    assert.deepEqual(afterRemove.get("A")?.approvals, states.get("A")?.approvals);
    assert.deepEqual(afterRemove.get("B")?.approvals, []);
    assert.equal(removeApproval(afterRemove, "nope"), afterRemove);
  });

  test("单条 failed 只归位那条，不存在的槽不凭空造", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, { type: "phase", sessionId: "B", phase: "turn" });
    states = applyAgentEvent(states, { type: "failed", sessionId: "A", message: "boom" });

    assert.equal(states.get("A")?.phase, "idle");
    assert.equal(states.get("B")?.phase, "turn");
    assert.equal(states.has("C"), false);
    const untouched = applyAgentEvent(states, {
      type: "failed",
      sessionId: "C",
      message: "boom",
    });
    assert.equal(untouched, states);
  });

  test("failed(null) = runtime 没了：全部归位；全 idle 时返回原引用", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, { type: "phase", sessionId: "B", phase: "turn" });
    states = applyAgentEvent(states, { type: "failed", sessionId: null, message: "exited" });
    assert.equal(states.get("A")?.phase, "idle");
    assert.equal(states.get("B")?.phase, "idle");
    assert.equal(markAllIdle(states), states);
  });

  test("ready / created 等与槽无关的事件原样穿过", () => {
    const states = new Map();
    assert.equal(
      applyAgentEvent(states, { type: "created", sessionId: "A", piSessionFile: null }),
      states,
    );
  });

  test("removeSessionEntry：删槽只删那一条，删不存在的原样返回", () => {
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    states = applyAgentEvent(states, progress("B", assistantDone("b1", "乙一")));

    const afterRemove = removeSessionEntry(states, "A");
    assert.equal(afterRemove.has("A"), false);
    assert.deepEqual(texts(afterRemove, "B"), ["乙一"]);
    assert.equal(removeSessionEntry(afterRemove, "A"), afterRemove);
  });
});

describe("seedFromDisk / setEntryPhase", () => {
  test("整槽覆盖：拿到磁盘真相，旧审批清掉，phase 归 idle", () => {
    let states = applyAgentEvent(new Map(), permission("A", "A:tc1"));
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "turn" });

    const diskItem: TranscriptItem = {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "重做外壳" }],
      timestamp: 1000,
    };
    states = seedFromDisk(states, "A", [diskItem]);

    assert.equal(states.get("A")?.phase, "idle");
    assert.deepEqual(states.get("A")?.approvals, []);
    const items = selectTranscript(states.get("A")!.transcript);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.role, "user");
  });

  test("setEntryPhase 对不存在的槽也生效（send 的乐观 turn 先于事件到达）", () => {
    const states = setEntryPhase(new Map(), "A", "turn");
    assert.equal(states.get("A")?.phase, "turn");
  });
});

test("EMPTY_ENTRY 是稳定兜底：phase idle、无审批、无重试", () => {
  assert.equal(EMPTY_ENTRY.phase, "idle");
  assert.deepEqual(EMPTY_ENTRY.approvals, []);
  assert.deepEqual(EMPTY_ENTRY.compactions, []);
  assert.equal(EMPTY_ENTRY.retry, null);
  assert.deepEqual(selectTranscript(EMPTY_ENTRY.transcript), []);
});

// ── 刀 0-3：压缩界碑 ──

const compacted = (id: string, timestamp: number): CompactedRecord => ({
  role: "compacted",
  id,
  summary: `## 摘要 ${id}`,
  tokensBefore: 85000,
  timestamp,
});
const userItem = (id: string, timestamp: number): TranscriptItem => ({
  id,
  role: "user",
  content: [{ type: "text", text: id }],
  timestamp,
});
const roles = (records: readonly SessionRecord[]) => records.map((r) => r.role);

describe("压缩界碑的进出槽", () => {
  test("compaction 事件进自己的槽，不碰 transcript 归约器", () => {
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    states = applyAgentEvent(states, { type: "compaction", sessionId: "A", record: compacted("c1", 500) });

    assert.deepEqual(states.get("A")?.compactions, [compacted("c1", 500)]);
    assert.deepEqual(texts(states, "A"), ["甲一"]);
  });

  test("seedFromDisk 分流：界碑进 compactions，往来进归约器", () => {
    const disk = [userItem("u1", 1000), compacted("c1", 2000), userItem("u2", 3000)];
    const states = seedFromDisk(new Map(), "A", disk);

    assert.deepEqual(states.get("A")?.compactions, [compacted("c1", 2000)]);
    assert.deepEqual(
      selectTranscript(states.get("A")!.transcript).map((item) => item.id),
      ["u1", "u2"],
    );
  });
});

describe("mergeCompactions —— 界碑就地插回，历史一条不少", () => {
  test("没有界碑时原样全显", () => {
    const items = [userItem("u1", 1), userItem("u2", 2)];
    assert.deepEqual(mergeCompactions([], items), items);
  });

  test("界碑按发生位置插回，此前的往来保持可见——被收起的是摘要，不是历史", () => {
    const records = mergeCompactions([compacted("c1", 2000)], [
      userItem("u1", 1000),
      userItem("u2", 3000),
      userItem("u3", 4000),
    ]);
    assert.deepEqual(roles(records), ["user", "compacted", "user", "user"]);
    assert.deepEqual(
      records.map((r) => r.id),
      ["u1", "c1", "u2", "u3"],
    );
  });

  test("多次压缩各自就位，不吞掉任何一段", () => {
    const records = mergeCompactions([compacted("c1", 2000), compacted("c2", 6000)], [
      userItem("u1", 1000),
      userItem("u2", 3000),
      userItem("u3", 7000),
    ]);
    assert.deepEqual(roles(records), ["user", "compacted", "user", "compacted", "user"]);
    assert.deepEqual(records.map((r) => r.id), ["u1", "c1", "u2", "c2", "u3"]);
  });

  test("同毫秒时界碑在前——先立碑，后发生的消息排在碑后", () => {
    const records = mergeCompactions([compacted("c1", 3000)], [userItem("u2", 3000)]);
    assert.deepEqual(records.map((r) => r.id), ["c1", "u2"]);
  });
});

describe("parseCompactCommand —— 手动压缩指令在本地拦下，不落进模型手里", () => {
  it("/compact 直接压缩，不带要求", () => {
    assert.deepEqual(parseCompactCommand("/compact"), {});
    assert.deepEqual(parseCompactCommand("  /compact  "), {});
  });

  it("/compact <要求> 把要求带回去，前后空白修掉", () => {
    assert.deepEqual(parseCompactCommand("/compact 保留技术术语"), { instructions: "保留技术术语" });
    assert.deepEqual(parseCompactCommand("  /compact   保留术语  "), { instructions: "保留术语" });
  });

  it("/compact 后只有空白等同裸指令，不给空字符串要求", () => {
    assert.deepEqual(parseCompactCommand("/compact   "), {});
  });

  it("别的输入一律不拦——普通消息、别的斜杠、前缀撞车都不算", () => {
    assert.equal(parseCompactCommand("帮我压缩一下上下文"), null);
    assert.equal(parseCompactCommand("/compactx"), null);
    assert.equal(parseCompactCommand("请 /compact"), null);
    assert.equal(parseCompactCommand(""), null);
  });
});

// ── 刀 A-1：用量快照 ──

const stats = (over: Partial<SessionStats> = {}): SessionStats => ({
  sessionFile: undefined,
  sessionId: "A",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 18200, output: 4100, cacheRead: 120000, cacheWrite: 5100, total: 147400 },
  cost: 0.062,
  ...over,
});

describe("stats 快照的进出槽", () => {
  test("stats 事件进自己的槽，后到覆盖先到（每轮落定更新一次）", () => {
    let states = applyAgentEvent(new Map(), { type: "stats", sessionId: "A", stats: stats() });
    const first = states.get("A")?.stats;
    assert.equal(first?.cost, 0.062);

    states = applyAgentEvent(
      states,
      { type: "stats", sessionId: "A", stats: stats({ cost: 0.121 }) },
    );
    assert.equal(states.get("A")?.stats?.cost, 0.121);
  });

  test("未知会话的 stats 事件就地建槽——建会话后的首次推送可能先于 renderer 认识它", () => {
    const states = applyAgentEvent(new Map(), { type: "stats", sessionId: "X", stats: stats() });
    assert.equal(states.get("X")?.stats?.tokens.input, 18200);
  });

  test("seedFromDisk 清掉 stats：盘上没有用量，等唤醒后的第一次推送", () => {
    let states = applyAgentEvent(new Map(), { type: "stats", sessionId: "A", stats: stats() });
    assert.notEqual(states.get("A")?.stats, null);
    states = seedFromDisk(states, "A", [userItem("u1", 1000)]);
    assert.equal(states.get("A")?.stats, null);
  });
});

describe("phase 三态 —— 压缩有自己的进行态", () => {
  test("compaction 透传，不再压扁成 turn", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "compaction" });
    assert.equal(states.get("A")?.phase, "compaction");
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "idle" });
    assert.equal(states.get("A")?.phase, "idle");
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "turn" });
    assert.equal(states.get("A")?.phase, "turn");
  });

  test("runtime 没了：压缩中的槽也一并归位", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "compaction" });
    states = markAllIdle(states);
    assert.equal(states.get("A")?.phase, "idle");
  });
});

// ── 刀 A-3：自动重试 ──

const retryStatus = (over: Partial<RetryStatus> = {}): RetryStatus => ({
  attempt: 2,
  maxAttempts: 3,
  delayMs: 4000,
  startedAt: 1000,
  errorMessage: "fetch failed",
  ...over,
});

describe("重试槽 —— phase 事件是清除信号", () => {
  test("retry 事件设槽；未知会话就地建槽", () => {
    const states = applyAgentEvent(new Map(), {
      type: "retry",
      sessionId: "A",
      status: retryStatus(),
    });
    assert.deepEqual(states.get("A")?.retry, retryStatus());
  });

  test("任何 phase 事件清空重试槽——重试尝试开跑的 agent_start 就是天然清除信号", () => {
    for (const phase of ["turn", "idle", "compaction"] as const) {
      let states = applyAgentEvent(new Map(), {
        type: "retry",
        sessionId: "A",
        status: retryStatus(),
      });
      states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase });
      assert.equal(states.get("A")?.retry, null, `phase=${phase} 应清空重试槽`);
    }
  });

  test("status: null 显式清除（auto_retry_end 的翻译）", () => {
    let states = applyAgentEvent(new Map(), {
      type: "retry",
      sessionId: "A",
      status: retryStatus(),
    });
    states = applyAgentEvent(states, { type: "retry", sessionId: "A", status: null });
    assert.equal(states.get("A")?.retry, null);
  });

  test("failed / markAllIdle / seedFromDisk / setEntryPhase 都不留僵尸倒数", () => {
    let states = applyAgentEvent(new Map(), {
      type: "retry",
      sessionId: "A",
      status: retryStatus(),
    });
    states = applyAgentEvent(states, { type: "failed", sessionId: "A", message: "重试 3 次后仍失败" });
    assert.equal(states.get("A")?.retry, null);

    states = applyAgentEvent(states, { type: "retry", sessionId: "A", status: retryStatus() });
    states = markAllIdle(states);
    assert.equal(states.get("A")?.retry, null);

    states = applyAgentEvent(states, { type: "retry", sessionId: "A", status: retryStatus() });
    states = seedFromDisk(states, "A", [userItem("u1", 1000)]);
    assert.equal(states.get("A")?.retry, null);

    states = applyAgentEvent(states, { type: "retry", sessionId: "A", status: retryStatus() });
    states = setEntryPhase(states, "A", "turn");
    assert.equal(states.get("A")?.retry, null);
  });

  test("压缩中摘要也在重试：phase 与重试槽独立共存", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "compaction" });
    states = applyAgentEvent(
      states,
      { type: "retry", sessionId: "A", status: retryStatus({ attempt: 1, maxAttempts: 2, delayMs: 2000 }) },
    );
    assert.equal(states.get("A")?.phase, "compaction");
    assert.equal(states.get("A")?.retry?.attempt, 1);
  });
});

describe("compactionBoundaryText —— 界碑折叠行文案", () => {
  const base: CompactedRecord = {
    role: "compacted",
    id: "c1",
    summary: "## Goal",
    tokensBefore: 128000,
    timestamp: 3,
  };

  it("有估算的 tokensAfter：N → M，压缩效果摆出来", () => {
    assert.equal(
      compactionBoundaryText({ ...base, tokensAfter: 8200 }),
      "已压缩 · 128,000 → 8,200 tokens",
    );
  });

  it("旧记录没有 tokensAfter：只说压之前多大", () => {
    assert.equal(compactionBoundaryText(base), "已压缩 · 此前上下文约 128,000 tokens");
  });
});

describe("排队槽 —— pi 队列快照全量覆盖，本地待办按 kind 分流", () => {
  const queueEvent = (steering: string[], followUp: string[]): AgentEvent => ({
    type: "queue",
    sessionId: "A",
    steering,
    followUp,
  });

  test("queue 事件全量覆盖：投递 / 清队后的空快照直接抹掉旧值", () => {
    let states = applyAgentEvent(new Map(), queueEvent(["插队中"], ["等下一轮"]));
    assert.deepEqual(states.get("A")?.queue, { steering: ["插队中"], followUp: ["等下一轮"] });
    states = applyAgentEvent(states, queueEvent([], []));
    assert.deepEqual(states.get("A")?.queue, { steering: [], followUp: [] });
  });

  test("phase 事件不清本地待办（消费由 hook 执行后显式做），也不动 pi 队列", () => {
    let states = addPendingSend(new Map(), "A", { kind: "text", text: "压缩完发我" });
    states = applyAgentEvent(states, queueEvent([], ["pi 队列那条"]));
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "idle" });
    assert.deepEqual(states.get("A")?.pendingSends, [{ kind: "text", text: "压缩完发我" }]);
    assert.deepEqual(states.get("A")?.queue.followUp, ["pi 队列那条"]);
  });

  test("addPendingSend / removePendingSend / editPendingSend：增删改按序，compact 项不可编辑", () => {
    let states = addPendingSend(new Map(), "A", { kind: "text", text: "第一条" });
    states = addPendingSend(states, "A", { kind: "compact", instructions: "保留代码细节" });
    states = editPendingSend(states, "A", 0, "改过的第一条");
    assert.deepEqual(states.get("A")?.pendingSends, [
      { kind: "text", text: "改过的第一条" },
      { kind: "compact", instructions: "保留代码细节" },
    ]);
    // compact 项编辑落空（原样返回）
    const before = states;
    states = editPendingSend(states, "A", 1, "改不了");
    assert.equal(states, before);
    states = removePendingSend(states, "A", 0);
    assert.deepEqual(states.get("A")?.pendingSends, [{ kind: "compact", instructions: "保留代码细节" }]);
    // 删不存在的下标不动原槽
    const before2 = states;
    states = removePendingSend(states, "A", 9);
    assert.equal(states, before2);
  });

  test("consumePendingSends：消费前缀（hook 执行了多少吃多少）", () => {
    let states = addPendingSend(new Map(), "A", { kind: "text", text: "a" });
    states = addPendingSend(states, "A", { kind: "compact" });
    states = addPendingSend(states, "A", { kind: "text", text: "b" });
    states = consumePendingSends(states, "A", 2);
    assert.deepEqual(states.get("A")?.pendingSends, [{ kind: "text", text: "b" }]);
  });

  test("consumePendingTexts：只吃 text，compact 留给 idle 拍", () => {
    let states = addPendingSend(new Map(), "A", { kind: "text", text: "a" });
    states = addPendingSend(states, "A", { kind: "compact" });
    states = addPendingSend(states, "A", { kind: "text", text: "b" });
    states = consumePendingTexts(states, "A");
    assert.deepEqual(states.get("A")?.pendingSends, [{ kind: "compact" }]);
  });

  test("runtime 没了：队列与本地待办一并清空（物理消失，不留尸体）", () => {
    let states = applyAgentEvent(new Map(), queueEvent(["s"], ["f"]));
    states = addPendingSend(states, "A", { kind: "text", text: "缓冲" });
    states = applyAgentEvent(states, { type: "failed", sessionId: null, message: "runtime exited" });
    assert.deepEqual(states.get("A")?.queue, { steering: [], followUp: [] });
    assert.deepEqual(states.get("A")?.pendingSends, []);
  });

  test("seedFromDisk 清空排队槽：ephemeral 状态不跨会话存留", () => {
    let states = applyAgentEvent(new Map(), queueEvent(["s"], ["f"]));
    states = addPendingSend(states, "A", { kind: "compact" });
    states = seedFromDisk(states, "A", []);
    assert.deepEqual(states.get("A")?.queue, { steering: [], followUp: [] });
    assert.deepEqual(states.get("A")?.pendingSends, []);
  });
});

describe("mergeQueueView —— 卡片按输入顺序交错，不看队列归属", () => {
  const queueEvent = (steering: string[], followUp: string[]): AgentEvent => ({
    type: "queue",
    sessionId: "A",
    steering,
    followUp,
  });
  const labelsOf = (entry: SessionEntry | undefined) =>
    mergeQueueView(entry ?? EMPTY_ENTRY).map((item) =>
      item.source === "pi" ? item.text : item.item.kind,
    );

  test("先排 pi 消息、再排 /compact、又排一条 pi 消息：显示保持输入序", () => {
    // 用户在 turn 期间依次输入：消息A → /compact → 消息B
    let states = applyAgentEvent(new Map(), queueEvent([], ["A"]));
    states = addPendingSend(states, "A", { kind: "compact" });
    states = applyAgentEvent(states, queueEvent([], ["A", "B"]));
    assert.deepEqual(labelsOf(states.get("A")), ["A", "compact", "B"]);
  });

  test("投递一条后其余保位：A 投掉，compact 仍在 B 前面", () => {
    let states = applyAgentEvent(new Map(), queueEvent([], ["A"]));
    states = addPendingSend(states, "A", { kind: "compact" });
    states = applyAgentEvent(states, queueEvent([], ["A", "B"]));
    // A 被投递，队列只剩 B；compact 的账本位置在 B 之前
    states = applyAgentEvent(states, queueEvent([], ["B"]));
    assert.deepEqual(labelsOf(states.get("A")), ["compact", "B"]);
  });

  test("pi 项编辑换键保位（replaceQueueOrderKey + queue_update 新文本）", () => {
    let states = applyAgentEvent(new Map(), queueEvent([], ["A"]));
    states = replaceQueueOrderKey(states, "A", "pi\0A", "pi\0改过的");
    states = applyAgentEvent(states, queueEvent([], ["改过的"]));
    const view = mergeQueueView(states.get("A") ?? EMPTY_ENTRY);
    assert.equal(view.length, 1);
    const first = view[0];
    assert.ok(first?.source === "pi" && first.text === "改过的");
  });

  test("本地 text 消费后 compact 保位；账本漏网的项补尾不丢", () => {
    let states = applyAgentEvent(new Map(), queueEvent([], ["A"]));
    states = addPendingSend(states, "A", { kind: "compact" });
    // 压缩期间的本地 text：排在 compact 之后（后输入）
    states = addPendingSend(states, "A", { kind: "text", text: "压缩完发我" });
    states = consumePendingTexts(states, "A");
    assert.deepEqual(labelsOf(states.get("A")), ["A", "compact"]);
    // pi 队列整批投递：只剩 compact
    states = applyAgentEvent(states, queueEvent([], []));
    assert.deepEqual(labelsOf(states.get("A")), ["compact"]);
  });
});
