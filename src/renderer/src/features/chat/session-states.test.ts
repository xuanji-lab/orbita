import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { FileTurnRecord, RevertRecord } from "@shared/revert";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent, AgentStats, RetryStatus } from "@shared/agent-ipc";
import type { ChannelMessage } from "@shared/channel";
import type { ChannelMarkRecord, CompactedRecord, IntentRecallRecord, SessionRecord } from "@shared/session";
import {
  EMPTY_ENTRY,
  dequeue,
  applyAgentEvent,
  compactionBoundaryStatus,
  enqueue,
  enqueueChannelMessage,
  markAllIdle,
  mergeSideRecords,
  moveQueued,
  parseCompactCommand,
  createSessionStates,
  removeApproval,
  setPendingEcho,
  nextDeliverable,
  removeSessionEntry,
  revertOptimisticTurn,
  seedFromDisk,
  setEntryPhase,
  type QueuedMessage,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";
import { en } from "../../messages-en.ts";

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

  test("thinking 事件进自己会话的槽：clamp 真值与支持集各归各", () => {
    let states = applyAgentEvent(new Map(), {
      type: "thinking",
      sessionId: "A",
      level: "low",
      supported: ["minimal", "low", "medium", "high"],
    });
    states = applyAgentEvent(states, {
      type: "thinking",
      sessionId: "B",
      level: "off",
      supported: ["off"],
    });
    assert.deepEqual(states.get("A")?.thinking, {
      level: "low",
      supported: ["minimal", "low", "medium", "high"],
    });
    assert.deepEqual(states.get("B")?.thinking, { level: "off", supported: ["off"] });
    // 后到的真值整体覆盖先到的（换模型后支持集变了）
    states = applyAgentEvent(states, {
      type: "thinking",
      sessionId: "A",
      level: "medium",
      supported: ["off", "medium", "high"],
    });
    assert.deepEqual(states.get("A")?.thinking, {
      level: "medium",
      supported: ["off", "medium", "high"],
    });
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

  /**
   * 审批不听 abort（pi 是 await beforeToolCall 之后才查 signal），所以停止 / 抢跑时
   * runtime 会把挂起的审批按拒绝结清。卡片必须跟着消失，否则用户会去回答一个
   * runtime 那边已经不存在的请求（点了没任何事发生）。
   */
  test("phase idle 清掉挂起的审批卡，不碰别的会话", () => {
    let states = applyAgentEvent(new Map(), permission("A", "A:tc1"));
    states = applyAgentEvent(states, permission("B", "B:tc2"));

    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "idle" });
    assert.deepEqual(states.get("A")?.approvals, [], "轮结束就不可能还有挂起的审批");
    assert.equal(states.get("B")?.approvals.length, 1, "别的会话的审批不受影响");
  });

  test("phase turn / compaction 不清审批卡——工具还在等回答", () => {
    let states = applyAgentEvent(new Map(), permission("A", "A:tc1"));
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "turn" });
    assert.equal(states.get("A")?.approvals.length, 1);
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "compaction" });
    assert.equal(states.get("A")?.approvals.length, 1);
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

