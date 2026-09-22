import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { channelWhoLabel, visibleChannels } from "./channel-column.ts";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载（同 channel-column.ts 本身的纪律）
import type { ChannelMessage, ChannelSummary } from "../../../../shared/channel.ts";

function summary(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    parentId: "p1",
    childId: "c1",
    childTitle: "子任务",
    status: "running",
    messageCount: 1,
    lastAt: 1,
    hasExchange: false,
    ...overrides,
  };
}

describe("visibleChannels", () => {
  it("hasExchange 为 true 的通道显示；只有 task（hasExchange false）且不在跑的不显示", () => {
    const summaries = new Map([
      ["c1", summary({ childId: "c1", hasExchange: true })],
      ["c2", summary({ childId: "c2", hasExchange: false })],
    ]);
    const result = visibleChannels(summaries, () => false);
    deepStrictEqual(result.map((s) => s.childId), ["c1"]);
  });

  it("只派出没说话、但子还在跑的通道也显示——liveRunning 是第二个放行条件", () => {
    const summaries = new Map([["c1", summary({ childId: "c1", hasExchange: false })]]);
    strictEqual(visibleChannels(summaries, () => true).length, 1);
    strictEqual(visibleChannels(summaries, () => false).length, 0);
  });

  it("按 lastAt 倒序——最近有动静的排最上面", () => {
    const summaries = new Map([
      ["old", summary({ childId: "old", hasExchange: true, lastAt: 1 })],
      ["new", summary({ childId: "new", hasExchange: true, lastAt: 9 })],
      ["mid", summary({ childId: "mid", hasExchange: true, lastAt: 5 })],
    ]);
    deepStrictEqual(
      visibleChannels(summaries, () => false).map((s) => s.childId),
      ["new", "mid", "old"],
    );
  });

  it("liveRunning 按各自的 childId 分别判定，不是全通道一刀切", () => {
    const summaries = new Map([
      ["running", summary({ childId: "running", hasExchange: false })],
      ["idle", summary({ childId: "idle", hasExchange: false })],
    ]);
    const result = visibleChannels(summaries, (childId) => childId === "running");
    deepStrictEqual(result.map((s) => s.childId), ["running"]);
  });
});

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "m1",
    from: "parent",
    author: "model",
    kind: "task",
    text: "去干活",
    delivery: "followUp",
    createdAt: 1,
    ...overrides,
  };
}

describe("channelWhoLabel", () => {
  it("task / progress 文案原样、语气中性", () => {
    deepStrictEqual(channelWhoLabel(message({ kind: "task" })), { text: "task", tone: "neutral", you: false });
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "progress" })),
      { text: "progress", tone: "neutral", you: false },
    );
  });

  it("question 暖黄语气", () => {
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "question" })),
      { text: "question", tone: "question", you: false },
    );
  });

  it("reply · steer 强调色；reply · turn end 中性——只有 steer 是需要用户特别留意的那一档", () => {
    deepStrictEqual(
      channelWhoLabel(message({ kind: "reply", delivery: "steer" })),
      { text: "reply · steer", tone: "reply", you: false },
    );
    deepStrictEqual(
      channelWhoLabel(message({ kind: "reply", delivery: "followUp" })),
      { text: "reply · turn end", tone: "neutral", you: false },
    );
  });

  it("done 绿、failed 红", () => {
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "done" })),
      { text: "done", tone: "done", you: false },
    );
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "failed" })),
      { text: "failed", tone: "failed", you: false },
    );
  });

  it("author === user 时 you 为 true——调用方据此追加「· you」（primary 色单独渲染）", () => {
    strictEqual(channelWhoLabel(message({ kind: "reply", author: "user" })).you, true);
    strictEqual(channelWhoLabel(message({ kind: "task", author: "model" })).you, false);
  });
});
