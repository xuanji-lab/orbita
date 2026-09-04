/**
 * 大折叠（groupTurns / turnStats）的测试：分组时机、正文与界碑留在外面、
 * 轮耗时跨度、统计聚合（含现场计时求和的冻结语义）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  flattenRenderUnits,
  groupToolUnits,
  groupTurns,
  indexToolResults,
  thinkingDurationText,
  turnStats,
  type TurnGroupUnit,
  type TurnViewEntry,
} from "./tool-results.ts";

function userItem(id: string, timestamp: number): TranscriptItem {
  return { id, role: "user", content: [{ type: "text", text: "hi" }], timestamp } as TranscriptItem;
}

function assistantItem(id: string, timestamp: number, blocks: unknown[]): TranscriptItem {
  return { id, role: "assistant", content: blocks, timestamp } as TranscriptItem;
}

function toolItem(
  overrides: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">,
): TranscriptItem {
  return {
    id: `item-${overrides.toolCallId}`,
    role: "tool",
    toolName: "read",
    input: {},
    content: [],
    timestamp: 0,
    status: "complete",
    isError: false,
    ...overrides,
  } as TranscriptItem;
}

const compacted = {
  role: "compacted",
  id: "c1",
  summary: "摘要",
  tokensBefore: 1000,
  timestamp: 5,
} as const;

function turnView(records: readonly TranscriptItem[], turnActive: boolean): TurnViewEntry[] {
  return groupTurns(groupToolUnits(flattenRenderUnits(records)), turnActive, indexToolResults(records));
}

function foldUnits(view: readonly TurnViewEntry[]): TurnGroupUnit[] {
  return view.filter((entry): entry is TurnGroupUnit => entry.kind === "turnGroup");
}

describe("groupTurns", () => {
  test("落定轮：思考与工具收进一条，位置在第一个成员处，正文留在外面原位", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "先看看" },
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2500 }),
      assistantItem("a2", 9000, [{ type: "text", text: "看完了" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "text"],
    );
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    // 成员是且只是思考与工具调用，原时间序
    assert.deepEqual(
      fold.members.map((member) => member.kind),
      ["thinking", "toolCall"],
    );
    // key 挂在首成员上（跨渲染稳定），轮耗时 = 段内 timestamp 极差（含正文完成时刻）
    assert.equal(fold.key, "turn:a1:0");
    assert.equal(fold.durationMs, 8000);
  });

  test("活跃轮原样铺开，已落定的前段照收——折叠只发生在落定的轮次上", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "第一轮" }]),
      userItem("u2", 3000),
      assistantItem("a2", 4000, [{ type: "thinking", thinking: "第二轮还在跑" }]),
    ];
    assert.deepEqual(
      turnView(records, true).map((entry) => entry.kind),
      ["user", "turnGroup", "user", "thinking"],
    );
    assert.deepEqual(
      turnView(records, false).map((entry) => entry.kind),
      ["user", "turnGroup", "user", "turnGroup"],
    );
  });

  test("纯正文段没有可收的成员——原样放行，不包折叠壳", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "直接回答" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "text"],
    );
  });

  test("轮内穿插的正文留在外面：折叠在原地替换成员，不重排正文", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "先说明思路" }]),
      assistantItem("a2", 3000, [{ type: "toolCall", toolCallId: "r1", toolName: "read", input: {} }]),
      toolItem({ toolCallId: "r1", timestamp: 3500 }),
      assistantItem("a3", 4000, [{ type: "text", text: "最终结论" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "text", "turnGroup", "text"],
    );
  });

  test("界碑与用户气泡是轮边界，永远在外面；界碑劈开前后的轮", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "被压缩前" }]),
      compacted as unknown as TranscriptItem,
      userItem("u2", 3000),
      assistantItem("a2", 4000, [{ type: "thinking", thinking: "被压缩后" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "compacted", "user", "turnGroup"],
    );
  });

  test("折叠位置跟着第一个成员走：正文①在折叠之前，正文②在折叠之后", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "正文①" }]),
      assistantItem("a2", 3000, [{ type: "thinking", thinking: "想想" }]),
      assistantItem("a3", 4000, [{ type: "text", text: "正文②（最终）" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => (entry.kind === "turnGroup" ? "turnGroup" : entry.kind)),
      ["user", "text", "turnGroup", "text"],
    );
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    assert.deepEqual(fold.members.map((member) => member.kind), ["thinking"]);
  });

  test("key 稳定：同一段重复分组 key 不变——展开状态靠它保住", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "想想" }]),
    ];
    const first = foldUnits(turnView(records, false))[0];
    const second = foldUnits(turnView(records, false))[0];
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.key, second.key);
  });
});

describe("turnStats", () => {
  test("工具计数跨组与单行聚合；失败与进行中分档；byTool 保持首次出现序", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: {} },
        { type: "toolCall", toolCallId: "r2", toolName: "read", input: {} },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2100 }),
      toolItem({ toolCallId: "r2", timestamp: 2200 }),
      assistantItem("a2", 3000, [
        { type: "thinking", thinking: "再跑个命令" },
        { type: "toolCall", toolCallId: "b1", toolName: "bash", input: {} },
        { type: "toolCall", toolCallId: "b2", toolName: "bash", input: {} },
      ]),
      toolItem({ toolCallId: "b1", toolName: "bash", status: "error", isError: true, timestamp: 3100 }),
      toolItem({ toolCallId: "b2", toolName: "bash", status: "running", isError: false, timestamp: 3200 }),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    const stats = turnStats(fold, indexToolResults(records), 5000);
    assert.equal(stats.calls, 4);
    assert.equal(stats.failed, 1);
    assert.equal(stats.running, 1);
    assert.deepEqual(stats.byTool, [
      { toolName: "read", count: 2 },
      { toolName: "bash", count: 2 },
    ]);
    assert.equal(stats.durationMs, 3200 - 1000);
  });

  test("思考总时长 = 现场计时求和，且顺手把没冻结的表冻结在 now", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "第一段" },
        { type: "thinking", thinking: "第二段" },
      ]),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    // 真实交接序列：第一块流式起表，第二块接管时第一块冻结（交接渲染），
    // 第二块起表——落定后 turnStats 把还没冻的第二块冻在 now
    thinkingDurationText("a1:0", true, 1000);
    thinkingDurationText("a1:0", false, 2000);
    thinkingDurationText("a1:1", true, 2000);
    const stats = turnStats(fold, indexToolResults([]), 5000);
    assert.equal(stats.thinkingMs, 4000);
    // 冻结之后成员行展开也能读到同一份落定时长
    assert.equal(thinkingDurationText("a1:1", false, 9999), "3s");
  });

  test("任一思考块没见过现场（旧会话）→ 整个 thinkingMs 为 null，不显示部分和", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "见过" }]),
      assistantItem("a2", 3000, [{ type: "thinking", thinking: "没见过" }]),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    thinkingDurationText("a1:0", true, 1500);
    const stats = turnStats(fold, indexToolResults([]), 5000);
    assert.equal(stats.thinkingMs, null);
  });

  test("没有思考的轮 thinkingMs 为 0（不是 null）——有数字就诚实显示", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: {} },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2100 }),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    assert.equal(turnStats(fold, indexToolResults(records)).thinkingMs, 0);
  });
});
