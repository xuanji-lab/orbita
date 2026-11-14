import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Message, Model, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelTurnCommand } from "../shared/kernel.ts";
import { assembleTurn, PermissionWaiter, PlanRoundGate, previousTools, runTurn, unwrapHarnessError, type KernelTurnRuntime } from "./kernel-turn.ts";
import { createPlanGate } from "./plan-tools.ts";
import { toDurableTool } from "./durable-tools.ts";
import { deflateSync } from "node:zlib";
import { TurnWire } from "./kernel-wire.ts";
import { McpHub } from "./mcp.ts";
import { RequestBroker } from "./request-broker.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-turn-"));
  dirs.push(dir);
  return dir;
}
// 不读用户真实的 ~/.pi（pi 的设置、AGENTS.md、技能）：指向一个空的配置目录
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

type Submit = Extract<AgentCommand, { type: "submit" }>;

function command(cwd: string, overrides: Partial<Submit> = {}): KernelTurnCommand {
  return {
    type: "submit",
    sessionId: "s1",
    text: "go",
    cwd,
    workspaceId: null,
    provider: { id: "faux", api: "faux", baseUrl: "http://127.0.0.1:1", apiKey: "k" } as Submit["provider"],
    modelId: "tiny",
    mode: "skip",
    thinkingLevel: "off",
    piSessionDir: join(cwd, ".pi"),
    attachmentsDir: join(cwd, ".att"),
    protectedPaths: [join(cwd, "sessions")],
    skillsDirs: [],
    mcpServers: {},
    ...overrides,
  };
}

function runtime(events: AgentEvent[], onEvent?: (event: AgentEvent, waiter: PermissionWaiter) => void): KernelTurnRuntime {
  const send = (event: AgentEvent): void => {
    events.push(event);
    onEvent?.(event, permissions);
  };
  const permissions = new PermissionWaiter(send);
  return {
    broker: new RequestBroker((event) => send(event as AgentEvent)),
    mcpHub: new McpHub(),
    permissions,
    send,
    resolveShellPath: () => undefined,
  };
}

async function conversation(): Promise<{ harness: Harness; registry: ReturnType<typeof createRegistry>; conversation: Conversation }> {
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  return { harness, registry, conversation: created };
}

async function toolResults(target: Conversation): Promise<ToolResultMessage[]> {
  const page = await target.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
  return page.items.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model?.[0] as ToolResultMessage);
}

function text(result: ToolResultMessage): string {
  return result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
}

const COMPACTION = { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000, backgroundTokens: 0 };

