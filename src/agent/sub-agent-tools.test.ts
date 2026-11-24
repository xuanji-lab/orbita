import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decidePermission } from "../shared/permission.ts";
import type { SubAgentToolOutcome, SubAgentToolRequest } from "../shared/sub-agent.ts";
import { createChannelTools } from "./channel-tools.ts";
import { RequestBroker } from "./request-broker.ts";
import { createSubAgentTools, describeSubAgentIdentity, SUB_AGENT_TOOL_NAMES, SUB_AGENTS_MAIN_GUIDELINE, toCreateInput, toUpdateInput } from "./sub-agent-tools.ts";
import { joinSystemPrompt, orbitaSystemSegments, type SystemPromptInput } from "./system-prompt.ts";

/** 假主进程：记下收到的请求事件，按给定回执回 */
function harness(outcome: SubAgentToolOutcome) {
  const events: Record<string, unknown>[] = [];
  const broker: RequestBroker = new RequestBroker((event) => {
    const record = event as Record<string, unknown>;
    events.push(record);
    setImmediate(() => broker.resolve(String(record["requestId"]), outcome));
  });
  const tools = createSubAgentTools(broker, "S");
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    return tool;
  };
  return { events, byName, tools, broker };
}

const noSignal = undefined as never;

describe("子智能体工具：参数校验与请求形状", () => {
  test("三个工具；list 三档放行，create / update 走默认写闸门（plan 拒、manual 问）", () => {
    assert.deepEqual(harness({ ok: true, text: "" }).tools.map((tool) => tool.name), [...SUB_AGENT_TOOL_NAMES]);
    for (const mode of ["plan", "manual", "skip"] as const) assert.deepEqual(decidePermission(mode, "list_sub_agents"), { behavior: "allow" });
    assert.equal(decidePermission("plan", "create_sub_agent").behavior, "deny");
    assert.equal(decidePermission("manual", "update_sub_agent").behavior, "ask");
    assert.equal(decidePermission("skip", "create_sub_agent").behavior, "allow");
  });

  test("create：name / role 必填非空；composition 只认三种；model → modelId；空 surfacePath 当没给", () => {
    assert.throws(() => toCreateInput({ role: "x" }), /"name" is required/);
    assert.throws(() => toCreateInput({ name: "a", role: "  " }), /"role" is required/);
    assert.throws(() => toCreateInput({ name: "a", role: "x", composition: "plasma" }), /composition/);
    assert.throws(() => toCreateInput({ name: "a", role: "x", massEarth: "2" }), /massEarth/);
    assert.deepEqual(toCreateInput({ name: "衡璨", role: "评测", model: "glm-5.3", massEarth: 1.5, composition: "ice", surfacePath: "" }), {
      name: "衡璨",
      role: "评测",
      modelId: "glm-5.3",
      massEarth: 1.5,
      composition: "ice",
    });
  });

  test("update：id 必填；什么都不改报错；model \"\" = 清掉", () => {
    assert.throws(() => toUpdateInput({ name: "a" }), /"id" is required/);
    assert.throws(() => toUpdateInput({ id: "agent-1" }), /Nothing to update/);
    assert.deepEqual(toUpdateInput({ id: "agent-1", model: "" }), { id: "agent-1", modelId: null });
    assert.deepEqual(toUpdateInput({ id: "agent-1", role: "新职能" }), { id: "agent-1", role: "新职能" });
  });

  test("调用时把参数翻成 subAgentRequest；主进程的错误原样成为工具失败；成功的 details 带 id", async () => {
    const ok = harness({ ok: true, text: "created", id: "agent-1" });
    const result = await ok.byName("create_sub_agent").execute("c1", { name: "衡璨", role: "评测" }, noSignal, undefined, undefined as never);
    assert.deepEqual(ok.events[0]?.["request"] satisfies unknown as SubAgentToolRequest, { action: "create", input: { name: "衡璨", role: "评测" } });
    assert.equal(ok.events[0]?.["type"], "subAgentRequest");
    assert.equal(ok.events[0]?.["sessionId"], "S");
    assert.deepEqual(result.details, { subAgentId: "agent-1" });
    const listed = harness({ ok: true, text: "none" });
    await listed.byName("list_sub_agents").execute("c2", {}, noSignal, undefined, undefined as never);
    assert.deepEqual(listed.events[0]?.["request"], { action: "list" });
    const bad = harness({ ok: false, error: "已经有一个叫「衡璨」的子智能体" });
    await assert.rejects(bad.byName("create_sub_agent").execute("c3", { name: "衡璨", role: "评测" }, noSignal, undefined, undefined as never), /已经有一个叫/);
  });

  test("delegate 的 subAgentId：形状不对在 agent 侧就拒；合法的原样带进 delegateRequest", async () => {
    const events: Record<string, unknown>[] = [];
    const broker: RequestBroker = new RequestBroker((event) => {
      const record = event as Record<string, unknown>;
      events.push(record);
      setImmediate(() =>
        broker.resolve(String(record["requestId"]), {
          ok: true,
          childId: "c",
          title: "t",
          card: { childId: "c", title: "t", modelId: "m", thinkingLevel: "medium", workbench: "/wb", subAgentId: "agent-1" },
        }),
      );
    });
    const delegate = createChannelTools(broker, "S", "root").find((tool) => tool.name === "delegate");
    assert.ok(delegate);
    await assert.rejects(delegate.execute("d0", { title: "t", task: "x", subAgentId: "../x" }, noSignal, undefined, undefined as never), /subAgentId/);
    const result = await delegate.execute("d1", { title: "t", task: "x", subAgentId: "agent-1" }, noSignal, undefined, undefined as never);
    assert.equal(events[0]?.["subAgentId"], "agent-1");
    const text = result.content[0];
    assert.ok(text?.type === "text" && text.text.includes("as sub-agent agent-1"));
  });
});

