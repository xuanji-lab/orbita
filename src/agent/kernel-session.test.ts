import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, ProviderDoc } from "@earendil-works/pi-durable";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelTurnResult } from "../shared/kernel.ts";
import { applyTranscriptProgress, createTranscriptState, selectTranscript } from "../shared/transcript-state.ts";
import type { TranscriptItem } from "../shared/transcript.ts";
import { IntentConfirmWaiter } from "./intent-confirm-wait.ts";
import { KernelPool, SessionHistoryDoc, SessionIndexDoc } from "./kernel.ts";
import { compactionSummary, contextUsage, KernelSessions } from "./kernel-session.ts";
import { PermissionWaiter, type KernelTurnRuntime } from "./kernel-turn.ts";
import { McpHub } from "./mcp.ts";
import { RequestBroker, toolReplyResult } from "./request-broker.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-session-"));
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

type Submit = Extract<AgentCommand, { type: "submit" }>;

function submit(cwd: string, overrides: Partial<Submit> = {}): Submit {
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

interface Rig {
  sessions: KernelSessions;
  events: AgentEvent[];
  settled: { sessionId: string; result: KernelTurnResult }[];
  permissions: PermissionWaiter;
  storages: Map<string, MemoryStorage> | null;
  pool: KernelPool;
  /** 等到某个事件出现（最多 5 秒） */
  until: (match: (event: AgentEvent) => boolean) => Promise<AgentEvent>;
  transcript: (sessionId?: string) => readonly TranscriptItem[];
  /** 工具请求通道（测试替主进程回执） */
  broker: RequestBroker;
}

/** storages = null：用真的 SQLite 文件（崩溃后重开的测试要它：MemoryStorage 随 Harness 一起关掉） */
async function rig(onEvent?: (event: AgentEvent, rig: Rig) => void, storages: Map<string, MemoryStorage> | null = new Map(), libraryDir?: string): Promise<Rig> {
  const dir = libraryDir ?? (await tempDir());
  const events: AgentEvent[] = [];
  const settled: Rig["settled"] = [];
  const waiters: { match: (event: AgentEvent) => boolean; resolve: (event: AgentEvent) => void }[] = [];
  let self: Rig | null = null;
  const send = (event: AgentEvent): void => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.match(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
    if (self !== null) onEvent?.(event, self);
  };
  const permissions = new PermissionWaiter(send);
  const runtime: KernelTurnRuntime = {
    broker: new RequestBroker((event) => {
      send(event as AgentEvent);
      const request = event as { type: string; requestId: string };
      // 记忆召回：空命中（主进程那头没有记忆服务）
      if (request.type === "memoryRecallRequest") queueMicrotask(() => runtime.broker.resolve(request.requestId, { ok: true, hits: [] }));
    }),
    mcpHub: new McpHub(),
    permissions,
    send,
    resolveShellPath: () => undefined,
  };
  const pool = new KernelPool({
    dir,
    models: () => models,
    registerProvider: () => MODEL,
    ...(storages === null
      ? {}
      : {
          openStorage: async (file: string) => {
            let storage = storages.get(file);
            if (storage === undefined) {
              storage = new MemoryStorage();
              storages.set(file, storage);
            }
            return storage;
          },
        }),
  });
  const sessions = new KernelSessions({
    pool,
    runtime,
    intentConfirm: new IntentConfirmWaiter(send),
    settled: (sessionId, result) => settled.push({ sessionId, result }),
    resolveModel: async () => MODEL,
  });
  self = {
    sessions,
    events,
    settled,
    permissions,
    storages,
    pool,
    broker: runtime.broker,
    until: (match) => {
      const found = events.find(match);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for an event")), 5000);
        waiters.push({
          match,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    transcript: (sessionId = "s1") => {
      let state = createTranscriptState({
        id: sessionId,
        cwd: "/",
        createdAt: 0,
        updatedAt: 0,
        phase: "idle",
        model: { provider: "faux", id: "tiny" },
        thinkingLevel: "off",
        attached: true,
        locked: false,
        revision: 0,
        transcript: [],
        queuedSteer: [],
        queuedSteerCount: 0,
      });
      for (const event of events) if (event.type === "progress" && event.sessionId === sessionId) state = applyTranscriptProgress(state, event.progress);
      return selectTranscript(state);
    },
  };
  return self;
}

/** 工具请求的回执（主进程那头）：channelSendRequest 回 ok */
function runtimeReply(r: Rig, requestId: string): void {
  r.broker.resolve(requestId, toolReplyResult({ type: "channelSendResult", requestId, ok: true, messageId: "m1" }));
}

const idle = (sessionId = "s1") => (event: AgentEvent) => event.type === "phase" && event.sessionId === sessionId && event.phase === "idle";
const phases = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => (event.type === "phase" ? [event.phase] : []));

describe("KernelSessions：一轮的事件与旧内核同形", () => {
  it("回显 → phase turn → 流式回答（思考、文字）→ 工具开始 / 结束 → 最终回答 → stats 落盘 → idle，转录归约出与旧内核同样的四条", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "hello\n");
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("想一想"), fauxText("我先读一下"), fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("读到了 hello"),
    ]);
    const r = await rig();
    await r.sessions.handle("s1", submit(cwd, { text: "读 note" }));
    await r.until(idle());
    const items = r.transcript();
    assert.deepEqual(
      items.map((item) => `${item.role}:${"status" in item ? item.status : ""}`),
      ["user:", "assistant:complete", "tool:complete", "assistant:complete"],
    );
    const first = items[1] as Extract<TranscriptItem, { role: "assistant" }>;
    assert.deepEqual(
      first.content.map((block) => block.type),
      ["thinking", "text", "toolCall"],
    );
    assert.match(JSON.stringify(items[2]), /hello/);
    // 相位：turn 在前、idle 收尾，中间没有别的 idle
    assert.deepEqual(phases(r.events), ["turn", "idle"]);
    // 开轮时推了思考档真值、created（新会话记 durable 引用）、落盘的 stats
    assert.ok(r.events.some((event) => event.type === "thinking"));
    assert.ok(r.events.some((event) => event.type === "created" && event.piSessionFile === "durable:s1"));
    const lastStats = [...r.events].reverse().find((event) => event.type === "stats");
    assert.ok(lastStats !== undefined && lastStats.type === "stats" && lastStats.persist === true && lastStats.stats.tokens.total > 0);
    // 用量：两次回答的 usage 加总（faux 每次回答带 usage），与 pi.usage 同一份
    const totals = (lastStats as Extract<AgentEvent, { type: "stats" }>).stats.tokens;
    assert.equal(totals.total, totals.input + totals.output + totals.cacheRead + totals.cacheWrite);
    // 落定先于 idle 报给主进程
    assert.equal(r.settled.length, 1);
    assert.equal(r.settled[0]?.result.ok, true);
  });

  it("bash 的实时输出经 onUpdate 上界面（tool item_updated 带部分输出），终态是完整输出", async () => {
    const cwd = await tempDir();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "echo one; sleep 0.3; echo two" }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const r = await rig();
    await r.sessions.handle("s1", submit(cwd));
    await r.until(idle());
    const updates = r.events.filter((event) => event.type === "progress" && event.progress.type === "item_updated" && event.progress.item.role === "tool");
    assert.ok(updates.length > 0, "流式输出至少一帧");
    const outputs = updates.map((event) => (event.type === "progress" && "item" in event.progress ? JSON.stringify(event.progress.item.content) : ""));
    assert.ok(outputs.some((output) => output.includes("one") && !output.includes("two")), "two 出来之前界面上已经有 one");
    assert.match(JSON.stringify(r.transcript().find((item) => item.role === "tool")), /one[\s\S]*two/);
  });
});

