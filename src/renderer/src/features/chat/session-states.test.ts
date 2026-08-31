import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent } from "@shared/agent-ipc";
import type { CompactedRecord, SessionRecord } from "@shared/session";
import {
  EMPTY_ENTRY,
  applyAgentEvent,
  markAllIdle,
  mergeCompactions,
  parseCompactCommand,
  removeApproval,
  seedFromDisk,
  setEntryPhase,
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

test("EMPTY_ENTRY 是稳定兜底：phase idle、无审批", () => {
  assert.equal(EMPTY_ENTRY.phase, "idle");
  assert.deepEqual(EMPTY_ENTRY.approvals, []);
  assert.deepEqual(EMPTY_ENTRY.compactions, []);
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
