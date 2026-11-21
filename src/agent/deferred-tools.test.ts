/**
 * 延迟工具与 tool_search：用真实装配（assembleTurn / runTurn）与真实 durable 会话验证——
 * 初始发给模型的与延迟的、搜索后的下一次请求、跨轮重装扩展、压缩、SQLite 文件重开、能力集 / MCP 连接收掉工具。
 * 模型是 faux（脚本化）；MCP 是真的夹具子进程；不碰用户真实的 ~/.pi。
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, type Conversation, type Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelTurnCommand } from "../shared/kernel.ts";
import { assembleTurn, runTurn, type KernelTurnRuntime } from "./kernel-turn.ts";
import { toDurableTool, type DurableToolScope } from "./durable-tools.ts";
import { TurnWire } from "./kernel-wire.ts";
import { McpHub } from "./mcp.ts";
import { RequestBroker } from "./request-broker.ts";
import { notLoadedReceipt, TOOL_SEARCH_DESCRIPTION, TOOL_SEARCH_TOOL_NAME } from "./tool-search.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-deferred-"));
  dirs.push(dir);
  return dir;
}
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
before(async () => {
  const agentDir = join(await tempDir(), "agent");
  await mkdir(agentDir, { recursive: true });
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
});
after(async () => {
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 100_000, maxTokens: 1000 }] });
const models = createModels();
models.setProvider(faux.provider);
const MODEL = faux.getModel() as Model<Api>;
const FIXTURE = fileURLToPath(new URL("./mcp-fixture-server.ts", import.meta.url));
const COMPACTION = { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000, backgroundTokens: 0 };

type Submit = Extract<AgentCommand, { type: "submit" }>;
const ROOT_ALL = { sessionMemory: true, automationTools: true, pluginTools: true } as const;
const DEMO = { demo: { transport: "stdio" as const, command: process.execPath, args: [FIXTURE] } };

function command(cwd: string, overrides: Partial<Submit> = {}): KernelTurnCommand {
  return {
    type: "submit",
    sessionId: "s1",
    text: "go",
    cwd,
    workspaceId: null,
    provider: { id: "faux", api: "faux", baseUrl: "http://127.0.0.1:1", apiKey: "k" } as Submit["provider"],
    modelId: "tiny",
    thinkingLevel: "off",
    piSessionDir: join(cwd, ".pi"),
    attachmentsDir: join(cwd, ".att"),
    protectedPaths: [join(cwd, "sessions")],
    protectedFiles: [],
    skillsDirs: [],
    mcpServers: {},
    // 记忆召回在没有主进程回执的测试里要等超时（约 6 秒）：默认关；要看记忆工具的装配时显式开
    ...ROOT_ALL,
    sessionMemory: false,
    ...overrides,
  };
}

/** 子会话（带父）：能力集只对它有意义，通道工具换成 report_to_parent */
function child(cwd: string, capabilities: string[], overrides: Partial<Submit> = {}): KernelTurnCommand {
  return command(cwd, {
    directories: { workbench: join(cwd, "wb"), attached: [], related: [{ sessionId: "parent", relation: "parent", label: "p", path: join(cwd, "wb-p") }] },
    capabilities,
    ...overrides,
  });
}

function runtime(hub: McpHub): KernelTurnRuntime {
  const send = (_event: AgentEvent): void => undefined;
  return { broker: new RequestBroker((event) => send(event as AgentEvent)), mcpHub: hub, send, resolveShellPath: () => undefined };
}

interface Rig {
  harness: Harness;
  registry: Registry;
  conversation: Conversation;
}

async function rig(storage = new MemoryStorage()): Promise<Rig> {
  const registry = createRegistry();
  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  return { harness, registry, conversation };
}

const names = (messages: readonly Message[]): string[] => getCurrentTools([...messages]).map((tool) => tool.name);

/** 一条脚本：每次被请求时记下「这一次请求发给模型的工具名」，再回给定的那条回答 */
function step(seen: string[][], answer: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
  return (context) => {
    seen.push(names(context.messages));
    return answer();
  };
}

