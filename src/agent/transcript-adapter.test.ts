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
    ...(prompt === undefined ? [] : adapter.userPrompt(prompt === "" ? [] : prompt.split("\n\n"))),
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

  test("终态帧透传 usage——renderer 的 token 速度靠它记账，丢了就算不出来", () => {
    const end = assistant([{ type: "text", text: "Hello, world" }]);
    end.usage = { ...end.usage, output: 4100 };
    const { frames } = replay([
      { type: "message_start", message: assistant([{ type: "text", text: "" }]) },
      { type: "message_end", message: end },
    ]);
    const finished = frames.find((f) => f.type === "item_finished");
    assert.ok(finished !== undefined && finished.type === "item_finished");
    assert.equal(finished.item.usage?.output, 4100);
  });

  test("终态帧挂纯生成时长 genMs——message_start 到 message_end 的钟，不在这里算速度", () => {
    let clock = 1_000;
    const timed = new TranscriptAdapter({ newId: () => `id-${++counter}`, now: () => clock });
    const message = assistant([{ type: "text", text: "done" }]);
    message.usage = { ...message.usage, output: 800 };
    timed.apply({ type: "message_start", message: assistant([{ type: "text", text: "" }]) });
    clock = 3_000; // 生成 2 秒
    const frames = timed.apply({ type: "message_end", message });
    assert.ok(frames[0]?.type === "item_finished");
    assert.equal((frames[0].item as { genMs?: number }).genMs, 2_000);
    assert.equal(frames[0].item.usage?.output, 800);
  });

  test("短到几百毫秒的帧照样挂 genMs——噪音门在 renderer 按整轮加总后判，不在这里丢", () => {
    let clock = 1_000;
    const timed = new TranscriptAdapter({ newId: () => `id-${++counter}`, now: () => clock });
    const message = assistant([{ type: "text", text: "quick" }]);
    timed.apply({ type: "message_start", message: assistant([{ type: "text", text: "" }]) });
    clock = 1_300; // 只生成 300ms
    const frames = timed.apply({ type: "message_end", message });
    assert.ok(frames[0]?.type === "item_finished");
    assert.equal((frames[0].item as { genMs?: number }).genMs, 300);
  });

  test("打断（aborted）的回答照样挂 genMs，且终态判定不被劫持", () => {
    let clock = 1_000;
    const timed = new TranscriptAdapter({ newId: () => `id-${++counter}`, now: () => clock });
    const message = assistant([{ type: "text", text: "half…" }], "aborted");
    timed.apply({ type: "message_start", message: assistant([{ type: "text", text: "" }]) });
    clock = 3_000;
    const frames = timed.apply({ type: "message_end", message });
    assert.ok(frames[0]?.type === "item_finished");
    assert.equal(frames[0].item.status, "aborted");
    assert.equal((frames[0].item as { genMs?: number }).genMs, 2_000);
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

  test("带图的用户消息：文字在前、图片在后（同 pi 拼的块序）", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const [frame] = new TranscriptAdapter(deps).userPrompt(["看这张"], [image]);
    assert.equal(frame?.type, "item_started");
    assert.deepEqual(frame?.type === "item_started" ? frame.item.content : null, [
      { type: "text", text: "看这张" },
      image,
    ]);
  });

  test("图块上自挂的 original 引用经 pi 的归约器原样保留——看大图靠它找原图", () => {
    const image = {
      type: "image" as const,
      data: "AAAA",
      mimeType: "image/png",
      original: "01a0c4fd-9ee5-73fc-82a8-78c43b90d20d/5b0d1a52-8c7e-4c52-9d0b-3f6a2b1c9e10.png",
    };
    let state: TranscriptState = createTranscriptState(emptySnapshot());
    for (const frame of new TranscriptAdapter(deps).userPrompt([], [image])) {
      state = applyTranscriptProgress(state, frame);
    }
    assert.deepEqual(selectTranscript(state)[0]?.content, [image]);
  });

  test("只发图：不造空 text 块；什么都没有时仍保留一个空 text 块（原行为）", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const [onlyImage] = new TranscriptAdapter(deps).userPrompt([], [image]);
    assert.deepEqual(onlyImage?.type === "item_started" ? onlyImage.item.content : null, [image]);
    const [empty] = new TranscriptAdapter(deps).userPrompt([]);
    assert.deepEqual(empty?.type === "item_started" ? empty.item.content : null, [{ type: "text", text: "" }]);
  });

  test("句中粘贴块内联的正文按空行拆块回显（方案 C）", () => {
    const text = "看这段\n\n<pasted-text>\n第一行\n第二行\n</pasted-text>\n\n如何";
    const adapter = new TranscriptAdapter(deps);
    const [frame] = adapter.userPrompt(text.split("\n\n").filter((part) => part !== ""));
    const item = frame?.type === "item_started" ? frame.item : null;
    assert.deepEqual(
      item?.content,
      [
        { type: "text", text: "看这段" },
        { type: "text", text: "<pasted-text>\n第一行\n第二行\n</pasted-text>" },
        { type: "text", text: "如何" },
      ],
    );
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
      const item = transcript[0];
      // user 变体没有 status，先窄化到 assistant 再读
      assert.ok(item !== undefined && item.role === "assistant");
      assert.equal(item.status, status);
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
    // 协议把 error 变体绑死 stopReason: "error"（不能落 "stop"）——回归锚点
    assert.equal(seen("error"), "error");
  });
});