describe("kernel-turn：新内核跑一轮带工具的对话", () => {
  it("read / bash / write 三件内建工具真的执行，结果原样回给模型", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "hello from note\n");
    const steps: FauxResponseStep[] = [
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" }), fauxToolCall("bash", { command: "echo from-bash" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "written" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ];
    faux.setResponses(steps);
    const { harness, registry, conversation: target } = await conversation();
    const outcome = await runTurn(command(cwd), runtime([]), { registry, conversation: target, model: MODEL, providerSessionId: "p1" }, COMPACTION);
    assert.deepEqual(outcome, { status: "done" });
    // 库里按完成顺序存（并行的 read 与 bash 谁先完不定），按工具名取
    const results = new Map((await toolResults(target)).map((result) => [result.toolName, result]));
    assert.equal(results.size, 3);
    assert.match(text(results.get("read") as ToolResultMessage), /hello from note/);
    assert.match(text(results.get("bash") as ToolResultMessage), /from-bash/);
    assert.match(text(results.get("write") as ToolResultMessage), /Successfully wrote/);
    assert.equal(await readFile(join(cwd, "out.txt"), "utf8"), "written");
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("受保护目录：同一个闸门函数拦下，拒绝语是旧内核那样的一段原文（不带 <harness> 包装）", async () => {
    const cwd = await tempDir();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "sessions/x.json", content: "{}" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    const { harness, registry, conversation: target } = await conversation();
    await runTurn(command(cwd), runtime([]), { registry, conversation: target, model: MODEL, providerSessionId: "p1" }, COMPACTION);
    const blocked = (await toolResults(target))[0] as ToolResultMessage;
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /^Session records are immutable: ".*sessions" is protected/);
    assert.doesNotMatch(text(blocked), /harness|Tool call blocked/);
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("询问档：批准放行、拒绝回拒绝语、等待中停止能在 1 秒内收尾", async () => {
    const cwd = await tempDir();
    const { harness, registry, conversation: target } = await conversation();
    const target2 = { registry, conversation: target, model: MODEL, providerSessionId: "p1" };

    faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "A" }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const approve = runtime([], (event, waiter) => {
      if (event.type === "permission") waiter.answer(event.requestId, { behavior: "allow" });
    });
    await runTurn(command(cwd, { mode: "manual" }), approve, target2, COMPACTION);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "A");

    faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "b.txt", content: "B" }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const deny = runtime([], (event, waiter) => {
      if (event.type === "permission") waiter.answer(event.requestId, { behavior: "deny", message: "nope from user" });
    });
    await runTurn(command(cwd, { mode: "manual" }), deny, target2, COMPACTION);
    const denied = (await toolResults(target)).at(-1);
    assert.equal(denied === undefined ? "" : text(denied), "nope from user");

    faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "c.txt", content: "C" }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const events: AgentEvent[] = [];
    const hang = runtime(events);
    const running = runTurn(command(cwd, { mode: "manual" }), hang, target2, COMPACTION);
    while (!events.some((event) => event.type === "permission")) await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await target.abort(BACKGROUND_CONTEXT);
    const settled = await running;
    assert.ok(Date.now() - started < 1000, "停止没有被挂着的审批卡住");
    assert.equal(settled.status, "unanswered");
    assert.equal(hang.permissions.size, 0, "等待表里没有残留");
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("工具清单顺序：此前看到的保持原位、新出现的接末尾；声明变了的挪到末尾（与旧内核同一组 pi-ai 回放函数）", async () => {
    const cwd = await tempDir();
    const { harness, registry, conversation: target } = await conversation();
    const target2 = { registry, conversation: target, model: MODEL, providerSessionId: "p1" };
    const wire = await TurnWire.open(target, join(cwd, ".att"), BACKGROUND_CONTEXT);
    const fresh = await assembleTurn(command(cwd), runtime([]), target2, [], wire, 1);
    // 新会话的全序：内建七件（ENABLED_BUILTIN_TOOLS 的顺序，与旧内核 defaultTools 同一份）在前，共用清单接后（黄金名单见 turn-tools.test.ts）
    assert.deepEqual(fresh.toolNames.slice(0, 7), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    assert.deepEqual(fresh.toolNames, fresh.activeNames);
    const declaration = (name: string): Tool => {
      const tool = fresh.extension.tools?.find((candidate) => candidate.name === name);
      assert.ok(tool !== undefined);
      return toToolDeclaration(tool);
    };
    const kept = await assembleTurn(command(cwd), runtime([]), target2, [declaration("write"), declaration("read")], wire, 1);
    assert.deepEqual(kept.toolNames.slice(0, 2), ["write", "read"]);
    assert.deepEqual(kept.activeNames.slice(0, 2), ["write", "read"]);
    assert.ok(kept.toolNames.indexOf("bash") > 1);
    assert.match(kept.systemPrompt, /<orbita-permission>/);
    // write 的声明此前不一样（描述改过）：发给模型时先删后加，挪到末尾；激活顺序（基础提示里的工具小节）仍按名字保持原位
    const all = fresh.toolNames.map((name) => (name === "write" ? { ...declaration("write"), description: "old text" } : declaration(name)));
    const changed = await assembleTurn(command(cwd), runtime([]), target2, all, wire, 1);
    assert.equal(changed.toolNames.at(-1), "write");
    assert.deepEqual(changed.toolNames.slice(0, -1), fresh.toolNames.filter((name) => name !== "write"));
    assert.deepEqual(changed.activeNames, fresh.activeNames);
    await harness.close(BACKGROUND_CONTEXT);
  });
});

describe("kernel-turn：工具结果与旧内核同形", () => {
  it("参数校验失败、调了没提供的工具：结果是旧内核那样的一段原文，不带 <harness> 包装", () => {
    const invalid = unwrapHarnessError({ name: "t" }, { isError: true, diagnostics: [{ severity: "error", code: "invalid_arguments", message: 'Validation failed for tool "t":\n  - x: required' }] });
    assert.deepEqual(invalid, { output: [{ type: "text", text: 'Validation failed for tool "t":\n  - x: required' }], isError: true });
    const missing = unwrapHarnessError({ name: "ghost" }, { isError: true, diagnostics: [{ severity: "error", code: "tool_unavailable", message: "Tool ghost is not available" }] });
    assert.deepEqual(missing, { output: [{ type: "text", text: "Tool ghost not found" }], isError: true });
    assert.equal(unwrapHarnessError({ name: "t" }, { output: [{ type: "text", text: "ok" }] }), undefined);
  });

  it("工具结果里的大图过 pi 同一道归一化：缩放并附坐标换算提示", async () => {
    // 一张 3000×10 的 PNG（全白），超过 pi 的默认图片上限（长边 2000）
    const png = await sharpLessPng(3000, 10);
    const tool = toDurableTool(
      {
        name: "pic",
        label: "pic",
        description: "returns a picture",
        parameters: { type: "object", properties: {} } as never,
        execute: async () => ({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: undefined }),
      },
      { cwd: "/", autoResizeImages: true, model: () => MODEL, thinkingLevel: () => "off", providerSessionId: () => "p" },
    );
    const result = await tool.execute({}, { callId: "c1" } as never, BACKGROUND_CONTEXT);
    const output = result.output ?? [];
    assert.equal(output[0]?.type, "image");
    assert.notEqual((output[0] as { data: string }).data, png, "图被缩放了");
    assert.match((output[1] as { text?: string } | undefined)?.text ?? "", /Multiply coordinates/);
  });
});

/** 不依赖图像库造一张全白 RGB PNG（宽 × 高） */
async function sharpLessPng(width: number, height: number): Promise<string> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

describe("kernel-turn：等审批时不挡别的会话", () => {
  it("会话 A 卡在询问档的审批上，同库的会话 B 照常跑完一整轮；之后批准 A，A 也跑完", async () => {
    const cwd = await tempDir();
    const registry = createRegistry();
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    const a = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const b = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    // 假模型按请求里的最后一句话回答：A 要写文件（要审批），B 直接答
    faux.setResponses(
      Array.from({ length: 6 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
        const last = JSON.stringify(context.messages.at(-1)?.content ?? "");
        if (last.includes("write-for-a")) return fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "A" }), { stopReason: "toolUse" });
        return fauxAssistantMessage("answered");
      }),
    );
    const events: AgentEvent[] = [];
    const shared = runtime(events);
    const turnA = runTurn(command(cwd, { sessionId: "sa", mode: "manual", text: "write-for-a" }), shared, { registry, conversation: a, model: MODEL, providerSessionId: "pa" }, COMPACTION);
    while (!events.some((event) => event.type === "permission")) await new Promise((resolve) => setTimeout(resolve, 10));
    const turnB = await runTurn(command(cwd, { sessionId: "sb", text: "just answer" }), shared, { registry, conversation: b, model: MODEL, providerSessionId: "pb" }, COMPACTION);
    assert.deepEqual(turnB, { status: "done" }, "A 等审批时 B 跑完了");
    const ask = events.find((event) => event.type === "permission");
    assert.ok(ask?.type === "permission");
    shared.permissions.answer(ask.requestId, { behavior: "allow" });
    assert.deepEqual(await turnA, { status: "done" });
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "A");
    await harness.close(BACKGROUND_CONTEXT);
  });
});