const call = (name: string, args: Record<string, string | number>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function toolResults(target: Conversation): Promise<ToolResultMessage[]> {
  const page = await target.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
  return page.items.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model?.[0] as ToolResultMessage);
}
const text = (result: ToolResultMessage): string => result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");

async function turn(r: Rig, cmd: KernelTurnCommand, hub: McpHub): Promise<void> {
  const outcome = await runTurn(cmd, runtime(hub), { registry: r.registry, conversation: r.conversation, model: MODEL, providerSessionId: "p1" }, COMPACTION);
  assert.deepEqual(outcome, { status: "done" });
}

async function assemble(r: Rig, cmd: KernelTurnCommand, hub: McpHub, previous: Parameters<typeof assembleTurn>[3] = []) {
  const wire = await TurnWire.open(r.conversation, join(cmd.cwd, ".att", cmd.sessionId), BACKGROUND_CONTEXT);
  return assembleTurn(cmd, runtime(hub), { registry: r.registry, conversation: r.conversation, model: MODEL, providerSessionId: "p1" }, previous, wire, 1);
}

const DEFERRED_PATTERN = /^(browser_|request_user_action|slides_|doc_|terminal_|automation_|create_skill$|add_mcp_server$|install_plugin$|preview_plugin$|list_plugins$|show_plugin_board$|mcp__)/;