describe("系统提示：职能只在用到时出现", () => {
  const base: SystemPromptInput = {
    piBase: "pi",
    mode: "skip",
    extraToolNames: [],
    role: "child",
    workspace: { name: "意图系统" },
    cwd: "/w",
    directories: { attached: [], workbench: "/wb" },
    gitAttribution: true,
    attributionLanguage: "zh",
    intentGuideline: false,
    memoryToolsGuideline: false,
    longTaskAutomationGuideline: false,
  };

  test("指名派活的子会话：职能整段进提示（紧跟通道角色那段）；普通会话逐字节不变", () => {
    const plain = joinSystemPrompt(orbitaSystemSegments(base));
    const identity = { id: "agent-1", name: "衡璨", role: "你负责没有标准答案的评测。\n不改代码。" };
    const segments = orbitaSystemSegments({ ...base, subAgent: identity });
    const names = segments.map((segment) => segment.name);
    assert.equal(names[names.indexOf("channel-role") + 1], "sub-agent");
    const prompt = joinSystemPrompt(segments);
    assert.ok(prompt.includes(describeSubAgentIdentity(identity)));
    assert.ok(prompt.includes("你负责没有标准答案的评测。\n不改代码。"));
    assert.ok(prompt.includes('"衡璨"'));
    assert.equal(joinSystemPrompt(orbitaSystemSegments({ ...base, subAgentsGuideline: false })), plain);
    assert.ok(!plain.includes("orbita-sub-agent"));
  });

  test("编排形态的主智能体：讲「有子智能体可指名派活、建的时候不替用户选位置」", () => {
    const prompt = joinSystemPrompt(orbitaSystemSegments({ ...base, role: "root", subAgentsGuideline: true }));
    assert.ok(prompt.includes(SUB_AGENTS_MAIN_GUIDELINE));
    assert.match(SUB_AGENTS_MAIN_GUIDELINE, /subAgentId/);
    assert.match(SUB_AGENTS_MAIN_GUIDELINE, /never pick its orbit/);
  });
});
