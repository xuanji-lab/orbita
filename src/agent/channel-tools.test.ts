/**
 * 子会话通道工具的账：delegate / reply_subsession / report_to_parent 把参数翻成
 * 对应的请求事件、把回执翻成工具结果——落账本身在 main 侧的 channel/requests.ts。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createChannelTools, describeChannelRole } from "./channel-tools.ts";
import type { ChannelSendOutcome, DelegateOutcome } from "../shared/agent-ipc.ts";

/** 收走请求事件，稍后人工回执——模拟主进程（同 task-tools.test.ts 的 FakeMain）。 */
class FakeMain {
  readonly sent: object[] = [];
  private broker: RequestBroker | null = null;
  wire(broker: RequestBroker): void {
    this.broker = broker;
  }
  answer(requestId: string, result: DelegateOutcome | ChannelSendOutcome): void {
    this.broker?.resolve(requestId, result);
  }
  requestIdAt(index: number): string {
    const event = this.sent[index] as { requestId?: string };
    return event.requestId ?? "";
  }
}

type Tool = ReturnType<typeof createChannelTools>[number];

function setup(role: "root" | "child"): { tools: Tool[]; fake: FakeMain } {
  const fake = new FakeMain();
  const broker = new RequestBroker((event) => {
    fake.sent.push(event);
  });
  fake.wire(broker);
  return { tools: createChannelTools(broker, "session-1", role), fake };
}

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `工具 ${name} 应该存在`);
  return tool;
}

describe("createChannelTools：按 role 注册的工具名单", () => {
  test('role "root"：delegate + reply_subsession，不含 report_to_parent', () => {
    const { tools } = setup("root");
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["delegate", "reply_subsession"],
    );
  });

  test('role "child"：只有 report_to_parent——不能再派出，也没有自己的子可回信', () => {
    const { tools } = setup("child");
    assert.deepEqual(tools.map((tool) => tool.name), ["report_to_parent"]);
  });
});

describe("delegate", () => {
  test("参数翻成 delegateRequest（可选字段缺席时不带键）；回执 ok → content 提英文行动指引、details 挂 card", async () => {
    const { tools, fake } = setup("root");
    const delegate = toolByName(tools, "delegate");
    const pending = delegate.execute(
      "call-1",
      { title: "抓个 bug", task: "自包含任务说明" },
      undefined,
      undefined,
      undefined as never,
    );
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "delegateRequest");
    assert.equal(sent.sessionId, "session-1");
    assert.equal(sent.title, "抓个 bug");
    assert.equal(sent.task, "自包含任务说明");
    assert.equal("modelId" in sent, false);
    assert.equal("thinkingLevel" in sent, false);

    fake.answer(fake.requestIdAt(0), {
      ok: true,
      childId: "child-1",
      title: "抓个 bug",
      card: {
        childId: "child-1",
        title: "抓个 bug",
        modelId: "glm-5.3",
        thinkingLevel: "medium",
        workbench: "/workbenches/child-1",
      },
    });
    const result = await pending;
    assert.equal(result.content.length, 1);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /child-1/);
    assert.match(text, /glm-5\.3/);
    assert.match(text, /end this turn/);
    assert.match(text, /do not poll or wait/i);
    assert.deepEqual(result.details, {
      delegate: {
        childId: "child-1",
        title: "抓个 bug",
        modelId: "glm-5.3",
        thinkingLevel: "medium",
        workbench: "/workbenches/child-1",
      },
    });
  });

  test("model / thinkingLevel 给了就原样上船", async () => {
    const { tools, fake } = setup("root");
    const delegate = toolByName(tools, "delegate");
    const pending = delegate.execute(
      "call-2",
      { title: "t", task: "d", model: "claude-opus", thinkingLevel: "high" },
      undefined,
      undefined,
      undefined as never,
    );
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.modelId, "claude-opus");
    assert.equal(sent.thinkingLevel, "high");
    fake.answer(fake.requestIdAt(0), {
      ok: true,
      childId: "c",
      title: "t",
      card: { childId: "c", title: "t", modelId: "claude-opus", thinkingLevel: "high", workbench: "/w" },
    });
    await pending;
  });

  test("title / task 缺席或空白：不发请求，直接抛错", async () => {
    const { tools, fake } = setup("root");
    const delegate = toolByName(tools, "delegate");
    await assert.rejects(
      delegate.execute("call-3", { title: "  ", task: "d" }, undefined, undefined, undefined as never),
      /"title"/,
    );
    await assert.rejects(
      delegate.execute("call-4", { title: "t" }, undefined, undefined, undefined as never),
      /"task"/,
    );
    assert.equal(fake.sent.length, 0);
  });

  test("thinkingLevel 不合法：不发请求，直接抛错", async () => {
    const { tools, fake } = setup("root");
    const delegate = toolByName(tools, "delegate");
    await assert.rejects(
      delegate.execute(
        "call-5",
        { title: "t", task: "d", thinkingLevel: "ultra" },
        undefined,
        undefined,
        undefined as never,
      ),
      /thinkingLevel/,
    );
    assert.equal(fake.sent.length, 0);
  });

  test("回执失败翻成抛出，message 是主进程的错", async () => {
    const { tools, fake } = setup("root");
    const delegate = toolByName(tools, "delegate");
    const pending = delegate.execute("call-6", { title: "t", task: "d" }, undefined, undefined, undefined as never);
    fake.answer(fake.requestIdAt(0), { ok: false, error: "unknown model \"x/y\"" });
    await assert.rejects(pending, /unknown model/);
  });
});

