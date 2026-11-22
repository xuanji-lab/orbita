import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { TranscriptRecord } from "@shared/session";
import { deriveOnce, splitAtLastUser, stablePrefix } from "./transcript-split.ts";
import { deriveHistorySegment, type HistoryCache } from "./history-segment.ts";
import { flattenRenderUnits, groupToolUnits, groupTurnsByTurn, indexToolResults } from "./tool-results.ts";

function user(id: string, timestamp: number): TranscriptRecord {
  return { id, role: "user", content: [{ type: "text", text: id }], timestamp } as TranscriptItem;
}

function assistant(id: string, text: string, timestamp: number, streaming = false): TranscriptRecord {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    status: streaming ? "streaming" : "complete",
    stopReason: streaming ? undefined : "stop",
  } as unknown as TranscriptItem;
}

function tool(toolCallId: string, timestamp: number): TranscriptRecord {
  return {
    id: `tool-${toolCallId}`,
    role: "tool",
    toolName: "read",
    toolCallId,
    input: {},
    content: [{ type: "text", text: "ok" }],
    timestamp,
    status: "complete",
    isError: false,
  } as ToolTranscriptItem;
}

const SKILLS: readonly { slug: string; name: string }[] = [];

/** 历史段四条记录的对象只建一次：跨帧必须复用同一批引用（真实 hook 侧按 entry 稳定化） */
const BASE: readonly TranscriptRecord[] = [
  user("u1", 1),
  assistant("a1", "第一答", 2),
  tool("r1", 3),
  user("u2", 4),
];

/** 一段完整对话：BASE（u1 / a1 / r1 / u2）+ 流式 a2 —— 历史段是 BASE，尾段只有 a2 */
function frame(tailText: string): TranscriptRecord[] {
  return [...BASE, assistant("a2", tailText, 5, true)];
}

describe("splitAtLastUser", () => {
  test("在最后一条 user 之后切开：历史含那条 user，尾段是它之后的全部", () => {
    const split = splitAtLastUser(frame("he"));
    assert.equal(split.boundary, 4);
    assert.deepEqual(split.history.map((record) => record.id), ["u1", "a1", "tool-r1", "u2"]);
    assert.deepEqual(split.tail.map((record) => record.id), ["a2"]);
  });

  test("没有 user 记录：历史为空、整段都是尾段", () => {
    const split = splitAtLastUser([assistant("a1", "x", 1)]);
    assert.equal(split.boundary, 0);
    assert.equal(split.history.length, 0);
    assert.equal(split.tail.length, 1);
  });

  test("最后一条就是 user：尾段为空", () => {
    const records = [user("u1", 1), assistant("a1", "x", 2), user("u2", 3)];
    const split = splitAtLastUser(records);
    assert.equal(split.boundary, 3);
    assert.equal(split.tail.length, 0);
    assert.equal(split.history.length, 3);
  });

  test("压缩界碑 / 通道标记不是 user 记录，不参与切分", () => {
    const mark = { role: "channel-mark", id: "k1", timestamp: 9 } as unknown as TranscriptRecord;
    const split = splitAtLastUser([user("u1", 1), assistant("a1", "x", 2), mark]);
    assert.equal(split.boundary, 1);
    assert.deepEqual(split.history.map((record) => record.id), ["u1"]);
    assert.deepEqual(split.tail.map((record) => record.id), ["a1", "k1"]);
  });
});

describe("stablePrefix", () => {
  test("逐元素引用相同就复用上一次的前缀数组（不是新 slice）", () => {
    const first = frame("he");
    const previous = stablePrefix(null, first, 4);
    const next = [...first];
    next[4] = assistant("a2", "hello", 5, true);
    assert.equal(stablePrefix(previous, next, 4), previous);
  });

  test("中间元素被替换（回退 / 撤销 / 界碑改写）即失效，返回新数组", () => {
    const first = frame("he");
    const previous = stablePrefix(null, first, 4);
    const next = [...first];
    next[1] = assistant("a1", "改过的回答", 2);
    const prefix = stablePrefix(previous, next, 4);
    assert.notEqual(prefix, previous);
    assert.equal(prefix[1], next[1]);
  });

  test("长度不同也失效（前插一页 / 新的 user 记录）", () => {
    const first = frame("he");
    const previous = stablePrefix(null, first, 4);
    assert.notEqual(stablePrefix(previous, first, 3), previous);
    assert.equal(stablePrefix(previous, first, 3).length, 3);
  });

  test("比记录还长的长度按记录截断", () => {
    const records = [user("u1", 1), assistant("a1", "x", 2)];
    assert.equal(stablePrefix(null, records, 9).length, 2);
  });
});

describe("deriveOnce", () => {
  test("输入引用相同复用输出，不同则重算", () => {
    const a = [1, 2];
    const first = deriveOnce(null, a, (input) => input.length);
    assert.equal(first.output, 2);
    assert.equal(deriveOnce(first, a, () => 99), first);
    const second = deriveOnce(first, [3], (input) => input.length);
    assert.notEqual(second, first);
    assert.equal(second.output, 1);
  });
});

