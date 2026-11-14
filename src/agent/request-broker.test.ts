/**
 * requestId 问答通道的账（4-3 立，B-1 泛化）：配对、迟到回执丢弃、
 * 泛型载荷原样到达。具体工具如何翻参数在各自测试（store-tools / task-tools）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isToolReply, RequestBroker, toolReplyResult } from "./request-broker.ts";
import type { ReadTaskOutcome } from "../shared/agent-ipc.ts";

describe("RequestBroker", () => {
  test("回执按 requestId 配对，泛型载荷原样到达（readTaskOutcome 同款形状）", async () => {
    const sent: object[] = [];
    const broker = new RequestBroker((event) => sent.push(event));
    const pending = broker.request<ReadTaskOutcome>({ type: "readTaskRequest", sessionId: "s1", task: "demo" });
    const event = sent[0] as Record<string, unknown>;
    assert.equal(event.type, "readTaskRequest");
    assert.equal(event.sessionId, "s1");
    assert.equal(typeof event.requestId, "string");
    broker.resolve(
      String(event.requestId),
      { ok: true, card: { sessionId: "t1", title: "Demo", mode: "briefing", roundCount: 3 }, text: "…body…" },
    );
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.card?.title, "Demo");
      assert.equal(result.text, "…body…");
    }
  });

  test("迟到的回执（未知 requestId）静默丢弃，不炸", () => {
    const broker = new RequestBroker(() => undefined);
    broker.resolve("never-sent", { ok: true });
    // 没抛就是过
  });

  test("并发请求互不串线：各回各的", async () => {
    const sent: object[] = [];
    const broker = new RequestBroker((event) => sent.push(event));
    const first = broker.request<ReadTaskOutcome>({ type: "readTaskRequest", task: "a" });
    const second = broker.request<ReadTaskOutcome>({ type: "readTaskRequest", task: "b" });
    const idOf = (index: number): string => String((sent[index] as Record<string, unknown>).requestId);
    broker.resolve(idOf(1), { ok: false, error: "second failed" });
    broker.resolve(idOf(0), { ok: false, error: "first failed" });
    const firstResult = await first;
    const secondResult = await second;
    assert.equal(firstResult.ok, false);
    assert.equal(secondResult.ok, false);
    if (!firstResult.ok) assert.match(firstResult.error, /first/);
    if (!secondResult.ok) assert.match(secondResult.error, /second/);
  });

  test("超时按请求给：到点回一句人话，之后迟到的回执丢弃", async () => {
    const sent: object[] = [];
    const broker = new RequestBroker((event) => sent.push(event));
    const pending = broker.request<ReadTaskOutcome>({ type: "readTaskRequest" }, 20);
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /回执/);
    broker.resolve(String((sent[0] as Record<string, unknown>).requestId), { ok: true, card: null, text: "late" });
  });
});

describe("toolReplyResult：两个内核共用的回执翻法", () => {
  test("失败回执补默认错误文案，成功回执只挑工具认的字段", () => {
    assert.deepEqual(toolReplyResult({ type: "skillWriteResult", requestId: "r", ok: false }), { ok: false, error: "Write failed" });
    assert.deepEqual(toolReplyResult({ type: "readTaskResult", requestId: "r", ok: false, error: "" }), { ok: false, error: "" });
    assert.deepEqual(
      toolReplyResult({ type: "channelSendResult", requestId: "r", ok: true, messageId: "m1" }),
      { ok: true, messageId: "m1" },
    );
  });

  test("形状即契约的回执原样给；意图确认等非工具回执不认", () => {
    const terminal = { type: "terminalResult", requestId: "r", ok: true, text: "t" } as const;
    assert.equal(isToolReply(terminal as never), true);
    assert.equal(toolReplyResult(terminal as never), terminal);
    assert.equal(isToolReply({ type: "intentConfirmResult", requestId: "r", decision: "cancel" } as never), false);
    assert.equal(isToolReply({ type: "abort", sessionId: "s" }), false);
  });
});
