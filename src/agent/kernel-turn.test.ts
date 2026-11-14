import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelTurnCommand } from "../shared/kernel.ts";
import { assembleTurn, PermissionWaiter, runTurn, type KernelTurnRuntime } from "./kernel-turn.ts";
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

  it("工具清单顺序：已在的保持原位，新出现的接在后面", async () => {
    const cwd = await tempDir();
    const { harness, registry, conversation: target } = await conversation();
    const assembled = await assembleTurn(
      command(cwd),
      runtime([]),
      { registry, conversation: target, model: MODEL, providerSessionId: "p1" },
      ["write", "read"],
      await TurnWire.open(target, join(cwd, ".att"), BACKGROUND_CONTEXT),
      1,
    );
    assert.deepEqual(assembled.toolNames.slice(0, 2), ["write", "read"]);
    assert.ok(assembled.toolNames.includes("bash") && assembled.toolNames.indexOf("bash") > 1);
    assert.match(assembled.systemPrompt, /<orbita-permission>/);
    await harness.close(BACKGROUND_CONTEXT);
  });
});