describe("乐观 turn 的失败归位（revertOptimisticTurn）", () => {
  test("每条 phase 事件把 phaseEpoch 加一；乐观置 phase 不动它；种盘不回零", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "idle" });
    assert.equal(states.get("A")?.phaseEpoch, 2);
    states = setEntryPhase(states, "A", "turn");
    assert.equal(states.get("A")?.phaseEpoch, 2);
    states = seedFromDisk(states, "A", []);
    assert.equal(states.get("A")?.phaseEpoch, 2);
  });

  test("提交以来没来过 phase 事件：归位 idle（主进程装配失败这类，不会有事件收尾）", () => {
    const epoch = EMPTY_ENTRY.phaseEpoch;
    const states = setEntryPhase(new Map(), "A", "turn");
    assert.equal(revertOptimisticTurn(states, "A", epoch).get("A")?.phase, "idle");
  });

  test("期间来过 phase 事件（撞 already running：占坑的那一轮已报 turn）：不踩，原样返回", () => {
    // 复现序：队首投递后 runtime 已占坑 → 用户回车被当成直发（乐观 turn，记下 epoch）
    // → 那一轮的 turn 事件到达 → 直发的 IPC 以 already running 失败。
    // 此时归位 idle 会让之后每次回车都直发、失败、把字回填进输入框
    let states = setEntryPhase(new Map(), "A", "turn");
    const epoch = states.get("A")?.phaseEpoch ?? 0;
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "turn" });
    const after = revertOptimisticTurn(states, "A", epoch);
    assert.equal(after, states);
    assert.equal(after.get("A")?.phase, "turn");
  });

  test("槽不存在原样返回，不凭空造槽", () => {
    const states: SessionStates = new Map();
    assert.equal(revertOptimisticTurn(states, "A", 0), states);
  });
});

test("EMPTY_ENTRY 是稳定兜底：phase idle、无审批、无重试", () => {
  assert.equal(EMPTY_ENTRY.phase, "idle");
  assert.deepEqual(EMPTY_ENTRY.approvals, []);
  assert.deepEqual(EMPTY_ENTRY.compactions, []);
  assert.deepEqual(EMPTY_ENTRY.marks, []);
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
const channelMark = (id: string, timestamp: number): ChannelMarkRecord => ({
  role: "channel-mark",
  id,
  peerId: "child-1",
  messageId: "msg-1",
  from: "child",
  kind: "question",
  timestamp,
});
const roles = (records: readonly { role: string }[]) => records.map((r) => r.role);

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

  test("seedFromDisk 分流：通道标记进 marks（不再丢弃），往来仍进归约器", () => {
    const disk = [userItem("u1", 1000), channelMark("k1", 2000), userItem("u2", 3000)];
    const states = seedFromDisk(new Map(), "A", disk);

    assert.deepEqual(states.get("A")?.marks, [channelMark("k1", 2000)]);
    assert.deepEqual(
      selectTranscript(states.get("A")!.transcript).map((item) => item.id),
      ["u1", "u2"],
    );
  });
});

describe("轮尾账的旁路网页产物（webArtifacts）", () => {
  test("fileTurnView 只有 webArtifacts、没有 changes 也进槽（卡片要出）", () => {
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    states = applyAgentEvent(states, {
      type: "fileTurnView",
      sessionId: "A",
      turnId: "t1",
      changes: [],
      webArtifacts: ["/w/out/proto.html"],
    });
    const turns = states.get("A")?.fileTurns ?? [];
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]?.changes, []);
    assert.deepEqual(turns[0]?.webArtifacts, ["/w/out/proto.html"]);
  });

  test("fileTurnView 两样都空不进槽（没有产出的轮不产卡）", () => {
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    states = applyAgentEvent(states, { type: "fileTurnView", sessionId: "A", turnId: "t1", changes: [] });
    assert.equal(states.get("A")?.fileTurns.length, 0);
  });

  test("fileTurnView 只有批量折叠计数也进槽（卡片要出那一行计数）", () => {
    let states = applyAgentEvent(new Map(), progress("A", assistantDone("a1", "甲一")));
    states = applyAgentEvent(states, {
      type: "fileTurnView",
      sessionId: "A",
      turnId: "t1",
      changes: [],
      webArtifactsBatch: 12,
    });
    const turns = states.get("A")?.fileTurns ?? [];
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.webArtifactsBatch, 12);
    assert.equal(turns[0]?.webArtifacts, undefined);
  });

  test("seedFromDisk：新记录带 webArtifacts 还原；旧记录没有字段照常显示", () => {
    const withWeb: FileTurnRecord = {
      role: "file-turn",
      id: "t1",
      timestamp: 1000,
      changes: [],
      webArtifacts: ["/w/out/report.html"],
    };
    const legacy: FileTurnRecord = {
      role: "file-turn",
      id: "t2",
      timestamp: 2000,
      changes: [
        { path: "/w/src/a.ts", before: { kind: "absent" }, after: { kind: "text", blob: "x" }, added: 1, removed: 0 },
      ],
    };
    const states = seedFromDisk(new Map(), "A", [userItem("u1", 500), withWeb, legacy]);
    const turns = states.get("A")?.fileTurns ?? [];
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0]?.webArtifacts, ["/w/out/report.html"]);
    assert.equal("webArtifacts" in (turns[1] ?? {}), false);
  });

  test("seedFromDisk：批量折叠计数随种子还原；旧记录没有字段照常显示", () => {
    const folded: FileTurnRecord = {
      role: "file-turn",
      id: "t1",
      timestamp: 1000,
      changes: [],
      webArtifactsBatch: 12,
    };
    const legacy: FileTurnRecord = {
      role: "file-turn",
      id: "t2",
      timestamp: 2000,
      changes: [
        { path: "/w/src/a.ts", before: { kind: "absent" }, after: { kind: "text", blob: "x" }, added: 1, removed: 0 },
      ],
    };
    const states = seedFromDisk(new Map(), "A", [userItem("u1", 500), folded, legacy]);
    const turns = states.get("A")?.fileTurns ?? [];
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.webArtifactsBatch, 12);
    assert.equal("webArtifactsBatch" in (turns[1] ?? {}), false);
  });
});

