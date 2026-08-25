import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyTranscriptProgress,
  applyTranscriptSnapshot,
  createTranscriptState,
  selectTranscript,
  type TranscriptState,
} from "@earendil-works/pi-coding-agent/client";
import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TranscriptAdapter, type AdaptableEvent } from "./transcript-adapter.ts";

/**
 * 判分方式：把适配器发出的帧喂进 **pi 自己的归约器**，重建出的 transcript 必须
 * 与上游 AssistantMessage 一致。这比断言我们自己的输出形状强得多——
 * 它验的是「pi 认不认我们说的话」。
 */

let counter = 0;
const deps = { newId: () => `id-${++counter}`, now: () => 1_700_000_000_000 };

function emptySnapshot(): SessionSnapshot {
  return {
    id: "session-1",
    cwd: "/tmp/work",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    phase: "idle",
    model: { provider: "zai", id: "glm-5.3" },
    thinkingLevel: "off",
    attached: true,
    locked: false,
    revision: 0,
    transcript: [],
    queuedSteer: [],
    queuedSteerCount: 0,
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "zai",
    model: "glm-5.3",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    stopReason,
  } as AssistantMessage;
}

/** 把一串事件跑完，返回 pi 归约器重建出的 transcript */
function replay(events: AdaptableEvent[], prompt?: string) {
  const adapter = new TranscriptAdapter(deps);
  let state: TranscriptState = createTranscriptState(emptySnapshot());
  const frames = [
    ...(prompt === undefined ? [] : adapter.userPrompt(prompt)),
    ...events.flatMap((e) => adapter.apply(e)),
  ];
  for (const frame of frames) state = applyTranscriptProgress(state, frame);
  return { transcript: selectTranscript(state), frames };
}

beforeEach(() => {
  counter = 0;
});

describe("TranscriptAdapter", () => {
  test("纯文本流式：逐字增量重建后与上游整条消息逐字一致", () => {
    const chunks = ["He", "llo", ", world"];
    const events: AdaptableEvent[] = [
      { type: "message_start", message: assistant([{ type: "text", text: "" }]) },
      ...chunks.map((delta, i) => ({
        type: "message_update" as const,
        message: assistant([{ type: "text", text: chunks.slice(0, i + 1).join("") }]),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      })),
      { type: "message_end", message: assistant([{ type: "text", text: "Hello, world" }]) },
    ];

    const { transcript, frames } = replay(events);
    assert.equal(transcript.length, 1);
    const item = transcript[0];
    assert.equal(item?.role, "assistant");
    assert.deepEqual(item?.content, [{ type: "text", text: "Hello, world" }]);
    assert.equal(item?.status, "complete");

    // 增量帧是 O(1) 的：三个 delta 帧各自只带自己那一小段，不带整条消息
    const deltas = frames.filter((f) => f.type === "assistant_delta");
    assert.equal(deltas.length, 3);
    assert.deepEqual(
      deltas.map((f) => (f.type === "assistant_delta" ? f.delta : "")),
      chunks,
    );
  });

  test("一条消息的 id 全程不变——增量帧要靠它对上号", () => {
    const { frames } = replay([
      { type: "message_start", message: assistant([{ type: "text", text: "" }]) },
      {
        type: "message_update",
        message: assistant([{ type: "text", text: "a" }]),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
      },
      { type: "message_end", message: assistant([{ type: "text", text: "a" }]) },
    ]);
    const ids = new Set(
      frames.map((f) => (f.type === "assistant_delta" ? f.messageId : f.item.id)),
    );
    assert.equal(ids.size, 1, `一条消息应只有一个 id，实际 ${[...ids].join(",")}`);
  });

  test("思考 + 回答：两个内容块各自按 contentIndex 增量，不串台", () => {
    const events: AdaptableEvent[] = [
      {
        type: "message_start",
        message: assistant([
          { type: "thinking", thinking: "" },
          { type: "text", text: "" },
        ]),
      },
      {
        type: "message_update",
        message: assistant([
          { type: "thinking", thinking: "让我想想" },
          { type: "text", text: "" },
        ]),
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "让我想想" },
      },
      {
        type: "message_update",
        message: assistant([
          { type: "thinking", thinking: "让我想想" },
          { type: "text", text: "答案" },
        ]),
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "答案" },
      },
      {
        type: "message_end",
        message: assistant([
          { type: "thinking", thinking: "让我想想" },
          { type: "text", text: "答案" },
        ]),
      },
    ];
    const { transcript } = replay(events);
    assert.deepEqual(transcript[0]?.content, [
      { type: "thinking", thinking: "让我想想" },
      { type: "text", text: "答案" },
    ]);
  });

  test("工具调用块：pi-ai 的 {id,name,arguments} 翻成 protocol 的 {toolCallId,toolName,input}", () => {
    const call = {
      type: "toolCall" as const,
      id: "call-1",
      name: "read",
      arguments: { path: "a.ts" },
    };
    const { transcript } = replay([
      { type: "message_start", message: assistant([call]) },
      { type: "message_end", message: assistant([call]) },
    ]);
    assert.deepEqual(transcript[0]?.content, [
      { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
    ]);
  });

  test("用户消息先落地，顺序在 assistant 之前", () => {
    const { transcript } = replay(
      [
        { type: "message_start", message: assistant([{ type: "text", text: "hi" }]) },
        { type: "message_end", message: assistant([{ type: "text", text: "hi" }]) },
      ],
      "你好",
    );
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0]?.role, "user");
    assert.deepEqual(transcript[0]?.content, [{ type: "text", text: "你好" }]);
    assert.equal(transcript[1]?.role, "assistant");
  });

  test("非增量的流式帧（text_start / text_end）走整条重发，不丢结构变化", () => {
    const { frames } = replay([
      { type: "message_start", message: assistant([{ type: "text", text: "" }]) },
      {
        type: "message_update",
        message: assistant([{ type: "text", text: "" }]),
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      },
      { type: "message_end", message: assistant([{ type: "text", text: "" }]) },
    ]);
    assert.ok(frames.some((f) => f.type === "item_updated"), "应有一帧整条重发");
    assert.ok(!frames.some((f) => f.type === "assistant_delta"), "不该造出假的增量帧");
  });

  test("没有 message_start 就来的 update / end 被丢弃，不产生孤儿帧", () => {
    const adapter = new TranscriptAdapter(deps);
    assert.deepEqual(
      adapter.apply({
        type: "message_update",
        message: assistant([{ type: "text", text: "x" }]),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      }),
      [],
    );
    assert.deepEqual(
      adapter.apply({ type: "message_end", message: assistant([{ type: "text", text: "x" }]) }),
      [],
    );
  });

  test("连续两轮：第二轮的 id 与第一轮不同，且两条都在 transcript 里", () => {
    const one = assistant([{ type: "text", text: "1" }]);
    const two = assistant([{ type: "text", text: "2" }]);
    const { transcript } = replay([
      { type: "message_start", message: one },
      { type: "message_end", message: one },
      { type: "message_start", message: two },
      { type: "message_end", message: two },
    ]);
    assert.equal(transcript.length, 2);
    assert.notEqual(transcript[0]?.id, transcript[1]?.id);
  });

  test("snapshot 到来时归约器整体替换——重连对账走这条路", () => {
    const state = createTranscriptState(emptySnapshot());
    const next = applyTranscriptSnapshot(state, {
      ...emptySnapshot(),
      revision: 1,
      transcript: [
        { id: "x", role: "user", content: [{ type: "text", text: "旧会话" }], timestamp: 1 },
      ],
    });
    assert.equal(selectTranscript(next).length, 1);
  });
});