describe("KernelSessions：停止 / 抢跑 / 切档 / 插话", () => {
  it("停止正在跑的 bash：这一轮停下、子进程被杀干净、立刻能再发", async () => {
    const cwd = await tempDir();
    const marker = `orbita-stop-${Date.now()}`;
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: `sleep 30 # ${marker}` }), { stopReason: "toolUse" }), fauxAssistantMessage("again")]);
    const r = await rig();
    void r.sessions.handle("s1", submit(cwd));
    await r.until((event) => event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await r.sessions.handle("s1", { type: "abort", sessionId: "s1" });
    await r.until(idle());
    const tool = r.transcript().find((item) => item.role === "tool");
    assert.match(JSON.stringify(tool), /Operation aborted|aborted/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ps = execFileSync("ps", ["-A", "-ww", "-o", "command="]).toString();
    assert.ok(!ps.includes(marker), "sleep 子进程已被杀");
    // 停完立刻能再发
    const before = r.events.length;
    await r.sessions.handle("s1", submit(cwd, { text: "再来" }));
    await r.until((event) => r.events.indexOf(event) >= before && idle()(event));
    assert.equal(r.transcript().at(-1)?.role, "assistant");
  });

  it("立即发送（interrupt）：旧轮停下但不发 idle，新的一句紧接着跑，历史形状正确", async () => {
    const cwd = await tempDir();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage("新的一句答完")]);
    const r = await rig();
    void r.sessions.handle("s1", submit(cwd, { text: "慢的" }));
    await r.until((event) => event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    void r.sessions.handle("s1", { ...submit(cwd, { text: "立刻这个" }), type: "interrupt" });
    await r.until(idle());
    assert.deepEqual(phases(r.events), ["turn", "turn", "idle"], "中间没有 idle");
    const items = r.transcript();
    assert.deepEqual(
      items.map((item) => item.role),
      ["user", "assistant", "tool", "user", "assistant"],
    );
  });

  it("对话进行中切到「手动审批」档：这一轮的下一个工具调用立刻要审批", async () => {
    const cwd = await tempDir();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      async () => {
        await held;
        return fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("done"),
    ]);
    const r = await rig((event, self) => {
      if (event.type === "permission") self.permissions.answer(event.requestId, { behavior: "allow" } as never);
    });
    void r.sessions.handle("s1", submit(cwd, { mode: "skip" }));
    await r.until((event) => event.type === "phase" && event.phase === "turn");
    await r.sessions.handle("s1", { type: "setMode", sessionId: "s1", mode: "manual" });
    release();
    await r.until(idle());
    assert.ok(r.events.some((event) => event.type === "permission" && event.toolName === "bash"), "切档后的 bash 要了审批");
  });

  it("父→子插话（steer）：放在当前工具轮之后、同一轮里答；与用户排队无关；空闲时插话退回主进程（没有退回通道时回失败语）", async () => {
    const cwd = await tempDir();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.4; echo tool-done" }), { stopReason: "toolUse" }),
      async (context) => {
        await held;
        const texts = JSON.stringify(context.messages);
        return fauxAssistantMessage(texts.includes("STEER: 用 pnpm") ? "收到插话" : "没看到插话");
      },
    ]);
    const r = await rig();
    void r.sessions.handle("s1", submit(cwd));
    await r.until((event) => event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    await r.sessions.handle("s1", { type: "steer", sessionId: "s1", text: "STEER: 用 pnpm", delivery: "steer" });
    release();
    await r.until(idle());
    const items = r.transcript();
    assert.deepEqual(
      items.map((item) => item.role),
      ["user", "assistant", "tool", "user", "assistant"],
      "插话显形在工具结果之后",
    );
    assert.match(JSON.stringify(items.at(-1)), /收到插话/);
    assert.deepEqual(phases(r.events), ["turn", "idle"], "插话没有另开一轮");
    // 空闲时插话：没有退回通道（第三步的形状）回旧内核同一句失败语
    await r.sessions.handle("s1", { type: "steer", sessionId: "s1", text: "late", delivery: "steer" });
    assert.ok(r.events.some((event) => event.type === "failed" && /steer 到达时这一轮已结束/.test(event.message)));
    // 有退回通道：原文退回主进程（由它开一轮），不报失败
    const bounced: string[] = [];
    const withBounce = new KernelSessions({ pool: r.pool, runtime: { broker: new RequestBroker(() => undefined), mcpHub: new McpHub(), permissions: r.permissions, send: () => undefined, resolveShellPath: () => undefined }, intentConfirm: new IntentConfirmWaiter(() => undefined), settled: () => undefined, resolveModel: async () => MODEL, bounceSteer: (sessionId, text, delivery) => bounced.push(`${sessionId}:${delivery}:${text}`) });
    await withBounce.handle("s1", { type: "steer", sessionId: "s1", text: "late", delivery: "followUp" });
    assert.deepEqual(bounced, ["s1:followUp:late"]);
  });
});