describe("mergeSideRecords —— 界碑与通道标记就地插回，历史一条不少", () => {
  test("没有界碑也没有标记时原样全显", () => {
    const items = [userItem("u1", 1), userItem("u2", 2)];
    assert.deepEqual(mergeSideRecords([], [], [], [], [], items), items);
  });

  test("界碑按发生位置插回，此前的往来保持可见——被收起的是摘要，不是历史", () => {
    const records = mergeSideRecords(
      [compacted("c1", 2000)],
      [],
      [],
      [],
      [],
      [userItem("u1", 1000), userItem("u2", 3000), userItem("u3", 4000)],
    );
    assert.deepEqual(roles(records), ["user", "compacted", "user", "user"]);
    assert.deepEqual(
      records.map((r) => r.id),
      ["u1", "c1", "u2", "u3"],
    );
  });

  test("多次压缩各自就位，不吞掉任何一段", () => {
    const records = mergeSideRecords(
      [compacted("c1", 2000), compacted("c2", 6000)],
      [],
      [],
      [],
      [],
      [userItem("u1", 1000), userItem("u2", 3000), userItem("u3", 7000)],
    );
    assert.deepEqual(roles(records), ["user", "compacted", "user", "compacted", "user"]);
    assert.deepEqual(records.map((r) => r.id), ["u1", "c1", "u2", "c2", "u3"]);
  });

  test("同毫秒时界碑在前——先立碑，后发生的消息排在碑后", () => {
    const records = mergeSideRecords([compacted("c1", 3000)], [], [], [], [], [userItem("u2", 3000)]);
    assert.deepEqual(records.map((r) => r.id), ["c1", "u2"]);
  });

  test("通道标记同样按时间就位，与界碑同一条排序规则", () => {
    const records = mergeSideRecords(
      [],
      [channelMark("k1", 2000)],
      [],
      [],
      [],
      [userItem("u1", 1000), userItem("u2", 3000)],
    );
    assert.deepEqual(roles(records), ["user", "channel-mark", "user"]);
    assert.deepEqual(records.map((r) => r.id), ["u1", "k1", "u2"]);
  });

  test("界碑与通道标记混排，各自按时间就位、互不吞没", () => {
    const records = mergeSideRecords(
      [compacted("c1", 4000)],
      [channelMark("k1", 2000)],
      [],
      [],
      [],
      [userItem("u1", 1000), userItem("u2", 3000), userItem("u3", 5000)],
    );
    assert.deepEqual(
      records.map((r) => r.id),
      ["u1", "k1", "u2", "c1", "u3"],
    );
  });

  test("轮尾账与回退界碑按时间就位：账跟在轮末、界碑落在回退点", () => {
    const fileTurn: FileTurnRecord = {
      role: "file-turn",
      id: "t1",
      timestamp: 3500,
      changes: [{ path: "/w/a.ts", before: { kind: "absent" }, after: { kind: "absent" }, added: 1, removed: 0 }],
    };
    const revertRecord: RevertRecord = {
      role: "revert",
      id: "r1",
      targetMessageId: "u2",
      restored: [],
      timestamp: 6000,
    };
    const records = mergeSideRecords(
      [],
      [],
      [fileTurn],
      [revertRecord],
      [],
      [userItem("u1", 1000), userItem("u2", 3000), userItem("u3", 8000)],
    );
    assert.deepEqual(records.map((r) => r.id), ["u1", "u2", "t1", "r1", "u3"]);
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

const stats = (over: Partial<AgentStats> = {}): AgentStats => ({
  tokens: { input: 18200, output: 4100, cacheRead: 120000, cacheWrite: 5100, total: 147400 },
  cost: 0.062,
  contextUsage: null,
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

describe("compactionBoundaryStatus —— 界碑折叠行 status 槽文案", () => {
  const base: CompactedRecord = {
    role: "compacted",
    id: "c1",
    summary: "## Goal",
    tokensBefore: 128000,
    timestamp: 3,
  };

  it("有估算的 tokensAfter：N → M，压缩效果摆出来", () => {
    assert.equal(
      compactionBoundaryStatus({ ...base, tokensAfter: 8200 }, en),
      "128,000 → 8,200 tokens",
    );
  });

  it("旧记录没有 tokensAfter：只说压之前多大（~ 前缀声明是估算前的量级）", () => {
    assert.equal(compactionBoundaryStatus(base, en), "~128,000 tokens");
  });
});

describe("排队队列 —— 唯一真源，操作一律按 id", () => {
  const msg = (id: string, text: string): QueuedMessage => ({ id, kind: "text", text });
  const seed = (...items: QueuedMessage[]): SessionStates => {
    let states: SessionStates = new Map();
    for (const item of items) states = enqueue(states, "A", item);
    return states;
  };
  const ids = (states: SessionStates): string[] =>
    (states.get("A")?.queued ?? []).map((item) => item.id);

  test("入队落到队尾，顺序即显示顺序", () => {
    const states = seed(msg("1", "甲"), msg("2", "乙"), msg("3", "丙"));
    assert.deepEqual(ids(states), ["1", "2", "3"]);
  });

  test("按 id 出队；找不到就原样返回同一个槽", () => {
    let states = seed(msg("1", "甲"), msg("2", "乙"));
    states = dequeue(states, "A", "1");
    assert.deepEqual(ids(states), ["2"]);
    const before = states;
    assert.equal(dequeue(states, "A", "不存在"), before);
  });

  test("挪位按 id——下标会随投递前移，那正是旧实现每次连续操作都落空的原因", () => {
    let states = seed(msg("1", "甲"), msg("2", "乙"), msg("3", "丙"));
    // 把丙放到甲前面
    states = moveQueued(states, "A", "3", "1", "before");
    assert.deepEqual(ids(states), ["3", "1", "2"]);
    // 再把丙放到乙后面
    states = moveQueued(states, "A", "3", "2", "after");
    assert.deepEqual(ids(states), ["1", "2", "3"]);
  });

  test("挪位：向下拖时的差一格——源抽走后目标位置前移", () => {
    let states = seed(msg("1", "甲"), msg("2", "乙"), msg("3", "丙"));
    states = moveQueued(states, "A", "1", "2", "after");
    assert.deepEqual(ids(states), ["2", "1", "3"]);
  });

  test("挪到原位 / 挪到自己 / 目标不存在：都不动槽", () => {
    const states = seed(msg("1", "甲"), msg("2", "乙"));
    assert.equal(moveQueued(states, "A", "1", "1", "before"), states);
    assert.equal(moveQueued(states, "A", "1", "2", "before"), states);
    assert.equal(moveQueued(states, "A", "2", "1", "after"), states);
    assert.equal(moveQueued(states, "A", "1", "没这条", "before"), states);
  });

  test("撤回一条不影响其他条的身份——id 稳定，不像下标会整体前移", () => {
    let states = seed(msg("1", "甲"), msg("2", "乙"), msg("3", "丙"));
    states = dequeue(states, "A", "2");
    assert.deepEqual(ids(states), ["1", "3"]);
    // 丙仍然是丙：拿它的 id 去挪，照样命中
    states = moveQueued(states, "A", "3", "1", "before");
    assert.deepEqual(ids(states), ["3", "1"]);
  });
});

describe("子会话 PR4a：channel 队列条目", () => {
  const channelMsg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
    id,
    from: "child",
    author: "model",
    kind: "question",
    text: "焦点描边用哪个 token？",
    delivery: "followUp",
    createdAt: 1000,
    ...over,
  });
  const item = (id: string, childId = "child-1"): Extract<QueuedMessage, { kind: "channel" }> => ({
    id,
    kind: "channel",
    childId,
    message: channelMsg(id),
  });

  test("enqueue 落到队尾，与 text 同一套队列——channel 条目按 message.id 认身份", () => {
    let states = enqueue(new Map(), "parent-1", item("m1"));
    states = enqueue(states, "parent-1", item("m2"));
    assert.deepEqual(
      states.get("parent-1")?.queued.map((entry) => entry.id),
      ["m1", "m2"],
    );
  });

  test("enqueueChannelMessage 按 id 去重：同一条 message.id 重复到达不二次入队", () => {
    let states = enqueueChannelMessage(new Map(), "parent-1", item("m1"));
    const after = enqueueChannelMessage(states, "parent-1", item("m1"));
    assert.equal(after, states); // 同一引用：判定「没有变化」的调用方据此短路
    assert.deepEqual(after.get("parent-1")?.queued.map((entry) => entry.id), ["m1"]);

    // 不同 id 正常入队
    states = enqueueChannelMessage(after, "parent-1", item("m2"));
    assert.deepEqual(states.get("parent-1")?.queued.map((entry) => entry.id), ["m1", "m2"]);
  });

  test("nextDeliverable 对 channel 条目的规则同 text：只认 phase idle", () => {
    const idleStates = enqueue(new Map(), "parent-1", item("m1"));
    const idleEntry = idleStates.get("parent-1")!;
    assert.equal(nextDeliverable(idleEntry)?.id, "m1");

    const turnEntry: SessionEntry = { ...idleEntry, phase: "turn" };
    assert.equal(nextDeliverable(turnEntry), null);
  });
});

describe("nextDeliverable —— 投递节奏归我们，一次只放一条", () => {
  const entryWith = (
    phase: SessionEntry["phase"],
    queued: QueuedMessage[],
  ): SessionEntry => ({ ...EMPTY_ENTRY, phase, queued });

  test("空闲且队列非空：放队首", () => {
    const head = nextDeliverable(entryWith("idle", [{ id: "1", kind: "text", text: "甲" }]));
    assert.equal(head?.id, "1");
  });

  test("空队列：null", () => {
    assert.equal(nextDeliverable(entryWith("idle", [])), null);
  });

  test("压缩中：一律不放——pi 压缩时连入队入口都关着", () => {
    assert.equal(
      nextDeliverable(entryWith("compaction", [{ id: "1", kind: "text", text: "甲" }])),
      null,
    );
  });

  test("轮跑着：普通消息也不放——一次只跑一轮，等这轮结束的 phase 事件", () => {
    assert.equal(
      nextDeliverable(entryWith("turn", [{ id: "1", kind: "text", text: "甲" }])),
      null,
    );
  });

  test("compact 项要求完全空闲：非 idle 一律不放", () => {
    assert.equal(nextDeliverable(entryWith("turn", [{ id: "c", kind: "compact" }])), null);
    assert.equal(nextDeliverable(entryWith("idle", [{ id: "c", kind: "compact" }]))?.id, "c");
  });
});

describe("markAllIdle —— runtime 没了，排队的消息没人会发", () => {
  test("队列一并清空，槽里不留尸体", () => {
    let states = enqueue(new Map(), "A", { id: "1", kind: "text", text: "甲" });
    states = markAllIdle(states);
    assert.deepEqual(states.get("A")?.queued, []);
    assert.equal(states.get("A")?.phase, "idle");
  });
});


// ── 回合失败标注（重试耗尽标在对话里，不放输入框上方） ──

describe("turnError —— 回合失败标注的进出槽", () => {
  test("failed(turn) 进槽：phase 归位、标注留档", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, {
      type: "failed",
      sessionId: "A",
      message: "重试 3 次后仍失败：fetch failed",
      turn: true,
    });
    const entry = states.get("A");
    assert.equal(entry?.phase, "idle");
    assert.equal(entry?.turnError, "重试 3 次后仍失败：fetch failed");
  });

  test("failed 不带 turn：槽里不产生标注（操作级失败走全局红字），归位照旧", () => {
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, { type: "failed", sessionId: "A", message: "两本账对不上" });
    assert.equal(states.get("A")?.phase, "idle");
    assert.equal(states.get("A")?.turnError, null);
  });

  test("落定的 idle phase 事件不清标注——failed 之后紧随的 agent_settled 不能抹掉它", () => {
    // 先建槽（真实时序里这轮一直在跑、槽早就在了），再 failed(turn)，再落定
    let states = applyAgentEvent(new Map(), { type: "phase", sessionId: "A", phase: "turn" });
    states = applyAgentEvent(states, {
      type: "failed",
      sessionId: "A",
      message: "重试 3 次后仍失败：fetch failed",
      turn: true,
    });
    states = applyAgentEvent(states, { type: "phase", sessionId: "A", phase: "idle" });
    assert.equal(states.get("A")?.turnError, "重试 3 次后仍失败：fetch failed");
  });

  test("新一轮开跑即清：phase turn / compaction 与乐观置 turn 都算", () => {
    const base = applyAgentEvent(new Map(), {
      type: "failed",
      sessionId: "A",
      message: "重试 3 次后仍失败：fetch failed",
      turn: true,
    });
    assert.equal(
      applyAgentEvent(base, { type: "phase", sessionId: "A", phase: "turn" }).get("A")?.turnError,
      null,
    );
    assert.equal(
      applyAgentEvent(base, { type: "phase", sessionId: "A", phase: "compaction" }).get("A")
        ?.turnError,
      null,
    );
    assert.equal(setEntryPhase(base, "A", "turn").get("A")?.turnError, null);
  });

  test("seedFromDisk 清标注：盘上没有 ephemeral 的失败", () => {
    let states = applyAgentEvent(new Map(), {
      type: "failed",
      sessionId: "A",
      message: "重试 3 次后仍失败：fetch failed",
      turn: true,
    });
    states = seedFromDisk(states, "A", [userItem("u1", 1000)]);
    assert.equal(states.get("A")?.turnError, null);
  });
});

// ── A-1 回归：关掉应用重开，底栏不该是空的（wafo 2026-09-03 实测）──

describe("seedFromDisk 播种用量", () => {
  test("盘上有快照就放回槽——否则重开应用底栏是空的，而账本明明还在", () => {
    const snapshot = stats({ contextUsage: { tokens: 18200, contextWindow: 200_000, percent: 9 } });
    const states = seedFromDisk(new Map(), "A", [], snapshot);
    assert.deepEqual(states.get("A")?.stats, snapshot);
  });

  test("旧会话没有快照：槽里是 null，环只画底环", () => {
    assert.equal(seedFromDisk(new Map(), "A", []).get("A")?.stats, null);
  });

  test("唤醒后 agent 推的真累计覆盖盘上的快照", () => {
    let states = seedFromDisk(new Map(), "A", [], stats({ cost: 0.001 }));
    states = applyAgentEvent(states, {
      type: "stats",
      sessionId: "A",
      stats: stats({ cost: 0.5 }),
    });
    assert.equal(states.get("A")?.stats?.cost, 0.5);
  });
});

describe("意图系统的槽位（实验功能 intent-system）", () => {
  test("intentRecall 流事件归约运行卡；终态记录落桶并收摊运行卡（同 turn 只留最后一张）", () => {
    let states = createSessionStates();
    states = applyAgentEvent(states, {
      type: "intentRecall",
      sessionId: "s1",
      turnId: "t1",
      event: { type: "gate", needIntent: true, why: "需要", forced: false },
    });
    assert.deepEqual(states.get("s1")?.intentRun?.turnId, "t1");
    assert.deepEqual(states.get("s1")?.intentRun?.gate?.needIntent, true);
    const record: IntentRecallRecord = {
      role: "intent-recall",
      id: "c1",
      turnId: "t1",
      status: "done",
      runId: "r1",
      timestamp: 1,
      startedAt: 1,
      finishedAt: 2,
      scene: null,
      qaTotal: null,
      passed: null,
      budgetMs: null,
      peak: false,
      timings: null,
      summary: null,
      selected: [],
      ask: [],
      error: null,
      halted: null,
      skipped: null,
      gateWhy: null,
    };
    states = applyAgentEvent(states, { type: "intentRecallRecord", sessionId: "s1", record });
    assert.deepEqual(states.get("s1")?.intentRun, null);
    assert.deepEqual(states.get("s1")?.intentRecalls.length, 1);
  });

  test("乐观回显：真回显（item_started user）一到即清；phase idle 与失败归位也清", () => {
    let states = setPendingEcho(createSessionStates(), "s1", ["第一句"]);
    assert.deepEqual(states.get("s1")?.pendingEcho?.blocks, ["第一句"]);
    // 同拍置 turn 后真回显到达 → 清
    states = applyAgentEvent(states, {
      type: "progress",
      sessionId: "s1",
      progress: {
        type: "item_started",
        item: { role: "user", id: "u1", content: [{ type: "text", text: "第一句" }], timestamp: 1 },
      },
    });
    assert.deepEqual(states.get("s1")?.pendingEcho, null);
    // 提交失败归位（乐观置 turn 后 setEntryPhase idle）也清——不留鬼影
    states = setPendingEcho(states, "s1", ["第二句"]);
    states = setEntryPhase(states, "s1", "idle");
    assert.deepEqual(states.get("s1")?.pendingEcho, null);
  });

  test("意图卡混排：同毫秒时排在它服务的 user 之后（界碑在前的老规则对它相反）", () => {
    const user = { role: "user" as const, id: "u1", content: [{ type: "text" as const, text: "问" }], timestamp: 100 };
    const recall: IntentRecallRecord = {
      role: "intent-recall",
      id: "c1",
      turnId: "u1",
      status: "done",
      runId: "r1",
      timestamp: 100,
      startedAt: 100,
      finishedAt: 101,
      scene: null,
      qaTotal: null,
      passed: null,
      budgetMs: null,
      peak: false,
      timings: null,
      summary: null,
      selected: [],
      ask: [],
      error: null,
      halted: null,
      skipped: null,
      gateWhy: null,
    };
    // 故意倒序传入（卡在前、气泡在后）：混排必须把卡排到气泡之后
    const merged = mergeSideRecords([], [], [], [], [], [user], [recall]);
    assert.deepEqual(merged.map((record) => record.role), ["user", "intent-recall"]);
  });
});
