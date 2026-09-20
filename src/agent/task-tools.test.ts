/**
 * B-1 的账：read_task 工具把参数翻成 readTaskRequest、回执翻成工具结果——
 * text 进模型上下文，card 挂 details（只给 UI）。读盘本身在 main 侧的
 * read-task（真 store）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createTaskTools } from "./task-tools.ts";
import type { ReadTaskOutcome } from "../shared/agent-ipc.ts";

/** 收走请求事件，稍后人工回执——模拟主进程 */
class FakeMain {
  readonly sent: object[] = [];
  private broker: RequestBroker | null = null;
  wire(broker: RequestBroker): void {
    this.broker = broker;
  }
  answer(requestId: string, result: ReadTaskOutcome): void {
    this.broker?.resolve(requestId, result);
  }
  requestIdAt(index: number): string {
    const event = this.sent[index] as { requestId?: string };
    return event.requestId ?? "";
  }
}

const setup = (): { tool: ReturnType<typeof createTaskTools>[number] | undefined; fake: FakeMain } => {
  const fake = new FakeMain();
  const broker = new RequestBroker((event) => {
    fake.sent.push(event);
  });
  fake.wire(broker);
  return { tool: createTaskTools(broker, "session-1")[0], fake };
};

describe("read_task（B-1）", () => {
  test("参数翻成 readTaskRequest（带发起会话）；回执 ok → text 进 content、card 进 details", async () => {
    const { tool, fake } = setup();
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-1", { task: "fix sidebar" }, undefined, undefined, undefined as never);
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "readTaskRequest");
    assert.equal(sent.sessionId, "session-1");
    assert.equal(sent.task, "fix sidebar");
    assert.equal("rounds" in sent, false);
    fake.answer(fake.requestIdAt(0), {
      ok: true,
      card: { sessionId: "t-1", title: "Fix sidebar", mode: "briefing", roundCount: 4 },
      text: "Task \"Fix sidebar\"…",
    });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Task \"Fix sidebar\"…" }]);
    assert.deepEqual(result.details, {
      readTask: { sessionId: "t-1", title: "Fix sidebar", mode: "briefing", roundCount: 4 },
    });
  });

  test("rounds 原样上船；空串当缺席", async () => {
    const { tool, fake } = setup();
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-2", { task: "t", rounds: "2-5" }, undefined, undefined, undefined as never);
    assert.deepEqual((fake.sent[0] as Record<string, unknown>).rounds, "2-5");
    fake.answer(fake.requestIdAt(0), { ok: true, card: { sessionId: "t", title: "T", mode: "rounds", rounds: "2-5", roundCount: 6 }, text: "…" });
    await pending;
    const second = tool.execute("call-3", { task: "t", rounds: "  " }, undefined, undefined, undefined as never);
    assert.equal("rounds" in (fake.sent[1] as Record<string, unknown>), false);
    fake.answer(fake.requestIdAt(1), { ok: false, error: "No task matches" });
    await second.catch(() => undefined);
  });

  test("task 缺席 / 空白：不带该字段上船（目录模式），card 为 null 时不挂 details", async () => {
    const { tool, fake } = setup();
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-5", {}, undefined, undefined, undefined as never);
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "readTaskRequest");
    assert.equal("task" in sent, false);
    fake.answer(fake.requestIdAt(0), { ok: true, card: null, text: 'Workspace "orbita": 2 other tasks…' });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: 'Workspace "orbita": 2 other tasks…' }]);
    assert.deepEqual(result.details, {});
    const blank = tool.execute("call-6", { task: "  " }, undefined, undefined, undefined as never);
    assert.equal("task" in (fake.sent[1] as Record<string, unknown>), false);
    fake.answer(fake.requestIdAt(1), { ok: true, card: null, text: "…" });
    await blank;
  });

  test("task 不在 required 里（无参调用是合法的第一步）", () => {
    const { tool } = setup();
    assert.ok(tool !== undefined);
    const parameters = tool.parameters as unknown as { required?: string[] };
    assert.deepEqual(parameters.required ?? [], []);
  });

  test("回执失败翻成抛出（pi 只认 throw 为 isError），message 是主进程的错", async () => {
    const { tool, fake } = setup();
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-4", { task: "ghost" }, undefined, undefined, undefined as never);
    fake.answer(fake.requestIdAt(0), { ok: false, error: "No task matches \"ghost\"." });
    await assert.rejects(pending, /No task matches/);
  });
});