describe("KernelSessions：压缩、崩溃后的继续", () => {
  it("手动压缩独占一轮：phase compaction → 界碑 → idle", async () => {
    const cwd = await tempDir();
    faux.setResponses([fauxAssistantMessage("第一轮答"), fauxAssistantMessage("第二轮答"), fauxAssistantMessage("## Goal\n摘要正文")]);
    const r = await rig();
    await r.sessions.handle("s1", submit(cwd, { text: "一" }));
    await r.until(idle());
    await r.sessions.handle("s1", submit(cwd, { text: "二" }));
    await r.until((event) => r.events.filter(idle()).length >= 2 && idle()(event));
    await r.sessions.handle("s1", { ...submit(cwd), type: "compact" } as Extract<AgentCommand, { type: "compact" }>);
    await r.until((event) => r.events.filter(idle()).length >= 3 && idle()(event));
    assert.deepEqual(phases(r.events).slice(-2), ["compaction", "idle"]);
    const record = await r.until((event) => event.type === "compaction");
    assert.ok(record.type === "compaction" && /摘要正文/.test(record.record.summary));
    assert.ok(!r.events.some((event) => event.type === "failed"));
  });

  it("上一个进程跑到一半被杀：重开库时停下它（不自动续跑），continueRun 接着答", async () => {
    const cwd = await tempDir();
    let calls = 0;
    faux.setResponses([
      async () => {
        calls++;
        await new Promise(() => undefined); // 永远不回：模拟进程在模型回答时被杀
        return fauxAssistantMessage("never");
      },
    ]);
    const libraryDir = await tempDir();
    const first = await rig(undefined, null, libraryDir);
    const firstTurn = first.sessions.handle("s1", submit(cwd, { text: "被打断的那句" })).catch(() => undefined);
    await first.until((event) => event.type === "phase" && event.phase === "turn");
    // 第一个进程「没了」：关掉它的库（在途的请求没跑完；durable 重开后 resume 会把它再发一遍——我们不让它发），
    // 同一份存储由新进程重开
    await first.pool.closeAll();
    void firstTurn;
    const answered: string[] = [];
    faux.setResponses([
      (context) => {
        answered.push(JSON.stringify(context.messages.at(-1)).slice(0, 120));
        return fauxAssistantMessage("接着答完");
      },
      (context) => {
        answered.push(JSON.stringify(context.messages.at(-1)).slice(0, 120));
        return fauxAssistantMessage("第二次");
      },
    ]);
    const second = await rig(undefined, null, libraryDir);
    const before = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(answered, [], "重开库之后、用户点继续之前，一次请求都没发");
    await second.sessions.handle("s1", { ...submit(cwd), type: "continueRun" } as never);
    await second.until(idle());
    assert.equal(calls, before, "重开后没有自动把上次那次请求再发一遍");
    assert.match(JSON.stringify(second.transcript()), /接着答完/);
    assert.equal(answered.length, 1, "继续只发了一次请求");
  });
});

