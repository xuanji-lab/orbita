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
import { assembleTurn, PlanRoundGate, previousTools, runTurn, unwrapHarnessError, type KernelTurnRuntime } from "./kernel-turn.ts";
import { createPlanGate } from "./plan-tools.ts";
import { strictToolContext, toDurableTool } from "./durable-tools.ts";
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
    thinkingLevel: "off",
    piSessionDir: join(cwd, ".pi"),
    attachmentsDir: join(cwd, ".att"),
    protectedPaths: [join(cwd, "sessions")],
    protectedFiles: [],
    skillsDirs: [],
    mcpServers: {},
    ...overrides,
  };
}

function runtime(events: AgentEvent[]): KernelTurnRuntime {
  const send = (event: AgentEvent): void => {
    events.push(event);
  };
  return {
    broker: new RequestBroker((event) => send(event as AgentEvent)),
    mcpHub: new McpHub(),
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

  it("工具清单顺序：此前看到的保持原位、新出现的接末尾；声明变了的挪到末尾（与旧内核同一组 pi-ai 回放函数）", async () => {
    const cwd = await tempDir();
    const { harness, registry, conversation: target } = await conversation();
    const target2 = { registry, conversation: target, model: MODEL, providerSessionId: "p1" };
    const wire = await TurnWire.open(target, join(cwd, ".att"), BACKGROUND_CONTEXT);
    const fresh = await assembleTurn(command(cwd), runtime([]), target2, [], wire, 1);
    // 新会话的全序：内建四件（ENABLED_BUILTIN_TOOLS 的顺序）在前，共用清单接后（黄金名单见 turn-tools.test.ts）
    assert.deepEqual(fresh.toolNames.slice(0, 4), ["bash", "edit", "read", "write"]);
    assert.ok(!fresh.toolNames.some((name) => name === "grep" || name === "find" || name === "ls"));
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
    assert.deepEqual(invalid, { output: [{ type: "text", text: 'Validation failed for tool "t":\n  - x: required' }], isError: true, details: {} });
    const missing = unwrapHarnessError({ name: "ghost" }, { isError: true, diagnostics: [{ severity: "error", code: "tool_unavailable", message: "Tool ghost is not available" }] });
    assert.deepEqual(missing, { output: [{ type: "text", text: "Tool ghost not found" }], isError: true, details: {} });
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

describe("kernel-turn：计划展示后这一轮其余调用被拦（新内核的 plan gate）", () => {
  it("带 confirm 的计划：同一批里 update_plan 之后的 read 不执行，结果是旧内核的那句拦截语；下一轮复位", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "secret\n");
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("update_plan", { items: [{ text: "读文件", status: "in_progress" }], confirm: ["读哪个文件？"] }), fauxToolCall("read", { path: "note.txt" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("这是计划"),
      fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("读完了"),
    ]);
    const { harness, registry, conversation: target } = await conversation();
    const target2 = { registry, conversation: target, model: MODEL, providerSessionId: "p1" };
    await runTurn(command(cwd), runtime([]), target2, COMPACTION);
    const first = new Map((await toolResults(target)).map((result) => [result.toolName, result]));
    assert.match(text(first.get("update_plan") as ToolResultMessage), /Plan updated/);
    assert.match(text(first.get("read") as ToolResultMessage), /^Not run: the plan is shown to the user/);
    // 下一轮：闸门复位，read 照常执行
    await runTurn(command(cwd, { text: "go" }), runtime([]), target2, COMPACTION);
    const reads = (await toolResults(target)).filter((result) => result.toolName === "read");
    assert.match(text(reads.at(-1) as ToolResultMessage), /secret/);
    await harness.close(BACKGROUND_CONTEXT);
  });
});

describe("PlanRoundGate：计划闸门的判定不随钩子先后变", () => {
  const plan = { items: [{ text: "a", status: "in_progress" }], confirm: ["先确认一下？"] };
  const roundWith = (calls: [string, string, Record<string, unknown>][]) => [
    { type: "message", id: "e1", message: { role: "assistant", content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })) } },
  ];
  const gateFor = (state: { stopping: boolean }) =>
    new PlanRoundGate(createPlanGate({ branch: () => [], state }), state);

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

describe("strictToolContext：工具只能读新内核提供的上下文字段", () => {
  it("提供的字段照常读；读没提供的字段当场报错，说清哪个工具、哪个字段", () => {
    const ctx = strictToolContext("bash", {
      cwd: "/w",
      model: undefined,
      thinkingLevel: "off",
      sessionManager: { getSessionId: () => "sid", getSessionFile: () => undefined },
    });
    assert.equal(ctx.cwd, "/w");
    assert.equal(ctx.sessionManager.getSessionId(), "sid");
    assert.equal(ctx.sessionManager.getSessionFile(), undefined);
    // 经 as 绕过类型去读没提供的字段（类型层已经拦了直接读）
    const loose = ctx as unknown as { hasUI: unknown; sessionManager: { getBranch: () => unknown } };
    assert.throws(() => loose.hasUI, /没有提供 hasUI（工具 bash 读了它）/);
    assert.throws(() => loose.sessionManager.getBranch(), /没有提供 sessionManager\.getBranch（工具 bash 读了它）/);
  });
});

describe("kernel-turn：按能力集装配一轮", () => {
  const child = (cwd: string, sessionId: string, capabilities?: string[]): KernelTurnCommand =>
    command(cwd, {
      sessionId,
      directories: { workbench: join(cwd, "wb", sessionId), attached: [], related: [{ sessionId: "parent", relation: "parent", label: "p", path: join(cwd, "wb", "parent") }] },
      ...(capabilities === undefined ? {} : { capabilities }),
    });

  async function assemble(cmd: KernelTurnCommand) {
    const cwd = cmd.cwd;
    const { harness, registry, conversation: target } = await conversation();
    const wire = await TurnWire.open(target, join(cwd, ".att", cmd.sessionId), BACKGROUND_CONTEXT);
    const turn = await assembleTurn(cmd, runtime([]), { registry, conversation: target, model: MODEL, providerSessionId: "p1" }, [], wire, 1);
    await harness.close(BACKGROUND_CONTEXT);
    const declarations = JSON.stringify((turn.extension.tools ?? []).map((tool) => toToolDeclaration(tool)));
    return { turn, declarations };
  }

  it("同一能力集的两件活：发给模型的工具定义逐字节相同；系统提示只差各自工作台那一行（与全带时一样）", async () => {
    const cwd = await tempDir();
    const one = await assemble(child(cwd, "c1", ["pdf-docx", "browser"]));
    const two = await assemble(child(cwd, "c2", ["pdf-docx", "browser"]));
    assert.equal(one.declarations, two.declarations);
    assert.equal(one.turn.systemPrompt.replaceAll("/c1", "/c2"), two.turn.systemPrompt);
    // 同一件活再开一轮：整份前缀逐字节相同
    const again = await assemble(child(cwd, "c1", ["pdf-docx", "browser"]));
    assert.equal(again.declarations, one.declarations);
    assert.equal(again.turn.systemPrompt, one.turn.systemPrompt);
  });

  it("全带 / 只带基础 / 纯聊天：工具与提示段依次变少", async () => {
    const cwd = await tempDir();
    const full = await assemble(child(cwd, "c1"));
    const base = await assemble(child(cwd, "c1", []));
    const chat = await assemble(child(cwd, "c1", ["none"]));
    assert.deepEqual(base.turn.toolNames, ["bash", "edit", "read", "write", "update_plan", "update_goal", "report_to_parent"]);
    assert.deepEqual(chat.turn.toolNames, []);
    assert.ok(full.turn.toolNames.length > 40);
    // 实测（这份夹具，无 MCP、无技能）：工具定义 35,582 → 8,452 → 2 字符
    assert.ok(base.declarations.length * 4 < full.declarations.length);
    // 只带基础：没有 store-tools、quote 两段；通道说明末尾讲带了什么、缺了找谁
    assert.doesNotMatch(base.turn.systemPrompt, /<orbita-store-tools>|<orbita-quotes>/);
    assert.match(full.turn.systemPrompt, /<orbita-store-tools>/);
    assert.match(base.turn.systemPrompt, /you have: nothing else\.\nIf the work really cannot be done without something you do not have, do not report it as failed[\s\S]*kind "question"[\s\S]*do not ask for things for their own sake/);
    // 纯聊天：只有身份与回复语言两段
    assert.match(chat.turn.systemPrompt, /^You are a sub-session inside Orbita[\s\S]*This piece of work is chat only/);
    assert.match(chat.turn.systemPrompt, /\n\nReply language:/);
    assert.doesNotMatch(chat.turn.systemPrompt, /<tools>|<orbita-permission>|<orbita-sub-sessions>/);
    assert.ok(chat.turn.systemPrompt.length * 4 < full.turn.systemPrompt.length);
  });

  it("点名了却没有的技能与 MCP 服务写进通道说明", async () => {
    const cwd = await tempDir();
    const { turn } = await assemble(child(cwd, "c1", ["browser", "mcp:zotero", "skill:lit-intake"]));
    assert.match(turn.systemPrompt, /Asked for but not available here: skill:lit-intake, mcp:zotero\./);
  });

  it("缺模块回执：只带基础的活调了浏览器，结果说清没带、找谁，而不是一句 not found", async () => {
    const cwd = await tempDir();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("browser_navigate", { url: "https://example.com" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    const { harness, registry, conversation: target } = await conversation();
    await runTurn(child(cwd, "c1", []), runtime([]), { registry, conversation: target, model: MODEL, providerSessionId: "p1" }, COMPACTION);
    const result = (await toolResults(target))[0] as ToolResultMessage;
    assert.equal(result.isError, true);
    assert.match(text(result), /^Tool browser_navigate is not available: this piece of work was handed out without the browser module/);
    assert.match(text(result), /report_to_parent \(kind "question"\)/);
    await harness.close(BACKGROUND_CONTEXT);
  });
});
