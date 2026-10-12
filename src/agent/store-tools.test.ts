/**
 * 4-3 的账：工具 execute 把参数翻成请求事件、回执翻成结果；prompt 注入
 * 讲了两个工具与 scope。写盘本身在 main 侧的 write-requests（真 store）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createStoreTools, storeToolsGuideline } from "./store-tools.ts";

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
    const text = storeToolsGuideline({ name: "orbita" }, "/repos/orbita");
    assert.match(text, /create_skill/);
    assert.match(text, /add_mcp_server/);
    assert.match(text, /SKILL\.md/);
    assert.match(text, /"global"/);
    assert.match(text, /"workspace"/);
    assert.match(text, /approval/);
    // 4-7 补刀：正文写法要讲给「未来读它的 agent」
    assert.match(text, /WHEN to use it/);
    assert.match(text, /No greetings/);
    // 归属要讲名字（2026-10-11：旧静态文案不说归属，模型只能瞎猜 scope）
    assert.match(text, /workspace "orbita"/);
  });

  test("文案说实话（2026-10 根因修复）：skill 是按需加载的手册，不是每轮生效的规则", () => {
    const text = storeToolsGuideline({ name: "orbita" }, "/repos/orbita");
    // 旧文案 "applies to every task" 把 skill 说成一直生效——用户说「把规则加进
    // 工作区」时它就成了唯一的持久化出口（实测触发 create_skill）
    assert.doesNotMatch(text, /applies to every task/);
    assert.doesNotMatch(text, /applies to the current workspace/);
    // 真实语义：每任务只列名字与描述，正文在描述匹配时才被读
    assert.match(text, /lists the skill's\s+name and description only/);
    assert.match(text, /read only when the description matches the task/);
    // 「Prefer them …」收窄到「建 skill / 加 MCP 别让用户手动拷文件」，不再把一切
    // 要保存的东西都推向这俩工具
    assert.doesNotMatch(text, /Prefer them over/);
    assert.match(text, /copy files into place by hand/);
  });

  test("常驻规则指路：路径写进提示词、可新建、不提供全局规则去处", () => {
    const text = storeToolsGuideline({ name: "orbita" }, "/repos/orbita");
    // 具体路径必须写死进提示词——多数用户工作区根本没有 AGENTS.md，
    // 不写路径模型连「有这个去处」都不知道
    assert.match(text, /\/repos\/orbita\/AGENTS\.md/);
    assert.match(text, /read into context as project instructions every turn/);
    assert.match(text, /may not[\s\S]*exist yet — create it/);
    // 常驻规则禁入 skill：描述不匹配时会静默不生效
    assert.match(text, /Never store a standing rule as a skill/);
    assert.match(text, /silently not apply/);
    // 用户只是口述规则时要问一句
    assert.match(text, /ask once whether to write it into the rules file/);
    // 不提 ~/.pi/agent——那是 pi CLI 自己的全局配置，写它会外溢到用户单独用 pi 的场景
    assert.doesNotMatch(text, /\.pi\/agent/);
  });

  test("工具描述同步说实话：create_skill 的 description 讲按需加载与 AGENTS.md 去处", () => {
    const { tools } = setup();
    const description = tools[0]?.description ?? "";
    assert.doesNotMatch(description, /applies to every task/);
    assert.match(description, /read only when the task matches/);
    assert.match(description, /AGENTS\.md/);
  });

  test("归属三态：无工作区明说必拒；有工作区报名字；翻不出名字说未知不猜", () => {
    const none = storeToolsGuideline(null, "/repos/home");
    assert.match(none, /does NOT belong to any workspace/);
    assert.match(none, /will be rejected/);
    assert.match(none, /use "global"/);
    // 无工作区 = 没有项目规则文件，让模型问用户放哪，不许自己挑地方
    assert.match(none, /no project rules file/);
    assert.match(none, /ask the user where to keep such a rule/);
    assert.doesNotMatch(none, /\/AGENTS\.md/);

    const named = storeToolsGuideline({ name: "论文 3" }, "/papers/3");
    assert.match(named, /workspace "论文 3"/);
    // scope 的 workspace 一侧也换成「只在该工作区的任务里列出」的实话
    assert.match(named, /are listed only in that workspace's sessions/);
    assert.match(named, /\/papers\/3\/AGENTS\.md/);
    assert.doesNotMatch(named, /unknown/);

    const unknown = storeToolsGuideline({}, "/old/fixture");
    assert.match(unknown, /name is not available here/);
    assert.match(unknown, /scope "workspace" is allowed/);
    assert.doesNotMatch(unknown, /belongs to workspace "/);
    assert.match(unknown, /\/old\/fixture\/AGENTS\.md/);
  });
});