describe("kernel-turn：计划展示后这一轮其余调用被拦（新内核的 plan gate）", () => {
  it("「先给我看计划」：同一批里 update_plan 之后的 read 不执行，结果是旧内核的那句拦截语；下一轮复位", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "secret\n");
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("update_plan", { items: [{ text: "读文件", status: "in_progress" }] }), fauxToolCall("read", { path: "note.txt" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("这是计划"),
      fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("读完了"),
    ]);
    const { harness, registry, conversation: target } = await conversation();
    const target2 = { registry, conversation: target, model: MODEL, providerSessionId: "p1" };
    await runTurn(command(cwd, { planFirst: true }), runtime([]), target2, COMPACTION);
    const first = new Map((await toolResults(target)).map((result) => [result.toolName, result]));
    assert.match(text(first.get("update_plan") as ToolResultMessage), /Plan updated/);
    assert.match(text(first.get("read") as ToolResultMessage), /^Not run: the plan is shown to the user/);
    // 下一轮：计划已在（不再是新计划），read 照常执行
    await runTurn(command(cwd, { planFirst: true, text: "go" }), runtime([]), target2, COMPACTION);
    const reads = (await toolResults(target)).filter((result) => result.toolName === "read");
    assert.match(text(reads.at(-1) as ToolResultMessage), /secret/);
    await harness.close(BACKGROUND_CONTEXT);
  });
});