/**
 * 终态不只有「说完了」一种。pi 的 agent-loop 在 abort 时是**先无条件发 message_end、
 * 之后才判 `stopReason === "aborted"`**，所以被打断的半截回答同样走终态帧。
 * 以前这里一律写 complete，等于**在记录里把「你按了停止」抹成了「它自己说完了」**；
 * 会话落盘之后这条谎会留在磁盘上。
 */
describe("终态由 stopReason 决定", () => {
  const cases: Array<[AssistantMessage["stopReason"], string]> = [
    ["stop", "complete"],
    ["length", "complete"],
    ["toolUse", "complete"],
    ["aborted", "aborted"],
    ["error", "error"],
  ];

  for (const [stopReason, status] of cases) {
    test(`stopReason=${stopReason} → status=${status}`, () => {
      const message = assistant([{ type: "text", text: "半句话" }], stopReason);
      const { transcript } = replay([
        { type: "message_start", message },
        { type: "message_end", message },
      ]);
      assert.equal(transcript[0]?.status, status);
    });
  }

  test("length / toolUse 的 stopReason 原样带上，别的落回 stop", () => {
    const seen = (stopReason: AssistantMessage["stopReason"]) => {
      const message = assistant([{ type: "text", text: "x" }], stopReason);
      const { transcript } = replay([
        { type: "message_start", message },
        { type: "message_end", message },
      ]);
      const item = transcript[0];
      return item !== undefined && "stopReason" in item ? item.stopReason : undefined;
    };
    assert.equal(seen("length"), "length");
    assert.equal(seen("toolUse"), "toolUse");
    assert.equal(seen("stop"), "stop");
    // pi 的 StopReason 比协议宽：pending / deferred 协议不认，落回 stop
    assert.equal(seen("deferred"), "stop");
  });
});