describe("延迟工具：装配出的常驻与延迟", () => {
  it("根会话全开 + 一台真 MCP：常驻清单没有任何延迟组的工具；延迟的七组都在 deferredNames；tool_search 在常驻里", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const turn = await assemble(r, command(cwd, { mcpServers: DEMO, sessionMemory: true }), hub);
      assert.ok(turn.toolNames.includes(TOOL_SEARCH_TOOL_NAME));
      assert.deepEqual(turn.toolNames.filter((name) => DEFERRED_PATTERN.test(name)), []);
      assert.ok(turn.deferredNames.every((name) => DEFERRED_PATTERN.test(name)), "延迟的只有那七组");
      const groups = new Set(turn.deferredNames.map((name) => (name.startsWith("mcp__") ? "mcp" : name.split("_")[0])));
      assert.deepEqual([...groups].sort(), ["add", "automation", "browser", "create", "doc", "install", "list", "mcp", "preview", "request", "show", "slides", "terminal"].sort());
      assert.ok(turn.deferredNames.includes("mcp__demo__echo"));
      // 核心组一个都没被延迟：内建四件、计划 / 目标、通道、记忆、读任务、PDF / Word、给用户看图
      for (const name of ["bash", "edit", "read", "write", "update_plan", "update_goal", "delegate", "memory_search", "read_task", "read_pdf", "read_docx", "show_image"]) {
        assert.ok(turn.toolNames.includes(name), `${name} 常驻`);
        assert.ok(!turn.deferredNames.includes(name), `${name} 不延迟`);
      }
      // 基础提示的 <tools> 常驻清单只讲常驻工具；延迟的既不列、规矩也不进系统提示（加载那一刻才交给模型）
      assert.match(turn.systemPrompt, /- update_plan: /);
      assert.doesNotMatch(turn.systemPrompt, /- terminal_(open|execute|read|list): /);
      assert.doesNotMatch(turn.systemPrompt, /Before every visible terminal command/);
      assert.doesNotMatch(turn.systemPrompt, /- browser_navigate/);
      // 目录仍列出全部选中的组，延迟的单列并说明先 tool_search
      const catalog = /<capability-catalog>[\s\S]*<\/capability-catalog>/.exec(turn.systemPrompt)?.[0] ?? "";
      assert.match(catalog, /Not loaded yet: before first use, call tool_search/);
      const [ready, later] = catalog.split("Not loaded yet:");
      for (const id of ["plan", "channel", "memory", "tasks", "pdf-docx", "image"]) assert.match(ready ?? "", new RegExp(`^- ${id} \\(`, "m"));
      for (const id of ["mcp", "store", "plugins", "browser", "docs-slides", "terminal", "automation"]) assert.match(later ?? "", new RegExp(`^- ${id} \\(`, "m"));
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("durable 真实解析：装上扩展、写进会话的 agent 后，tools 是常驻、deferred 是延迟的（tool_search 的候选）", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const turn = await assemble(r, command(cwd, { mcpServers: DEMO }), hub);
      r.registry.install(turn.extension);
      await r.conversation.configure({ extensions: [turn.extension] }, BACKGROUND_CONTEXT);
      const agent = await r.conversation.agent(BACKGROUND_CONTEXT);
      assert.deepEqual(agent.tools.map((tool) => tool.name), turn.toolNames);
      assert.deepEqual(agent.deferred.map((tool) => tool.name).sort(), [...turn.deferredNames].sort());
      r.registry.uninstall(turn.extension);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("tool_search 是 replay safe，别的（bash / write / edit / read 与延迟工具）不是；说明是固定的一段", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const turn = await assemble(r, command(cwd), hub);
      const tools = new Map((turn.extension.tools ?? []).map((tool) => [tool.name, tool]));
      assert.equal(tools.get(TOOL_SEARCH_TOOL_NAME)?.replay, "safe");
      assert.equal(tools.get(TOOL_SEARCH_TOOL_NAME)?.description, TOOL_SEARCH_DESCRIPTION);
      for (const name of ["bash", "write", "edit", "read", "browser_navigate", "terminal_execute", "automation_create"]) assert.notEqual(tools.get(name)?.replay, "safe", name);
      assert.ok(tools.get("browser_navigate")?.deferred === true);
      assert.ok(tools.get("bash")?.deferred !== true);
      // 说明只讲目录里标了「未加载」的组，不点名 MCP 之类可能被能力集收掉的东西
      assert.doesNotMatch(TOOL_SEARCH_DESCRIPTION, /MCP|slides|browser/i);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("能力集 ['none']：没有任何工具，也没有 tool_search；[] / 只带 pdf-docx 与 image：没有延迟的组，也不装 tool_search", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const chat = await assemble(r, child(cwd, ["none"]), hub);
      assert.deepEqual(chat.toolNames, []);
      assert.deepEqual(chat.deferredNames, []);
      assert.deepEqual(chat.extension.tools ?? [], []);
      assert.doesNotMatch(chat.systemPrompt, /tool_search|capability-catalog/);
      for (const caps of [[], ["pdf-docx", "image"], ["tasks"]]) {
        const turn = await assemble(r, child(cwd, caps), hub);
        assert.deepEqual(turn.deferredNames, [], JSON.stringify(caps));
        assert.ok(!turn.toolNames.includes(TOOL_SEARCH_TOOL_NAME), JSON.stringify(caps));
        assert.doesNotMatch(turn.systemPrompt, /tool_search|Not loaded yet/, JSON.stringify(caps));
      }
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("schema 字符数：延迟后常驻的工具定义（description + parameters 的 JSON 字符）明显变少，核心组不动", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const turn = await assemble(r, command(cwd), hub);
      const size = (list: readonly string[]): number => {
        const byName = new Map((turn.extension.tools ?? []).map((tool) => [tool.name, tool]));
        return list.reduce((sum, name) => {
          const declaration = toToolDeclaration(byName.get(name) as never);
          return sum + (declaration.description ?? "").length + JSON.stringify(declaration.parameters).length;
        }, 0);
      };
      const before = size([...turn.toolNames.filter((name) => name !== TOOL_SEARCH_TOOL_NAME), ...turn.deferredNames]);
      const after = size(turn.toolNames);
      assert.ok(after * 10 < before * 6, `常驻 ${after} 应当不到全部 ${before} 的 60%`);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("延迟工具：注册与老会话", () => {
  it("toDurableTool：deferred 选项只多一个 deferred 标记，别的字段（含 execute 的行为）不变", () => {
    const definition = {
      name: "demo_tool",
      label: "demo",
      description: "d",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => ({ content: [{ type: "text" as const, text: "x" }], details: {} }),
    };
    const scope = { cwd: "/tmp", autoResizeImages: false, model: () => undefined, thinkingLevel: () => "off", providerSessionId: () => "p" } satisfies DurableToolScope;
    const eager = toDurableTool(definition, scope);
    const later = toDurableTool(definition, scope, { deferred: true });
    assert.equal(eager.deferred, undefined);
    assert.equal(later.deferred, true);
    assert.deepEqual({ ...later, deferred: undefined, execute: undefined }, { ...eager, deferred: undefined, execute: undefined });
  });

  it("此前整组常驻的老会话（上次请求里有浏览器工具）：这一轮浏览器工具不再发、基础提示不列，tool_search 仍找得到它们", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const fresh = await assemble(r, command(cwd), hub);
      const declaration = (name: string) => {
        const tool = fresh.extension.tools?.find((candidate) => candidate.name === name);
        assert.ok(tool !== undefined, name);
        return toToolDeclaration(tool);
      };
      const old = [declaration("read"), declaration("bash"), declaration("browser_navigate"), declaration("terminal_open")];
      const turn = await assemble(r, command(cwd), hub, old);
      assert.deepEqual(turn.toolNames.slice(0, 2), ["read", "bash"], "常驻的保持原位");
      assert.ok(!turn.toolNames.includes("browser_navigate") && !turn.toolNames.includes("terminal_open"));
      assert.ok(!turn.activeNames.includes("browser_navigate"));
      assert.ok(turn.deferredNames.includes("browser_navigate"));
      assert.doesNotMatch(turn.systemPrompt, /- terminal_open: /);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("延迟工具：加载、跨轮、压缩、重开", () => {
  it("搜索 → 同一轮下一次请求就有这个工具并能调用；下一轮（扩展重装）仍在；其余延迟组仍没有", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const seen: string[][] = [];
      faux.setResponses([
        step(seen, () => call(TOOL_SEARCH_TOOL_NAME, { query: "echo" })),
        step(seen, () => call("mcp__demo__echo", { text: "hi" })),
        step(seen, () => fauxAssistantMessage("done")),
      ]);
      await turn(r, command(cwd, { mcpServers: DEMO }), hub);
      const [first, second, third] = seen;
      assert.ok(first !== undefined && second !== undefined && third !== undefined);
      assert.ok(first.includes(TOOL_SEARCH_TOOL_NAME) && !first.includes("mcp__demo__echo"), "搜索前没有");
      assert.ok(second.includes("mcp__demo__echo"), "搜索后的下一次请求就有");
      assert.deepEqual(second.filter((name) => !first.includes(name)), ["mcp__demo__echo"], "只多了被加载的那一个（接在末尾）");
      assert.ok(!second.some((name) => /^(browser_|slides_|terminal_)/.test(name)), "没搜的组仍不发");
      const results = await toolResults(r.conversation);
      assert.match(text(results[0] as ToolResultMessage), /Loaded 1 tool\b[\s\S]*mcp__demo__echo/);
      assert.match(text(results[1] as ToolResultMessage), /echo: hi/);

      // 下一轮：扩展整个重建重装，加载状态在会话文档里，不靠闭包
      const seen2: string[][] = [];
      faux.setResponses([step(seen2, () => fauxAssistantMessage("ok"))]);
      await turn(r, command(cwd, { mcpServers: DEMO }), hub);
      assert.ok(seen2[0]?.includes("mcp__demo__echo"), "跨轮仍在");
      assert.deepEqual(seen2[0]?.filter((name) => !third.includes(name)), [], "清单与上一轮最后一次请求一致，没有多出少");
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("关库重开（真 SQLite 文件）：加载状态还在；新开的库里同名扩展重装后照样发给模型", async () => {
    const cwd = await tempDir();
    const file = join(await tempDir(), "s.sqlite");
    const hub = new McpHub();
    let harness: Harness | undefined;
    try {
      const registry = createRegistry();
      harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, BACKGROUND_CONTEXT);
      const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      const id = created.id;
      faux.setResponses([
        () => call(TOOL_SEARCH_TOOL_NAME, { query: "echo" }),
        () => fauxAssistantMessage("loaded"),
      ]);
      await turn({ harness, registry, conversation: created }, command(cwd, { mcpServers: DEMO }), hub);
      await harness.close(BACKGROUND_CONTEXT);

      const registry2 = createRegistry();
      harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: registry2 }, BACKGROUND_CONTEXT);
      const reopened = await harness.conversation(id, BACKGROUND_CONTEXT);
      assert.ok(reopened !== undefined);
      const seen: string[][] = [];
      faux.setResponses([step(seen, () => fauxAssistantMessage("after reopen"))]);
      await turn({ harness, registry: registry2, conversation: reopened }, command(cwd, { mcpServers: DEMO }), hub);
      assert.ok(seen[0]?.includes("mcp__demo__echo"), "重开后仍发给模型");
      assert.ok(!seen[0]?.some((name) => name.startsWith("browser_")));
    } finally {
      await hub.dispose();
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    }
  });

  it("压缩之后：已加载的工具仍发给模型（modelTools 在会话文档里，不在被压缩掉的转录里）", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      faux.setResponses([
        () => call(TOOL_SEARCH_TOOL_NAME, { query: "echo" }),
        () => fauxAssistantMessage("loaded"),
      ]);
      await turn(r, command(cwd, { mcpServers: DEMO }), hub);
      // 手动压缩：摘要由 faux 回
      await r.conversation.configure({ model: { provider: MODEL.provider, modelId: MODEL.id }, compaction: { ...COMPACTION, keepRecentTokens: 0 } }, BACKGROUND_CONTEXT);
      faux.setResponses([() => fauxAssistantMessage("摘要正文")]);
      await r.conversation.compact(undefined, BACKGROUND_CONTEXT);
      await r.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const context = await r.conversation.context(BACKGROUND_CONTEXT);
      assert.equal(context.head?.kind, "pi.compaction", "真的压缩了");
      const seen: string[][] = [];
      faux.setResponses([step(seen, () => fauxAssistantMessage("after compaction"))]);
      await turn(r, command(cwd, { mcpServers: DEMO }), hub);
      assert.ok(seen[0]?.includes("mcp__demo__echo"), "压缩后仍发给模型");
      assert.ok(seen[0]?.includes(TOOL_SEARCH_TOOL_NAME));
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("加载终端：结果里附上它的规矩（系统提示里没有），同一条规矩只写一次", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      faux.setResponses([() => call(TOOL_SEARCH_TOOL_NAME, { query: "visible terminal run command" }), () => fauxAssistantMessage("ok")]);
      await turn(r, command(cwd), hub);
      const result = text((await toolResults(r.conversation))[0] as ToolResultMessage);
      assert.match(result, /terminal_execute/);
      assert.match(result, /Rules for the tools just loaded:\n- Before every visible terminal command, call terminal_list/);
      assert.equal(result.split("Before every visible terminal command").length - 1, 1);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("没先搜就调延迟工具：回执说清它在、怎么加载，不是 not found；同一批里与 tool_search 一起调也一样", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall(TOOL_SEARCH_TOOL_NAME, { query: "navigate web page" }), fauxToolCall("browser_navigate", { url: "https://example.com" })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage("ok"),
      ]);
      await turn(r, command(cwd), hub);
      const results = await toolResults(r.conversation);
      const byName = new Map(results.map((result) => [result.toolName, result]));
      assert.equal(byName.get("browser_navigate")?.isError, true);
      assert.equal(text(byName.get("browser_navigate") as ToolResultMessage), notLoadedReceipt("browser_navigate"));
      assert.match(text(byName.get("browser_navigate") as ToolResultMessage), /Call tool_search/);
      assert.match(text(byName.get(TOOL_SEARCH_TOOL_NAME) as ToolResultMessage), /browser_navigate/);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("延迟工具：能力集与 MCP 连接收掉的工具", () => {
  it("能力集 ['browser']：搜 slides / 终端 / MCP 一个都搜不到（它们没注册）；搜 browser 能加载，且下一次请求只多出 browser 的工具", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const seen: string[][] = [];
      faux.setResponses([
        step(seen, () => call(TOOL_SEARCH_TOOL_NAME, { query: "slides presentation deck export" })),
        step(seen, () => call(TOOL_SEARCH_TOOL_NAME, { query: "echo mcp" })),
        step(seen, () => call(TOOL_SEARCH_TOOL_NAME, { query: "terminal" })),
        step(seen, () => call(TOOL_SEARCH_TOOL_NAME, { query: "open web page navigate" })),
        step(seen, () => fauxAssistantMessage("done")),
      ]);
      await turn(r, child(cwd, ["browser"], { mcpServers: DEMO }), hub);
      const results = (await toolResults(r.conversation)).map(text);
      assert.deepEqual(results.slice(0, 3), ["No matching tools found.", "No matching tools found.", "No matching tools found."]);
      assert.match(results[3] ?? "", /browser_navigate/);
      const last = seen.at(-1) ?? [];
      assert.ok(last.includes("browser_navigate"));
      assert.ok(!last.some((name) => /^(slides_|doc_|terminal_|mcp__|automation_|install_plugin)/.test(name)));
      assert.deepEqual(seen[0], seen[1], "没搜到就没有变化");
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("能力集 ['browser']：目录只列选中的组，没有 slides / MCP；tool_search 的说明不点名它们", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      const turn = await assemble(r, child(cwd, ["browser"], { mcpServers: DEMO }), hub);
      assert.deepEqual(turn.deferredNames.filter((name) => !name.startsWith("browser_") && name !== "request_user_action"), []);
      const catalog = /<capability-catalog>[\s\S]*<\/capability-catalog>/.exec(turn.systemPrompt)?.[0] ?? "";
      assert.match(catalog, /Not loaded yet[\s\S]*\n- browser \(browser_navigate/);
      assert.doesNotMatch(catalog, /slides|docs-slides|terminal|mcp|automation|plugins|store/);
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it("MCP 断开后不出现：之前加载过的 mcp 工具，这一轮连接收掉就不发给模型、也搜不到；重新连上按 durable 原生语义再发（modelTools 仍记着它）", async () => {
    const cwd = await tempDir();
    const hub = new McpHub();
    const r = await rig();
    try {
      faux.setResponses([() => call(TOOL_SEARCH_TOOL_NAME, { query: "echo" }), () => fauxAssistantMessage("loaded")]);
      await turn(r, command(cwd, { mcpServers: DEMO }), hub);

      // 连接被收掉（配置里没有这台了）：这一轮没有 mcp__demo__*，旧的 modelTools 不能让它复活
      const gone: string[][] = [];
      faux.setResponses([step(gone, () => call(TOOL_SEARCH_TOOL_NAME, { query: "echo" })), step(gone, () => fauxAssistantMessage("no echo"))]);
      await turn(r, command(cwd, { mcpServers: {} }), hub);
      assert.ok(gone.every((list) => !list.some((name) => name.startsWith("mcp__"))), "断开的那一轮任何一次请求都没有 mcp 工具");
      const results = await toolResults(r.conversation);
      assert.equal(text(results.at(-1) as ToolResultMessage), "No matching tools found.");
      const unavailable = await assemble(r, command(cwd, { mcpServers: {} }), hub);
      assert.ok(!unavailable.deferredNames.some((name) => name.startsWith("mcp__")));

      // 重新连上：同名工具重新注册。durable 的 modelTools 是按名字存的（「重连中的 MCP 工具连上后即发」是它写明的语义），所以直接又发给模型
      const back: string[][] = [];
      faux.setResponses([step(back, () => fauxAssistantMessage("back"))]);
      await turn(r, command(cwd, { mcpServers: DEMO }), hub);
      assert.ok(back[0]?.includes("mcp__demo__echo"), "重新连上后按 durable 原生语义再发");
    } finally {
      await hub.dispose();
      await r.harness.close(BACKGROUND_CONTEXT);
    }
  });
});
