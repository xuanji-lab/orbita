/**
 * B-1 / B-2 的账：task 工具族把参数翻成请求事件、回执翻成工具结果——
 * text 进模型上下文，card 挂 details（只给 UI）。读盘与开轮本身在 main 侧
 * （read-task.ts / dispatch.ts，真 store）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createTaskTools } from "./task-tools.ts";
import type { ReadTaskOutcome, StartTaskOutcome } from "../shared/agent-ipc.ts";

/** 收走请求事件，稍后人工回执——模拟主进程 */
class FakeMain {
  readonly sent: object[] = [];
  private broker: RequestBroker | null = null;
  wire(broker: RequestBroker): void {
    this.broker = broker;
  }
  answer(requestId: string, result: ReadTaskOutcome | StartTaskOutcome): void {
    this.broker?.resolve(requestId, result);
  }
  requestIdAt(index: number): string {
    const event = this.sent[index] as { requestId?: string };
    return event.requestId ?? "";
  }
}

const setup = (
  canDispatch = false,
): { tools: ReturnType<typeof createTaskTools>; fake: FakeMain } => {
  const fake = new FakeMain();
  const broker = new RequestBroker((event) => {
    fake.sent.push(event);
  });
  fake.wire(broker);
  return { tools: createTaskTools(broker, "session-1", canDispatch), fake };
};

const readTaskOf = (tools: ReturnType<typeof createTaskTools>) =>
  tools.find((tool) => tool.name === "read_task");
const startTaskOf = (tools: ReturnType<typeof createTaskTools>) =>
  tools.find((tool) => tool.name === "start_task");

describe("read_task（B-1）", () => {
  test("参数翻成 readTaskRequest（带发起会话）；回执 ok → text 进 content、card 进 details", async () => {
    const { tools, fake } = setup();
    const tool = readTaskOf(tools);
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
    const { tools, fake } = setup();
    const tool = readTaskOf(tools);
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

  test("回执失败翻成抛出（pi 只认 throw 为 isError），message 是主进程的错", async () => {
    const { tools, fake } = setup();
    const tool = readTaskOf(tools);
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-4", { task: "ghost" }, undefined, undefined, undefined as never);
    fake.answer(fake.requestIdAt(0), { ok: false, error: "No task matches \"ghost\"." });
    await assert.rejects(pending, /No task matches/);
  });
});

describe("start_task（B-2）", () => {
  test("canDispatch=true 才注册；子会话（false）看不到这把工具", () => {
    assert.ok(startTaskOf(setup(true).tools) !== undefined);
    assert.equal(startTaskOf(setup(false).tools), undefined);
    // read_task 不受门控影响：子会话仍然能读别的 task
    assert.ok(readTaskOf(setup(false).tools) !== undefined);
  });

  test("参数翻成 startTaskRequest；空 model 当缺席；回执 ok → text 进 content、card 进 details", async () => {
    const { tools, fake } = setup(true);
    const tool = startTaskOf(tools);
    assert.ok(tool !== undefined);
    const pending = tool.execute(
      "call-1",
      { title: "Fix login", prompt: "Fix the login redirect in src/auth.ts. Done = tests pass." },
      undefined,
      undefined,
      undefined as never,
    );
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "startTaskRequest");
    assert.equal(sent.sessionId, "session-1");
    assert.equal(sent.title, "Fix login");
    assert.equal(sent.prompt, "Fix the login redirect in src/auth.ts. Done = tests pass.");
    assert.equal("model" in sent, false);
    fake.answer(fake.requestIdAt(0), {
      ok: true,
      card: { sessionId: "child-1", title: "Fix login" },
      text: "Task started: \"Fix login\" (id child-1). …",
    });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Task started: \"Fix login\" (id child-1). …" }]);
    assert.deepEqual(result.details, { startTask: { sessionId: "child-1", title: "Fix login" } });
  });

  test("model 覆盖上船（前后空白剥掉）；回执失败翻成抛出", async () => {
    const { tools, fake } = setup(true);
    const tool = startTaskOf(tools);
    assert.ok(tool !== undefined);
    const pending = tool.execute(
      "call-2",
      { title: "T", prompt: "P", model: "  glm-5-air  " },
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal((fake.sent[0] as Record<string, unknown>).model, "glm-5-air");
    fake.answer(fake.requestIdAt(0), { ok: false, error: "3 child tasks are already running" });
    await assert.rejects(pending, /already running/);
  });
});