/**
 * 工具执行。判分方式同上——帧喂进 pi 自己的归约器，看重建出来的 transcript。
 *
 * 这一组之前完全不存在：`asAdaptable` 只放行三个 `message_*`，于是协议的第三支
 * （`role: "tool"`）**我们从来没生产过**——屏幕、`.jsonl`、导出的 Markdown 里都没有。
 */
describe("TranscriptAdapter · 工具结果", () => {
  test("start → end：重建出一条 complete 的 tool item，入参与产出都在", () => {
    const { transcript } = replay([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls src" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "agent\nmain\nshared" }], details: null },
        isError: false,
      },
    ]);

    assert.equal(transcript.length, 1);
    const item = transcript[0];
    assert.equal(item?.role, "tool");
    if (item?.role !== "tool") return;
    assert.equal(item.toolCallId, "call-1");
    assert.equal(item.toolName, "bash");
    assert.equal(item.status, "complete");
    assert.equal(item.isError, false);
    assert.deepEqual(item.content, [{ type: "text", text: "agent\nmain\nshared" }]);
    // end 事件上游不再给 args——入参能在，靠的是 start 时接住了它
    assert.deepEqual(item.input, { command: "ls src" });
  });

  test("失败的工具：status=error 且 isError=true", () => {
    const { transcript } = replay([
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: { content: [{ type: "text", text: "command not found" }], details: null },
        isError: true,
      },
    ]);
    const item = transcript[0];
    assert.equal(item?.role, "tool");
    if (item?.role !== "tool") return;
    assert.equal(item.status, "error");
    assert.equal(item.isError, true);
  });

  test("空 content 的中间帧 → 空正文，不要退化成 JSON 字符串", () => {
    // 真机现象：pi 的第一帧 partial 是 `{content: []}`，之前的实现见到「块数为 0」就
    // 落到 JSON.stringify，活尾里于是出现一行 `{"content":[]}`。
    const { frames } = replay([
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} },
      { type: "tool_execution_update", toolCallId: "c", toolName: "bash", args: {}, partialResult: { content: [] } },
    ]);
    const updated = frames.find((frame) => frame.type === "item_updated");
    assert.ok(updated !== undefined);
    if (updated?.type !== "item_updated" || updated.item.role !== "tool") return;
    assert.deepEqual(updated.item.content, []);
  });

  test("流式中间态：start 后是 running，update 不改变终态前的身份", () => {
    const { frames } = replay([
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} },
      {
        type: "tool_execution_update",
        toolCallId: "c",
        toolName: "bash",
        args: {},
        partialResult: { content: [{ type: "text", text: "half" }] },
      },
    ]);
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.type, "item_started");
    assert.equal(frames[1]?.type, "item_updated");
    for (const frame of frames) {
      if (frame.type === "assistant_delta") continue;
      assert.equal(frame.item.role === "tool" ? frame.item.status : null, "running");
    }
  });

  test("一次执行从头到尾只有一个 id", () => {
    const { frames } = replay([
      { type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: "a.ts" } },
      {
        type: "tool_execution_update",
        toolCallId: "c",
        toolName: "read",
        args: { path: "a.ts" },
        partialResult: "partial",
      },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "read",
        result: "done",
        isError: false,
      },
    ]);
    const ids = new Set(frames.map((f) => (f.type === "assistant_delta" ? f.messageId : f.item.id)));
    assert.equal(ids.size, 1, `一次工具执行应只有一个 id，实际 ${[...ids].join(",")}`);
  });

  test("没有配对 start 的 end 一律丢弃——不凭空造一条没有入参的记录", () => {
    const { transcript, frames } = replay([
      {
        type: "tool_execution_end",
        toolCallId: "孤儿",
        toolName: "bash",
        result: "x",
        isError: false,
      },
    ]);
    assert.equal(frames.length, 0);
    assert.equal(transcript.length, 0);
  });

  test("非 AgentToolResult 形状的产出序列化成文本，不打断链路", () => {
    const seen = (result: unknown) => {
      const { transcript } = replay([
        { type: "tool_execution_start", toolCallId: "c", toolName: "custom", args: {} },
        { type: "tool_execution_end", toolCallId: "c", toolName: "custom", result, isError: false },
      ]);
      const item = transcript[0];
      return item?.role === "tool" ? item.content : null;
    };

    assert.deepEqual(seen("plain string"), [{ type: "text", text: "plain string" }]);
    assert.deepEqual(seen({ ok: 1 }), [{ type: "text", text: '{"ok":1}' }]);
    assert.deepEqual(seen(null), []);
    // 循环引用：JSON.stringify 会抛——宁可记一句「没法显示」也不能抛出去
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.deepEqual(seen(cyclic), [{ type: "text", text: "[unserializable tool result]" }]);
  });

  test("details 带进记录——pi 的 edit 工具把 diff 算好放在这里了", () => {
    const { transcript } = replay([
      { type: "tool_execution_start", toolCallId: "c", toolName: "edit", args: { path: "a.ts" } },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { diff: "- old\n+ new", patch: "@@ -1 +1 @@", firstChangedLine: 1 },
        },
        isError: false,
      },
    ]);
    const item = transcript[0];
    assert.equal(item?.role, "tool");
    if (item?.role !== "tool") return;
    assert.deepEqual(item.details, {
      diff: "- old\n+ new",
      patch: "@@ -1 +1 @@",
      firstChangedLine: 1,
    });
  });

  test("details 序列化不了就丢掉 details，不连坑整条结果", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { transcript } = replay([
      { type: "tool_execution_start", toolCallId: "c", toolName: "custom", args: {} },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "custom",
        result: { content: [{ type: "text", text: "still here" }], details: cyclic },
        isError: false,
      },
    ]);
    const item = transcript[0];
    assert.equal(item?.role, "tool");
    if (item?.role !== "tool") return;
    assert.equal(item.details, undefined);
    // 内容还在——details 是锦上添花，不能拖累正文
    assert.deepEqual(item.content, [{ type: "text", text: "still here" }]);
  });

  test("两个工具并行执行：各管各的，不串台", () => {
    const { transcript } = replay([
      { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a" } },
      { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b" } },
      { type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "B", isError: false },
      { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: "A", isError: false },
    ]);

    assert.equal(transcript.length, 2);
    const byCall = new Map(
      transcript.flatMap((item) => (item.role === "tool" ? [[item.toolCallId, item]] : [])),
    );
    assert.deepEqual(byCall.get("a")?.input, { path: "a" });
    assert.deepEqual(byCall.get("a")?.content, [{ type: "text", text: "A" }]);
    assert.deepEqual(byCall.get("b")?.input, { path: "b" });
    assert.deepEqual(byCall.get("b")?.content, [{ type: "text", text: "B" }]);
  });
});