describe("PlanRoundGate：计划闸门的判定不随钩子先后变", () => {
  const plan = { items: [{ text: "a", status: "in_progress" }] };
  const roundWith = (calls: [string, string, Record<string, unknown>][]) => [
    { type: "message", id: "e1", message: { role: "assistant", content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })) } },
  ];
  const gateFor = (state: { stopping: boolean }) =>
    new PlanRoundGate(createPlanGate({ getMode: () => "skip", planFirst: true, branch: () => [], state }), state);

  it("update_plan 在前：后面的调用被拦，不管谁的钩子先跑", () => {
    const branch = roundWith([["c1", "update_plan", plan], ["c2", "read", { path: "x" }]]);
    const state = { stopping: false };
    const gate = gateFor(state);
    // 故意先判 read、后判 update_plan（durable 并发跑一批时可能发生）
    assert.match(gate.check({ toolCallId: "c2", toolName: "read", input: { path: "x" } }, branch)?.reason ?? "", /^Not run/);
    assert.equal(gate.check({ toolCallId: "c1", toolName: "update_plan", input: plan }, branch), null);
  });

  it("update_plan 在后：排在它前面的调用不受影响；下一批全部被拦", () => {
    const branch = roundWith([["c1", "read", { path: "x" }], ["c2", "update_plan", plan]]);
    const state = { stopping: false };
    const gate = gateFor(state);
    assert.equal(gate.check({ toolCallId: "c2", toolName: "update_plan", input: plan }, branch), null);
    assert.equal(gate.check({ toolCallId: "c1", toolName: "read", input: { path: "x" } }, branch), null);
    const next = [...branch, { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "ls" } }] } }];
    assert.match(gate.check({ toolCallId: "c3", toolName: "bash", input: { command: "ls" } }, next)?.reason ?? "", /^Not run/);
  });
});

describe("previousTools：模型此前看到的工具声明从哪来", () => {
  const decl = (name: string): Tool => ({ name, description: name, parameters: { type: "object", properties: {} } }) as Tool;
  it("刚迁来、新内核还没发过请求：用迁移时从旧本子带来的那份", () => {
    assert.deepEqual(previousTools([], { legacyTools: [decl("read"), decl("terminal_open")] }).map((tool) => tool.name), ["read", "terminal_open"]);
  });
  it("新内核自己发过请求后：用会话自己的 pi.system 回放，不再看迁移带来的", () => {
    const own = [{ role: "system", content: "", toolsAdded: [decl("bash")], timestamp: 1 }] as Message[];
    assert.deepEqual(previousTools(own, { legacyTools: [decl("read")] }).map((tool) => tool.name), ["bash"]);
  });
});
