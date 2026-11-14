import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import { applyTranscriptProgress, createTranscriptState, selectTranscript } from "../shared/transcript-state.ts";
import type { TranscriptItem } from "../shared/transcript.ts";
import { KernelView } from "./kernel-view.ts";
import { TranscriptAdapter } from "./transcript-adapter.ts";

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: "faux", provider: "faux", model: "tiny", usage: USAGE, stopReason, timestamp: 1 } as AssistantMessage;
}

function entry(id: number, kind: string, model: unknown[]): EntryRecord {
  return { id, conversationId: 1, kind, model } as unknown as EntryRecord;
}

function view(entries: EntryRecord[], live?: unknown): ConversationView {
  return { conversation: {} as ConversationView["conversation"], entries, docs: live === undefined ? {} : { "pi.live": live as never } };
}

function rig(): { view: KernelView; events: AgentEvent[]; transcript: () => readonly TranscriptItem[]; compactions: EntryRecord[]; tools: string[] } {
  const events: AgentEvent[] = [];
  const compactions: EntryRecord[] = [];
  const tools: string[] = [];
  let id = 0;
  const adapter = new TranscriptAdapter({ newId: () => `id${++id}`, now: () => 1000 });
  const kernelView = new KernelView("s1", adapter, {
    send: (event) => events.push(event),
    now: () => 1000,
    compactionPlaced: (placed) => compactions.push(placed),
    toolEnd: (callId) => tools.push(callId),
  });
  return {
    view: kernelView,
    events,
    compactions,
    tools,
    transcript: () => {
      let state = createTranscriptState({ id: "s1", cwd: "/", createdAt: 0, updatedAt: 0, phase: "idle", model: { provider: "faux", id: "tiny" }, thinkingLevel: "off", attached: true, locked: false, revision: 0, transcript: [], queuedSteer: [], queuedSteerCount: 0 });
      for (const event of events) if (event.type === "progress") state = applyTranscriptProgress(state, event.progress);
      return selectTranscript(state);
    },
  };
}