describe("reply_subsession", () => {
  test("参数翻成 channelSendRequest（to = {childId}，kind 恒 reply；delivery 缺席不带键）", async () => {
    const { tools, fake } = setup("root");
    const reply = toolByName(tools, "reply_subsession");
    const pending = reply.execute(
      "call-1",
      { childId: "child-1", text: "答案在这" },
      undefined,
      undefined,
      undefined as never,
    );
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "channelSendRequest");
    assert.equal(sent.sessionId, "session-1");
    assert.deepEqual(sent.to, { childId: "child-1" });
    assert.equal(sent.kind, "reply");
    assert.equal(sent.text, "答案在这");
    assert.equal("delivery" in sent, false);
    fake.answer(fake.requestIdAt(0), { ok: true, messageId: "m-1" });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Reply sent to the sub-session." }]);
    // 落账那条通道消息的 id 进 details（给 renderer 的标记定位），不进给模型看的正文
    assert.deepEqual(result.details, { messageId: "m-1" });
  });

  test("delivery 给了就原样上船（steer / followUp 都合法）", async () => {
    const { tools, fake } = setup("root");
    const reply = toolByName(tools, "reply_subsession");
    const pending = reply.execute(
      "call-2",
      { childId: "child-1", text: "等你这轮结束再看", delivery: "followUp" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal((fake.sent[0] as Record<string, unknown>).delivery, "followUp");
    fake.answer(fake.requestIdAt(0), { ok: true, messageId: "m-2" });
    await pending;
  });

  test("childId / text 缺席或空白：不发请求，直接抛错", async () => {
    const { tools, fake } = setup("root");
    const reply = toolByName(tools, "reply_subsession");
    await assert.rejects(
      reply.execute("call-3", { childId: "", text: "x" }, undefined, undefined, undefined as never),
      /"childId"/,
    );
    await assert.rejects(
      reply.execute("call-4", { childId: "c" }, undefined, undefined, undefined as never),
      /"text"/,
    );
    assert.equal(fake.sent.length, 0);
  });

  test("delivery 不合法：不发请求，直接抛错", async () => {
    const { tools, fake } = setup("root");
    const reply = toolByName(tools, "reply_subsession");
    await assert.rejects(
      reply.execute(
        "call-5",
        { childId: "c", text: "x", delivery: "asap" },
        undefined,
        undefined,
        undefined as never,
      ),
      /delivery/,
    );
    assert.equal(fake.sent.length, 0);
  });

  test("回执失败翻成抛出", async () => {
    const { tools, fake } = setup("root");
    const reply = toolByName(tools, "reply_subsession");
    const pending = reply.execute("call-6", { childId: "ghost", text: "x" }, undefined, undefined, undefined as never);
    fake.answer(fake.requestIdAt(0), { ok: false, error: "no such child \"ghost\"" });
    await assert.rejects(pending, /no such child/);
  });
});

describe("report_to_parent", () => {
  test("参数翻成 channelSendRequest（to = \"parent\"）；done/failed 的确认文案提醒结束这一轮", async () => {
    const { tools, fake } = setup("child");
    const report = toolByName(tools, "report_to_parent");
    const pending = report.execute(
      "call-1",
      { kind: "done", text: "改完了，产出在 /workbench/out.md" },
      undefined,
      undefined,
      undefined as never,
    );
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "channelSendRequest");
    assert.equal(sent.sessionId, "session-1");
    assert.equal(sent.to, "parent");
    assert.equal(sent.kind, "done");
    assert.equal(sent.text, "改完了，产出在 /workbench/out.md");
    fake.answer(fake.requestIdAt(0), { ok: true, messageId: "m-1" });
    const result = await pending;
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /end this turn/i);
    assert.doesNotMatch(text, /m-1/);
    assert.deepEqual(result.details, { messageId: "m-1" });
  });

  test("kind 为 question/progress 时确认文案不带「结束这一轮」", async () => {
    const { tools, fake } = setup("child");
    const report = toolByName(tools, "report_to_parent");
    const pending = report.execute(
      "call-2",
      { kind: "progress", text: "在读文件" },
      undefined,
      undefined,
      undefined as never,
    );
    fake.answer(fake.requestIdAt(0), { ok: true, messageId: "m-2" });
    const result = await pending;
    const text = (result.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /end this turn/i);
  });

  test("kind 不合法（如 task / reply，只能来自父）：不发请求，直接抛错", async () => {
    const { tools, fake } = setup("child");
    const report = toolByName(tools, "report_to_parent");
    await assert.rejects(
      report.execute("call-3", { kind: "task", text: "x" }, undefined, undefined, undefined as never),
      /"kind"/,
    );
    assert.equal(fake.sent.length, 0);
  });

  test("text 缺席或空白：不发请求，直接抛错", async () => {
    const { tools, fake } = setup("child");
    const report = toolByName(tools, "report_to_parent");
    await assert.rejects(
      report.execute("call-4", { kind: "question", text: "  " }, undefined, undefined, undefined as never),
      /"text"/,
    );
    assert.equal(fake.sent.length, 0);
  });

  test("回执失败翻成抛出", async () => {
    const { tools, fake } = setup("child");
    const report = toolByName(tools, "report_to_parent");
    const pending = report.execute("call-5", { kind: "failed", text: "x" }, undefined, undefined, undefined as never);
    fake.answer(fake.requestIdAt(0), { ok: false, error: "no parent for this session" });
    await assert.rejects(pending, /no parent/);
  });
});

describe("describeChannelRole", () => {
  const FACTS = { sessionModelId: "deepseek-v4" } as const;

  test("root：含 delegate / reply_subsession，不含 report_to_parent", () => {
    const text = describeChannelRole("root", "skip", [], FACTS);
    assert.match(text, /delegate/);
    assert.match(text, /reply_subsession/);
    assert.doesNotMatch(text, /report_to_parent/);
  });

  test("child：含 report_to_parent，不含 delegate", () => {
    const text = describeChannelRole("child", "skip", [], FACTS);
    assert.match(text, /report_to_parent/);
    assert.doesNotMatch(text, /\bdelegate\b/);
  });
});