describe("deriveHistorySegment：流式期间历史段对象身份不变", () => {
  const inputsOf = (records: TranscriptRecord[]): Parameters<typeof deriveHistorySegment>[1] => ({
    records,
    boundary: splitAtLastUser(records).boundary,
    skills: SKILLS,
    processView: "turn",
  });

  test("尾段逐帧变化（流式吐字 + 工具结果进尾段）时，历史段全部产物引用不变", () => {
    const firstFrame = frame("h");
    const cache1 = deriveHistorySegment(null, inputsOf(firstFrame));

    const secondFrame = frame("he");
    // 尾段还多了一条工具结果帧（同一个 toolCallId 的新帧不影响历史）
    secondFrame.push(tool("r2", 6));
    const cache2 = deriveHistorySegment(cache1, inputsOf(secondFrame));

    assert.equal(cache2, cache1);
    assert.equal(cache2.segment, cache1.segment);
    assert.equal(cache2.segment.records, cache1.segment.records);
    assert.equal(cache2.segment.toolResults, cache1.segment.toolResults);
    assert.equal(cache2.segment.entries, cache1.segment.entries);
    assert.equal(cache2.segment.turnView, cache1.segment.turnView);
    assert.equal(cache2.segment.plan, cache1.segment.plan);
    assert.equal(cache2.segment.branchRows, cache1.segment.branchRows);
    assert.equal(cache2.segment.carryoverCards, cache1.segment.carryoverCards);
    assert.equal(cache2.segment.interruptedCalls, cache1.segment.interruptedCalls);
  });

  test("历史段里的记录被改写（撤销 / 回退重读）时整段重算", () => {
    const firstFrame = frame("h");
    const cache1 = deriveHistorySegment(null, inputsOf(firstFrame));
    const changed = frame("h");
    changed[1] = assistant("a1", "第一答（改）", 2);
    const cache2 = deriveHistorySegment(cache1, inputsOf(changed));
    assert.notEqual(cache2.segment, cache1.segment);
    assert.notEqual(cache2.segment.turnView, cache1.segment.turnView);
  });

  test("最后一条 user 变化（新一问答）时边界移动，历史段重算", () => {
    const firstFrame = frame("h");
    const cache1 = deriveHistorySegment(null, inputsOf(firstFrame));
    const next = frame("h");
    next.push(user("u3", 7));
    next.push(assistant("a3", "第三答", 8, true));
    const cache2 = deriveHistorySegment(cache1, inputsOf(next));
    assert.notEqual(cache2, cache1);
    // BASE(4) + a2 + u3 = 6 条历史；u3 之后才是新的尾段
    assert.equal(cache2.boundary, 6);
    assert.equal(cache2.segment.records.length, 6);
  });

  test("与整段一次算出的视图逐项相同（切分不改渲染口径）", () => {
    const records = frame("he");
    const boundary = splitAtLastUser(records).boundary;
    const history = deriveHistorySegment(null, inputsOf(records)).segment;

    const full = indexToolResults(records);
    const fullView = groupTurnsByTurn(groupToolUnits(flattenRenderUnits(records), SKILLS), false, full);
    const historyView = history.turnView;
    assert.equal(
      historyView.length + groupTurnsByTurn(
        groupToolUnits(flattenRenderUnits(records.slice(boundary)), SKILLS),
        false,
        full,
      ).length,
      fullView.length,
    );
    assert.deepEqual(fullView.slice(0, historyView.length), historyView);
  });

  test("历史段的分支锚点落在历史段自己的下标上", () => {
    const records = frame("he");
    // 两条落定的 assistant：a1 有正文 + 已落定的工具调用 → 可分支；尾段 a2 还在流式 → 不确认
    const history = deriveHistorySegment(null, inputsOf(records)).segment;
    const anchors = [...history.branchRows.values()];
    assert.deepEqual(anchors, ["a1"]);
    for (const index of history.branchRows.keys()) {
      assert.ok(index >= 0 && index < history.turnView.length);
    }
  });

  test("skills / 过程显示模式变了要重算（产物确实依赖它们）", () => {
    const records = frame("he");
    const cache1 = deriveHistorySegment(null, inputsOf(records));
    const cache2 = deriveHistorySegment(cache1, {
      ...inputsOf(records),
      processView: "steps",
    });
    assert.notEqual(cache2, cache1);
    assert.notEqual(cache2.segment.turnView, cache1.segment.turnView);
  });

  test("历史为空（还没有 user 记录）时返回空段，不抛错", () => {
    const records = [assistant("a1", "x", 1)];
    const cache: HistoryCache = deriveHistorySegment(null, inputsOf(records));
    assert.equal(cache.boundary, 0);
    assert.equal(cache.segment.records.length, 0);
    assert.deepEqual(cache.segment.turnView, []);
  });
});
