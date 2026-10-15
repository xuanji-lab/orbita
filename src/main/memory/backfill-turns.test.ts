/**
 * 补蒸轮收集的回归网：轮切分对齐 read_task 口径、正常结束判定（aborted / error /
 * 无 assistant / 空回答不蒸）、范围按用户消息时间截、账本跳过、通道标记轮、
 * token 粗估与 MemoryBackfillEstimate 组装。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { SessionRecord } from "../../shared/session.ts";
import {
  backfillEstimateOf,
  collectSessionTurns,
  estimateInputTokens,
  rangeStart,
} from "./backfill-turns.ts";

const userItem = (id: string, text: string, timestamp = 2000): TranscriptItem => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistantItem = (
  id: string,
  text: string,
  timestamp = 3000,
  stop: "stop" | "length" | "toolUse" | "aborted" | "error" = "stop",
): TranscriptItem => {
  const base = {
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    model: { provider: "zai", id: "glm-5.3" },
    timestamp,
  };
  if (stop === "aborted") return { ...base, status: "aborted" as const, stopReason: "aborted" as const };
  if (stop === "error") return { ...base, status: "error" as const, stopReason: "error" as const };
  return { ...base, status: "complete" as const, stopReason: stop };
};

const toolItem = (id: string): SessionRecord => ({
  id,
  role: "tool",
  toolCallId: `call-${id}`,
  toolName: "bash",
  input: { command: "ls" },
  content: [{ type: "text", text: "file-a\nfile-b" }],
  timestamp: 2500,
  status: "complete",
  isError: false,
});

const toolCallAssistant = (id: string): SessionRecord => ({
  id,
  role: "assistant",
  content: [{ type: "toolCall", toolCallId: `call-${id}`, toolName: "bash", input: {} }],
  model: { provider: "zai", id: "glm-5.3" },
  timestamp: 2500,
  status: "complete",
  stopReason: "toolUse",
});

const channelMark = (id: string, messageId: string, timestamp: number): SessionRecord => ({
  role: "channel-mark",
  id,
  peerId: "child-1",
  messageId,
  from: "child",
  kind: "progress",
  timestamp,
});

const collect = (
  records: readonly SessionRecord[],
  options: {
    distilled?: ReadonlySet<number>;
    since?: number;
    channelTexts?: ReadonlyMap<string, string> | null;
  } = {},
) =>
  collectSessionTurns({
    sessionId: "s1",
    meta: { workspaceId: null, cwd: "/tmp/demo" },
    records,
    channelTexts: options.channelTexts ?? null,
    distilled: options.distilled ?? new Set(),
    since: options.since ?? 0,
  });

describe("collectSessionTurns", () => {
  test("正常轮按 read_task 口径编号收集，带用户文本、回答文本与时刻", () => {
    const records = [
      userItem("u1", "帮我看看 bun 的用法", 1000),
      assistantItem("a1", "bun 是一个 JavaScript 运行时", 1500),
      userItem("u2", "package.json 在哪", 2000),
      toolItem("t1"),
      assistantItem("a2", "在仓库根目录", 2500),
    ];
    const { pending, skippedTurns } = collect(records);
    assert.equal(skippedTurns, 0);
    assert.equal(pending.length, 2);
    assert.equal(pending[0]?.turn, 1);
    assert.equal(pending[0]?.at, 1000);
    assert.equal(pending[0]?.userText, "帮我看看 bun 的用法");
    assert.equal(pending[0]?.assistantText, "bun 是一个 JavaScript 运行时");
    assert.equal(pending[1]?.turn, 2);
    assert.equal(pending[1]?.assistantText, "在仓库根目录");
    assert.equal(pending[1]?.scope.cwd, "/tmp/demo");
    assert.equal(pending[1]?.scope.workspaceId, null);
  });

  test("被打断 / 报错收场的轮不蒸；没有 assistant 的轮不蒸", () => {
    const records = [
      userItem("u1", "第一轮", 1000),
      assistantItem("a1", "说到一半", 1500, "aborted"),
      userItem("u2", "第二轮", 2000),
      assistantItem("a2", "报错了", 2500, "error"),
      userItem("u3", "第三轮：还没回答就被打断", 3000),
    ];
    const { pending } = collect(records);
    assert.equal(pending.length, 0);
  });

  test("stopReason = length / toolUse 的正常轮照蒸；纯工具轮（末条 assistant 无文本）不蒸", () => {
    const records = [
      userItem("u1", "长回答", 1000),
      assistantItem("a1", "被截断的回答", 1500, "length"),
      userItem("u2", "只调工具", 2000),
      toolCallAssistant("a2"),
      toolItem("t1"),
    ];
    const { pending } = collect(records);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.turn, 1);
  });

  test("范围按用户消息时间截：范围内收、范围外丢，同一会话可切一半", () => {
    const records = [
      userItem("u1", "很早的一轮", 1000),
      assistantItem("a1", "旧回答", 1500),
      userItem("u2", "最近的一轮", 10_000),
      assistantItem("a2", "新回答", 10_500),
    ];
    const { pending } = collect(records, { since: 5000 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.turn, 2);
    assert.equal(pending[0]?.at, 10_000);
  });

  test("账本里已有的轮跳过并计 skippedTurns；未蒸的照常收集", () => {
    const records = [
      userItem("u1", "第一轮", 1000),
      assistantItem("a1", "回答一", 1500),
      userItem("u2", "第二轮", 2000),
      assistantItem("a2", "回答二", 2500),
      userItem("u3", "第三轮", 3000),
      assistantItem("a3", "回答三", 3500, "aborted"),
    ];
    const { pending, skippedTurns } = collect(records, { distilled: new Set([1]) });
    // 第 3 轮被打断：不进 pending，也不算 skipped（它本来就不该蒸）
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.turn, 2);
    assert.equal(skippedTurns, 1);
  });

  test("通道标记轮从通道账本取正文；账本里取不到就整轮跳过", () => {
    const records = [
      channelMark("m1", "msg-1", 1000),
      assistantItem("a1", "收到子会话回报后的回应", 1500),
      channelMark("m2", "msg-missing", 2000),
      assistantItem("a2", "另一轮的回答", 2500),
    ];
    const withChannel = collect(records, {
      channelTexts: new Map([["msg-1", "子会话报告：任务完成了"]]),
    });
    // msg-missing 在账本里取不到：那轮跳过（不蒸也不算已蒸）
    assert.equal(withChannel.pending.length, 1);
    assert.equal(withChannel.pending[0]?.turn, 1);
    assert.equal(withChannel.pending[0]?.userText, "子会话报告：任务完成了");
    assert.equal(withChannel.pending[0]?.at, 1000);

    const noChannel = collect(records, { channelTexts: new Map() });
    assert.equal(noChannel.pending.length, 0);
    assert.equal(noChannel.skippedTurns, 0);
  });

  test("多 text 块拼接；chars 是两段文本的字符量", () => {
    const records: SessionRecord[] = [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
        timestamp: 1000,
      },
      assistantItem("a1", "回答", 1500),
    ];
    const { pending } = collect(records);
    assert.equal(pending[0]?.userText, "第一段\n第二段");
    assert.equal(pending[0]?.chars, "第一段\n第二段".length + "回答".length);
  });
});

describe("预估", () => {
  test("rangeStart：all 恒 0，其余按天数往前推", () => {
    const now = 1_700_000_000_000;
    assert.equal(rangeStart("all", now), 0);
    assert.equal(rangeStart("1m", now), now - 30 * 24 * 60 * 60 * 1000);
    assert.equal(rangeStart("3m", now), now - 91 * 24 * 60 * 60 * 1000);
    assert.equal(rangeStart("6m", now), now - 182 * 24 * 60 * 60 * 1000);
  });

  test("estimateInputTokens：正文折算 + 每轮固定开销", () => {
    assert.equal(estimateInputTokens(1600, 0), 1000);
    assert.equal(estimateInputTokens(0, 1), Math.ceil(1200 / 1.6));
  });

  test("backfillEstimateOf 组装契约形状", () => {
    const estimate = backfillEstimateOf({
      range: "3m",
      sessions: 4,
      turns: 10,
      skippedTurns: 2,
      chars: 16_000,
      choreModel: { providerId: "zai", modelId: "glm-5.3-flash" },
    });
    assert.deepEqual(estimate, {
      range: "3m",
      sessions: 4,
      turns: 10,
      skippedTurns: 2,
      estimatedInputTokens: Math.ceil((16_000 + 10 * 1200) / 1.6),
      choreModel: { providerId: "zai", modelId: "glm-5.3-flash" },
    });
  });
});