describe("contextUsage / compactionSummary", () => {
  const assistant = (tokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
    ({ role: "assistant", content: [], api: "faux", provider: "faux", model: "tiny", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: 1 }) as AssistantMessage;
  it("最后一条有效回答的 usage + 其后消息的估算；压缩后还没有新回答 = 未知", () => {
    const user = { role: "user" as const, content: "abcd".repeat(10), timestamp: 1 };
    const usage = contextUsage([user, assistant(100), user], false, 1000);
    assert.ok(usage !== null && usage.tokens !== null && usage.tokens > 100);
    assert.deepEqual(contextUsage([user], true, 1000), { tokens: null, contextWindow: 1000, percent: null });
    assert.equal(contextUsage([user, assistant(50, "aborted")], false, 0), null);
  });
  it("剥掉 durable 给摘要包的前后缀", () => {
    const text = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n正文\n</summary>";
    assert.equal(compactionSummary({ id: 1, conversationId: 1, kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }] } as never), "正文");
  });
});


describe("KernelSessions：回退 / 撤销 / 分支（旧内核本子编辑的对位）", () => {
  /** 每次请求里各条 user 消息的正文（去掉逐请求注入的用户情境块） */
  const requests: string[][] = [];
  const answer = (text: string) => (context: { messages: readonly { role: string; content: unknown }[] }) => {
    requests.push(
      context.messages
        .filter((message) => message.role === "user")
        .map((message) => (Array.isArray(message.content) ? message.content.map((block: { text?: string }) => block.text ?? "").join("") : String(message.content)).replace(/<user_context>[\s\S]*?<\/user_context>\s*/g, "").trim()),
    );
    return fauxAssistantMessage(text);
  };
  const say = async (r: Rig, cwd: string, text: string, sessionId = "s1", root = sessionId): Promise<void> => {
    const before = r.events.length;
    await r.sessions.handle(root, submit(cwd, { sessionId, text, ...(sessionId === "s1" ? {} : { piSessionFile: `durable:${sessionId}` }) }));
    await r.until((event) => r.events.indexOf(event) >= before && idle(sessionId)(event));
  };
  const edited = (r: Rig, from: number) => r.until((event) => r.events.indexOf(event) >= from && (event.type === "piBookEdited" || event.type === "failed"));

  it("回退到第二句之前：下一个请求只带第一轮 + 新的一句；被回退的轮次留在库里；对账不过拒绝、在跑时拒绝；用量不因回退变少", async () => {
    const cwd = await tempDir();
    requests.length = 0;
    faux.setResponses([answer("答一"), answer("答二"), answer("答三"), answer("答四")]);
    const r = await rig();
    await say(r, cwd, "一");
    await say(r, cwd, "二");
    await say(r, cwd, "三");
    const statsBefore = [...r.events].reverse().find((event) => event.type === "stats" && event.persist === true);
    // 对账不过（我们这本账说前面有三条 user，库里没有）：拒绝，什么都不动
    let from = r.events.length;
    await r.sessions.handle("s1", { type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, roles: ["user", "user", "user"], targetMessageId: "x" });
    const refused = await edited(r, from);
    assert.equal(refused.type, "failed");
    // 回退到「二」之前（前缀 = 第一轮的 user + assistant）
    from = r.events.length;
    await r.sessions.handle("s1", { type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, roles: ["user", "assistant"], targetMessageId: "m2" });
    assert.equal((await edited(r, from)).type, "piBookEdited");
    await say(r, cwd, "四");
    assert.deepEqual(requests.at(-1), ["一", "四"]);
    // 被回退的轮次还在库里：索引指向 fork 出来的新会话，原会话的条目一条没少
    const { harness } = await r.pool.library("s1.sqlite");
    const history = (await harness.snapshot(SessionHistoryDoc, BACKGROUND_CONTEXT))?.sessions["s1"] ?? [];
    assert.equal(history.length, 2);
    assert.equal((await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions["s1"], history[1]);
    const original = await harness.conversation(history[0] as never, BACKGROUND_CONTEXT);
    const kept = (await original?.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT))?.items ?? [];
    assert.ok(kept.some((entry) => JSON.stringify(entry.model ?? []).includes("答三")), "被回退的「三」那轮还在原会话里");
    // provider 会话 id 沿用（旧内核回退不换本子，提示缓存的亲和不断）
    const providerOf = async (id: number | undefined) => (await harness.snapshot(ProviderDoc, id as never, BACKGROUND_CONTEXT))?.sessionId;
    assert.equal(await providerOf(history[1]), await providerOf(history[0]));
    // 用量：旧内核数整本本子（含废枝），回退之后不变少
    const statsAfter = [...r.events].reverse().find((event) => event.type === "stats" && event.persist === true);
    assert.ok(statsBefore?.type === "stats" && statsAfter?.type === "stats" && statsAfter.stats.tokens.total > statsBefore.stats.tokens.total);
    // 在跑时拒绝（旧内核同一句话）
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage("停了")]);
    void r.sessions.handle("s1", submit(cwd, { text: "慢" }));
    await r.until((event) => event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    from = r.events.length;
    await r.sessions.handle("s1", { type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, roles: [], targetMessageId: "m1" });
    const running = await edited(r, from);
    assert.ok(running.type === "failed" && /still running/.test(running.message));
    from = r.events.length;
    await r.sessions.handle("s1", { type: "abort", sessionId: "s1" });
    await r.until((event) => r.events.indexOf(event) >= from && idle()(event));
  });

  it("回退到第一句之前（roles 为空，旧内核 resetLeaf）：下一个请求只有新的一句；连续回退两次照样对得上", async () => {
    const cwd = await tempDir();
    requests.length = 0;
    faux.setResponses([answer("答一"), answer("答二"), answer("答三"), answer("答四")]);
    const r = await rig();
    await say(r, cwd, "一");
    await say(r, cwd, "二");
    let from = r.events.length;
    await r.sessions.handle("s1", { type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, roles: ["user", "assistant"], targetMessageId: "m2" });
    assert.equal((await edited(r, from)).type, "piBookEdited");
    from = r.events.length;
    await r.sessions.handle("s1", { type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, roles: [], targetMessageId: "m1" });
    assert.equal((await edited(r, from)).type, "piBookEdited");
    await say(r, cwd, "三");
    assert.deepEqual(requests.at(-1), ["三"]);
    await say(r, cwd, "四");
    assert.deepEqual(requests.at(-1), ["三", "四"]);
  });

  it("停在工具中途的轮之后回退：对账按转录算出的角色对得上（停下的调用、被停的工具结果都算在那一轮里）", async () => {
    const cwd = await tempDir();
    requests.length = 0;
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), answer("答继续"), answer("答新的")]);
    const r = await rig();
    void r.sessions.handle("s1", submit(cwd, { text: "慢的" }));
    await r.until((event) => event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    let from = r.events.length;
    await r.sessions.handle("s1", { type: "abort", sessionId: "s1" });
    await r.until((event) => r.events.indexOf(event) >= from && idle()(event));
    await say(r, cwd, "继续");
    // 主进程 branchRoles 的同一个口径：user / assistant，跳过空 error 回答
    const items = r.transcript();
    const at = items.findIndex((item) => item.role === "user" && JSON.stringify(item).includes("继续"));
    const roles = items
      .slice(0, at)
      .filter((item) => item.role === "user" || (item.role === "assistant" && !(item.status === "error" && item.content.length === 0)))
      .map((item) => (item.role === "user" ? "user" : "assistant"));
    from = r.events.length;
    await r.sessions.handle("s1", { type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, roles, targetMessageId: "m" });
    const reply = await edited(r, from);
    assert.equal(reply.type, "piBookEdited", reply.type === "failed" ? reply.message : "");
    await say(r, cwd, "新的");
    assert.deepEqual(requests.at(-1)?.at(-1), "新的");
    assert.ok(!(requests.at(-1) ?? []).includes("继续"));
  });

  it("撤销 / 挪工作区的告知进下一个请求的上下文（排在最后一轮之后）", async () => {
    const cwd = await tempDir();
    requests.length = 0;
    faux.setResponses([answer("答一"), answer("答二")]);
    const r = await rig();
    await say(r, cwd, "一");
    const from = r.events.length;
    await r.sessions.handle("s1", { type: "undoPiBook", sessionId: "s1", sourcePiSessionFile: "durable:s1", cwd, notice: "The user undid the agent's changes to the following files" });
    assert.equal((await edited(r, from)).type, "piBookEdited");
    await say(r, cwd, "二");
    const last = requests.at(-1) ?? [];
    assert.equal(last[0], "一");
    assert.match(last[1] ?? "", /The user undid the agent's changes/);
    assert.equal(last[2], "二");
  });

  it("分支：源会话「答一」为止的历史复制进新树的库；新会话第一轮带着前缀，源会话不受影响", async () => {
    const cwd = await tempDir();
    requests.length = 0;
    faux.setResponses([answer("答一"), answer("答二"), answer("分支答"), answer("源答")]);
    const r = await rig();
    await say(r, cwd, "一");
    await say(r, cwd, "二");
    const from = r.events.length;
    await r.sessions.handle("b1", { type: "branch", sessionId: "b1", sourcePiSessionFile: "durable:s1", cwd, roles: ["user", "assistant"], sourceSessionId: "s1", sourceRoot: "s1" });
    const created = await r.until((event) => r.events.indexOf(event) >= from && (event.type === "created" || event.type === "failed"));
    assert.ok(created.type === "created" && created.piSessionFile === "durable:b1");
    // 分出来的是新树：它自己的库里有它，源库里没有
    const branched = await r.pool.library("b1.sqlite");
    assert.notEqual((await branched.harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions["b1"], undefined);
    const source = await r.pool.library("s1.sqlite");
    assert.equal((await source.harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions["b1"], undefined);
    await say(r, cwd, "分支里", "b1");
    assert.deepEqual(requests.at(-1), ["一", "分支里"]);
    await say(r, cwd, "源里");
    assert.deepEqual(requests.at(-1), ["一", "二", "源里"]);
    // 锚点不是回答：拒绝（旧内核 planBranchCut 同一句话）
    const before = r.events.length;
    await r.sessions.handle("b2", { type: "branch", sessionId: "b2", sourcePiSessionFile: "durable:s1", cwd, roles: ["user"], sourceSessionId: "s1", sourceRoot: "s1" });
    const bad = await r.until((event) => r.events.indexOf(event) >= before && (event.type === "created" || event.type === "failed"));
    assert.ok(bad.type === "failed" && /agent reply/.test(bad.message));
  });
});

describe("KernelSessions：删除（删树根 = 删库；删树里的一条 = 摘掉 + 关库时清行）", () => {
  it("删树里的一条（在跑也行）：先停它的轮；关库后它的行与原文从库文件里消失，同库的父会话照常能聊，库完整", async () => {
    const cwd = await tempDir();
    const libraryDir = await tempDir();
    faux.setResponses([fauxAssistantMessage("父答-PARENT-MARK"), fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage("又答")]);
    const r = await rig(undefined, null, libraryDir);
    await r.sessions.handle("p1", submit(cwd, { sessionId: "p1", text: "父说" }));
    await r.until(idle("p1"));
    // 子会话与父同库（root = p1），正跑着一个慢 bash
    void r.sessions.handle("p1", submit(cwd, { sessionId: "c1", text: "子说-CHILD-MARK" }));
    await r.until((event) => event.type === "progress" && event.sessionId === "c1" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    await r.sessions.handle("p1", { type: "forget", sessionId: "c1" });
    assert.equal(r.sessions.isRunning("c1"), false, "删之前先停了它的轮");
    const file = join(libraryDir, "p1.sqlite");
    assert.match(await readFile(`${file}.purge.json`, "utf8"), /\d/);
    const onDisk = async (mark: string): Promise<boolean> =>
      (await readFile(file)).includes(Buffer.from(mark)) || (await readFile(`${file}-wal`).catch(() => Buffer.alloc(0))).includes(Buffer.from(mark));
    assert.ok(await onDisk("CHILD-MARK"), "摘掉之后、关库之前：行还在（墓碑等关库）");
    await r.pool.closeAll();
    // 关库时按墓碑清行：墓碑没了、原文不在文件里、库完整
    await assert.rejects(readFile(`${file}.purge.json`, "utf8"));
    assert.ok(!(await onDisk("CHILD-MARK")), "子会话的原文不在库文件里（含 WAL）");
    assert.ok(await onDisk("PARENT-MARK"), "父会话的还在");
    const db = new DatabaseSync(file);
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    db.close();
    // 父会话照常能聊（同一个库重新打开）
    const before = r.events.length;
    await r.sessions.handle("p1", submit(cwd, { sessionId: "p1", text: "父又说", piSessionFile: "durable:p1" }));
    await r.until((event) => r.events.indexOf(event) >= before && idle("p1")(event));
    assert.match(JSON.stringify(r.transcript("p1")), /又答/);
    const { harness } = await r.pool.library("p1.sqlite");
    assert.equal((await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions["c1"], undefined);
  });

  it("删树根：先停库里所有在跑的轮（父与子），再关库删文件（库、-wal、-shm、墓碑都不在）", async () => {
    const cwd = await tempDir();
    const libraryDir = await tempDir();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" })]);
    const r = await rig(undefined, null, libraryDir);
    void r.sessions.handle("p1", submit(cwd, { sessionId: "p1", text: "父" }));
    void r.sessions.handle("p1", submit(cwd, { sessionId: "c1", text: "子" }));
    await r.until((event) => event.type === "progress" && event.sessionId === "p1" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    await r.until((event) => event.type === "progress" && event.sessionId === "c1" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    await r.sessions.closeLibrary("p1.sqlite");
    assert.equal(r.sessions.busy(), false);
    await r.pool.drop("p1.sqlite");
    for (const suffix of ["", "-wal", "-shm", ".purge.json"]) await assert.rejects(readFile(join(libraryDir, `p1.sqlite${suffix}`)));
  });
});

describe("KernelSessions：子会话与父同库", () => {
  it("父与子在同一个库里并行跑、事件不串台；停父不影响子（旧内核同一条规矩）", async () => {
    const cwd = await tempDir();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.5; echo child-done" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("子答完-CHILD"),
    ]);
    const r = await rig();
    void r.sessions.handle("p1", submit(cwd, { sessionId: "p1", text: "父" }));
    await r.until((event) => event.type === "progress" && event.sessionId === "p1" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    void r.sessions.handle("p1", submit(cwd, { sessionId: "c1", text: "子", directories: { attached: [], workbench: join(cwd, "wb-c1"), related: [{ sessionId: "p1", relation: "parent", label: "父会话", path: join(cwd, "wb-p1") }] } }));
    await r.until((event) => event.type === "progress" && event.sessionId === "c1" && event.progress.type === "item_started" && event.progress.item.role === "tool");
    await r.sessions.handle("p1", { type: "abort", sessionId: "p1" });
    await r.until(idle("p1"));
    assert.equal(r.sessions.isRunning("c1"), true, "停父不停子");
    await r.until(idle("c1"));
    assert.match(JSON.stringify(r.transcript("c1")), /子答完-CHILD/);
    assert.doesNotMatch(JSON.stringify(r.transcript("p1")), /CHILD/);
    // 同一个库：两条会话都在 p1 的索引里
    const { harness } = await r.pool.library("p1.sqlite");
    const index = (await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions ?? {};
    assert.ok(index["p1"] !== undefined && index["c1"] !== undefined && index["p1"] !== index["c1"]);
  });

  it("三个子会话并行（一个等父回话、一个模型报错、一个正常答完）：互不串台，报错只挂在它自己那条上，回报的信封是它自己的", async () => {
    const cwd = await tempDir();
    const childDirs = (id: string) => ({ attached: [], workbench: join(cwd, `wb-${id}`), related: [{ sessionId: "p1", relation: "parent" as const, label: "父会话", path: join(cwd, "wb-p1") }] });
    const lastText = (context: { messages: readonly { role: string; content: unknown }[] }): string => JSON.stringify(context.messages.at(-1)?.content ?? "");
    // 回答按最后一条消息定（三条会话的请求交错到达，按序排会错位）
    const respond = (context: { messages: readonly { role: string; content: unknown }[] }) => {
      const last = lastText(context);
      if (last.includes("子一")) return fauxAssistantMessage("子一答完-ONE");
      if (last.includes("子二")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom-TWO" });
      if (last.includes("子三")) return fauxAssistantMessage(fauxToolCall("report_to_parent", { kind: "question", text: "要用哪个数据集？THREE" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("子三问完-THREE");
    };
    faux.setResponses(Array.from({ length: 30 }, () => respond));
    const r = await rig((event, self) => {
      // 子三的回报：主进程那头记账后回执（这里直接回 ok）
      if (event.type === "channelSendRequest") setTimeout(() => runtimeReply(self, event.requestId), 300);
    });
    await Promise.all(
      [
        ["c1", "子一：说一句"],
        ["c2", "子二：说一句"],
        ["c3", "子三：先问父会话"],
      ].map(([id, text]) => r.sessions.handle("p1", submit(cwd, { sessionId: id as string, text: text as string, directories: childDirs(id as string) }))),
    );
    await Promise.all(["c1", "c2", "c3"].map((id) => r.until(idle(id))));
    const blob = (id: string) => JSON.stringify(r.transcript(id));
    assert.match(blob("c1"), /ONE/);
    assert.doesNotMatch(blob("c1"), /TWO|THREE/);
    assert.doesNotMatch(blob("c2"), /ONE|THREE/);
    assert.match(blob("c3"), /THREE/);
    assert.doesNotMatch(blob("c3"), /ONE|TWO/);
    const failed = r.events.filter((event) => event.type === "failed");
    assert.ok(failed.length > 0 && failed.every((event) => event.type === "failed" && event.sessionId === "c2"), JSON.stringify(failed));
    const sent = r.events.filter((event) => event.type === "channelSendRequest");
    assert.equal(sent.length, 1);
    assert.ok(sent[0]?.type === "channelSendRequest" && sent[0].sessionId === "c3" && sent[0].kind === "question" && /THREE/.test(sent[0].text));
  });
});