describe("KernelView：durable 视图 → 旧内核同形的转录 progress", () => {
  it("流式增量：半截回答逐次变长 → 一条 item_started + 若干 assistant_delta，终态以条目为准；attach 之前的条目不重放", () => {
    const r = rig();
    r.view.attach(view([entry(1, "pi.user", [{ role: "user", content: "旧的", timestamp: 1 }])]));
    r.view.advance(view([], { generation: { attempt: 1, message: assistant([{ type: "text", text: "你" }]) } }));
    r.view.advance(view([], { generation: { attempt: 1, message: assistant([{ type: "text", text: "你好，" }]) } }));
    r.view.advance(view([], { generation: { attempt: 1, message: assistant([{ type: "text", text: "你好，世界" }, { type: "thinking", thinking: "x" }]) } }));
    r.view.advance(view([entry(2, "pi.assistant", [assistant([{ type: "text", text: "你好，世界！" }])])]));
    const deltas = r.events.filter((event) => event.type === "progress" && event.progress.type === "assistant_delta");
    assert.ok(deltas.length >= 2);
    const items = r.transcript();
    assert.equal(items.length, 1, "旧条目没有重放");
    assert.match(JSON.stringify(items[0]), /你好，世界！/);
    assert.equal((items[0] as { status: string }).status, "complete");
  });

  it("流到一半失败、durable 等重试：上一次尝试按 error 终态收掉，重试状态报出去（前几次不进界面），新尝试开跑时清掉", () => {
    const r = rig();
    r.view.attach(view([]));
    r.view.turnActive = true;
    r.view.advance(view([], { generation: { attempt: 1, message: assistant([{ type: "text", text: "半截" }]) } }));
    r.view.advance(view([], { generation: { attempt: 2, retry: { at: 3000, error: "503" } } }));
    assert.equal((r.transcript()[0] as { status: string }).status, "error");
    assert.equal(r.view.retries, 1);
    // 第 1 次重试不进界面（retryVisibleToUi 的阈值），不发 retry 事件
    assert.ok(!r.events.some((event) => event.type === "retry" && event.status !== null));
    r.view.advance(view([], { generation: { attempt: 2, message: assistant([{ type: "text", text: "重来" }]) } }));
    assert.ok(r.events.some((event) => event.type === "retry" && event.status === null));
    assert.ok(r.events.some((event) => event.type === "phase" && event.phase === "turn"));
  });

  it("工具配对：钩子报开始、onUpdate 报进度、结果条目报结束；没走到钩子就被拒的调用先补一个开始", () => {
    const r = rig();
    r.view.attach(view([]));
    const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { path: "a" } });
    r.view.advance(view([entry(1, "pi.assistant", [assistant([call("c1", "read"), call("c2", "nope")] as never, "toolUse")])]));
    r.view.toolStart("c1", "read", { path: "a" });
    r.view.toolUpdate("c1", "read", { content: [{ type: "text", text: "部分" }] });
    r.view.advance(
      view([
        entry(2, "pi.tool-result", [{ role: "toolResult", toolCallId: "c2", toolName: "nope", content: [{ type: "text", text: "Tool nope not found" }], isError: true, timestamp: 1 }]),
        entry(3, "pi.tool-result", [{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "全部" }], isError: false, timestamp: 1 }]),
      ]),
    );
    const items = r.transcript();
    assert.deepEqual(
      items.map((item) => `${item.role}:${"status" in item ? item.status : ""}`),
      ["assistant:complete", "tool:complete", "tool:error"],
    );
    assert.deepEqual(r.tools, ["c2", "c1"]);
    assert.ok(r.events.some((event) => event.type === "progress" && event.progress.type === "item_updated" && JSON.stringify(event.progress).includes("部分")));
  });

  it("用户消息：自己回显过的按原文对账丢掉；对不上的（父会话插话）当场显形；压缩条目交给调用方", () => {
    const r = rig();
    r.view.attach(view([]));
    r.view.noteEcho("我说的");
    r.view.advance(
      view([
        entry(1, "pi.user", [{ role: "user", content: [{ type: "text", text: "我说的" }], timestamp: 1 }]),
        entry(2, "pi.user", [{ role: "user", content: [{ type: "text", text: "父会话插话" }], timestamp: 1 }]),
        entry(3, "pi.compaction", [{ role: "user", content: [{ type: "text", text: "summary" }], timestamp: 1 }]),
      ]),
    );
    assert.deepEqual(
      r.transcript().map((item) => JSON.stringify(item.content)),
      [JSON.stringify([{ type: "text", text: "父会话插话" }])],
    );
    assert.equal(r.compactions.length, 1);
  });

  it("阻塞式压缩进行中：phase compaction，压完回 turn（只在轮里报）", () => {
    const r = rig();
    r.view.attach(view([]));
    r.view.turnActive = true;
    r.view.advance(view([], { run: {}, compactions: [{ taskId: 1, trigger: "threshold", blocking: true, attempt: 1 }] }));
    r.view.advance(view([], { run: {} }));
    assert.deepEqual(
      r.events.flatMap((event) => (event.type === "phase" ? [event.phase] : [])),
      ["compaction", "turn"],
    );
  });

  it("attach 之前到的变化：先按 attach 的版本立基线，再补上那一帧（durable 的 observer 可能先于 promise 交第一帧）", () => {
    const r = rig();
    r.view.advance(view([entry(1, "pi.user", [{ role: "user", content: "早到", timestamp: 1 }]), entry(2, "pi.assistant", [assistant([{ type: "text", text: "新回答" }])])]));
    r.view.attach(view([entry(1, "pi.user", [{ role: "user", content: "早到", timestamp: 1 }])]));
    const items = r.transcript();
    assert.equal(items.length, 1);
    assert.match(JSON.stringify(items[0]), /新回答/);
  });
});
