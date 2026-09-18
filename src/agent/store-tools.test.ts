/**
 * 4-3 的账：工具 execute 把参数翻成请求事件、回执翻成结果；prompt 注入
 * 讲了两个工具与 scope。写盘本身在 main 侧的 write-requests（真 store）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createStoreTools, STORE_TOOLS_GUIDELINES } from "./store-tools.ts";

/** 收走请求事件，稍后人工回执——模拟主进程 */
class FakeMain {
  readonly sent: object[] = [];
  private broker: RequestBroker | null = null;
  wire(broker: RequestBroker): void {
    this.broker = broker;
  }
  answer(requestId: string, result: { ok: boolean; path?: string; status?: { kind: string; message?: string }; error?: string }): void {
    this.broker?.resolve(requestId, result as never);
  }
  requestIdAt(index: number): string {
    const event = this.sent[index] as { requestId?: string };
    return event.requestId ?? "";
  }
}

const setup = (): { tools: ReturnType<typeof createStoreTools>; fake: FakeMain } => {
  const fake = new FakeMain();
  const broker = new RequestBroker((event) => {
    fake.sent.push(event);
  });
  fake.wire(broker);
  return { tools: createStoreTools(broker, "session-1"), fake };
};

describe("create_skill / add_mcp_server（4-3）", () => {
  test("create_skill：参数翻成 skillWriteRequest（带 sessionId 与 scope），回执 ok 带回路径", async () => {
    const { tools, fake } = setup();
    const tool = tools[0];
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-1", { slug: "pdf", name: "PDF", description: "d", body: "b", scope: "workspace" }, undefined, undefined, undefined as never);
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "skillWriteRequest");
    assert.equal(sent.sessionId, "session-1");
    assert.equal(sent.slug, "pdf");
    assert.equal(sent.scope, "workspace");
    fake.answer(fake.requestIdAt(0), { ok: true, path: "/store/pdf" });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Skill written: /store/pdf" }]);
  });

  test("create_skill：回执失败翻成抛出（pi 只认 throw 为 isError），message 是主进程的错", async () => {
    const { tools, fake } = setup();
    const tool = tools[0];
    assert.ok(tool !== undefined);
    const pending = tool.execute("call-2", { slug: "bad!", name: "x", description: "d", body: "b", scope: "global" }, undefined, undefined, undefined as never);
    fake.answer(fake.requestIdAt(0), { ok: false, error: "非法 skill slug：bad!" });
    await assert.rejects(pending, /非法 skill slug/);
  });

  test("add_mcp_server：server 对象原样上船；ready 状态翻成人话", async () => {
    const { tools, fake } = setup();
    const tool = tools[1];
    assert.ok(tool !== undefined);
    const server = { transport: "stdio", command: "node" };
    const pending = tool.execute("call-3", { name: "demo", server }, undefined, undefined, undefined as never);
    const sent = fake.sent[0] as Record<string, unknown>;
    assert.equal(sent.type, "mcpWriteRequest");
    assert.deepEqual(sent.server, server);
    fake.answer(fake.requestIdAt(0), { ok: true, status: { kind: "ready" } });
    const result = await pending;
    assert.match((result.content[0] as { text: string }).text, /connected/);
  });

  test("prompt 注入：两个工具名、SKILL.md 格式与 scope 语义都讲了", () => {
    assert.match(STORE_TOOLS_GUIDELINES, /create_skill/);
    assert.match(STORE_TOOLS_GUIDELINES, /add_mcp_server/);
    assert.match(STORE_TOOLS_GUIDELINES, /SKILL\.md/);
    assert.match(STORE_TOOLS_GUIDELINES, /"global"/);
    assert.match(STORE_TOOLS_GUIDELINES, /"workspace"/);
    assert.match(STORE_TOOLS_GUIDELINES, /approval/);
    // 4-7 补刀：正文写法要讲给「未来读它的 agent」，scope 有默认取向
    assert.match(STORE_TOOLS_GUIDELINES, /WHEN to use it/);
    assert.match(STORE_TOOLS_GUIDELINES, /No greetings/);
    assert.match(STORE_TOOLS_GUIDELINES, /default to "workspace"/);
  });
});
