/**
 * AgentHostCore 的回归网。两个子进程都换成脚本化的假货：命令记进 `posted`，事件由测试手动 `emit`。
 * - kernel 进程（对话主循环）：开轮、会话级命令、工具请求的回执、本子编辑；
 * - agent 进程（家务）：内建目录与刷新、连接测试、小结与收尾清单、还没迁的旧会话的本子编辑与分支、MCP 热重载回执。
 *
 * 内部的超时兜底是真 setTimeout——不 mock 的话 node --test 会挂到计时器走完才退。
 *
 * 时序约定：命令在 `await ensure()` / `await ensureKernel()` 处挂起，ready 事件只是 resolve 了那个 promise，
 * **注册等待者、发出命令是之后一跳的微任务**——所以 emit(ready) 之后必须先 `await flush()` 再喂后续事件，
 * 否则事件落空、promise 永远不结。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentCommand, AgentEvent } from "../../shared/agent-ipc.ts";
import type { KernelCommand, KernelMessage, KernelReplyCommand } from "../../shared/kernel.ts";
import { AgentHostCore, MIGRATION_HINT_BYTES, type AgentChild, type KernelLane, type KernelRoute, type KernelTurnRoute } from "./host-core.ts";

/** 脚本化的假 agent 进程。 */
class FakeChild implements AgentChild {
  readonly posted: AgentCommand[] = [];
  private readonly messageListeners = new Set<(message: AgentEvent) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();

  on(event: "message", listener: (message: AgentEvent) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(
    event: "message" | "exit",
    listener: ((message: AgentEvent) => void) | ((code: number) => void),
  ): unknown {
    if (event === "message") {
      this.messageListeners.add(listener as (message: AgentEvent) => void);
    } else {
      this.exitListeners.add(listener as (code: number) => void);
    }
    return this;
  }

  postMessage(message: AgentCommand): unknown {
    this.posted.push(message);
    return undefined;
  }

  kill(): unknown {
    for (const listener of this.exitListeners) listener(0);
    return true;
  }

  /** 测试侧驱动：runtime 发来的事件 / 进程退出。 */
  emit(event: AgentEvent): void {
    for (const listener of this.messageListeners) listener(event);
  }

  exitWith(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

/** kernel 进程的假货：命令记进 posted，事件由测试 emit（KernelMessage 是 AgentEvent 的超集） */
class FakeKernel {
  readonly posted: KernelCommand[] = [];
  private readonly messageListeners = new Set<(message: KernelMessage) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  on(event: "message", listener: (message: KernelMessage) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "message" | "exit", listener: ((message: KernelMessage) => void) | ((code: number) => void)): unknown {
    if (event === "message") this.messageListeners.add(listener as (message: KernelMessage) => void);
    else this.exitListeners.add(listener as (code: number) => void);
    return this;
  }
  postMessage(message: KernelCommand): unknown {
    this.posted.push(message);
    return undefined;
  }
  kill(): unknown {
    for (const listener of this.exitListeners) listener(0);
    return true;
  }
  emit(message: KernelMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }
  exitWith(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }
  /** 发给它的会话命令（{ type: "session" } 里那条） */
  sessionCommands(): string[] {
    return this.posted.flatMap((command) => (command.type === "session" ? [command.command.type] : []));
  }
  /** 发给它的回执（{ type: "reply" } 里那条） */
  replies(): KernelReplyCommand[] {
    return this.posted.flatMap((command) => (command.type === "reply" ? [command.command] : []));
  }
}

const TURN_FIELDS = {
  cwd: "C:/work",
  provider: { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k", models: [{ id: "m" }] },
  modelId: "m",
  mode: "manual" as const,
  thinkingLevel: "medium" as const,
  piSessionDir: "C:/pi-sessions",
  attachmentsDir: "C:/sessions/test.attachments",
  protectedPaths: ["C:/pi-sessions"],
  protectedFiles: ["C:/UserData/automations.json"],
  skillsDirs: ["C:/skills"],
  workspaceId: null,
  mcpServers: {},
};

/** 排空微任务队列——emit(ready) 之后 host 的续体（注册 pending、发命令）要等一跳才跑。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 默认的新内核那条道：开轮一律交给 kernel（树根 = 它自己），本子编辑按 edits 分流（缺省 kernel） */
function laneOf(kernel: () => FakeKernel, edits: Record<string, "kernel" | "legacy"> = {}): KernelLane {
  return {
    fork: kernel,
    dir: "/durable",
    route: async (command): Promise<KernelTurnRoute> => ({ to: "kernel", root: command.sessionId }),
    editRoute: async (sessionId): Promise<KernelRoute> => (edits[sessionId] === "legacy" ? { to: "legacy" } : { to: "kernel", root: sessionId }),
    settled: () => undefined,
    exited: () => undefined,
  };
}

async function freshHost(edits: Record<string, "kernel" | "legacy"> = {}): Promise<{
  host: AgentHostCore;
  child: () => FakeChild;
  forks: () => number;
  kernel: () => FakeKernel;
  kernelForks: () => number;
  events: AgentEvent[];
}> {
  let child!: FakeChild;
  let forks = 0;
  let kernel!: FakeKernel;
  let kernelForks = 0;
  const events: AgentEvent[] = [];
  const host = new AgentHostCore(
    () => {
      forks += 1;
      child = new FakeChild();
      return child;
    },
    (event) => events.push(event),
    laneOf(() => {
      kernelForks += 1;
      kernel = new FakeKernel();
      return kernel;
    }, edits),
  );
  return { host, child: () => child, forks: () => forks, kernel: () => kernel, kernelForks: () => kernelForks, events };
}

type Ctx = Awaited<ReturnType<typeof freshHost>>;

/** 把一条会话的一轮交给 kernel（续轮，发完即回）：之后它的会话级命令都走 kernel */
async function kernelTurn(ctx: Ctx, sessionId: string): Promise<void> {
  const turn = ctx.host.submit({ type: "submit", sessionId, text: "hi", piSessionFile: `/${sessionId}.jsonl`, ...TURN_FIELDS });
  await flush();
  if (ctx.kernelForks() === 1 && !ctx.kernel().posted.some((command) => command.type === "init")) ctx.kernel().emit({ type: "ready" });
  await turn;
}

/** kernel 在这一轮里发出几条请求（工具请求带 requestId）：它们的回执要回到 kernel */
async function kernelRequesting(requestIds: readonly string[]): Promise<Ctx> {
  const ctx = await freshHost();
  await kernelTurn(ctx, "s1");
  for (const requestId of requestIds) ctx.kernel().emit({ type: "readTaskRequest", requestId, sessionId: "s1" } as never);
  return ctx;
}

describe("开轮交给 kernel —— created 的等待（首轮开机）", () => {
  test("首轮（不带本子）：kernel 回 created 才返回，本子引用原样交回；init 先于第一条会话命令", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = ctx.host.submit({ type: "submit", sessionId: "s1", text: "hi", ...TURN_FIELDS });
    await flush();
    ctx.kernel().emit({ type: "ready" });
    await flush();
    ctx.kernel().emit({ type: "created", sessionId: "s1", piSessionFile: "durable:s1" });
    assert.equal(await pending, "durable:s1");
    assert.deepEqual(ctx.kernel().posted.map((command) => command.type), ["init", "session"]);
    assert.equal(ctx.forks(), 0, "开轮不拉起 agent 进程");
  });

  test("续轮（本子已带）：不等 created，发完即回 null；命令带着完整开工上下文", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = ctx.host.submit({ type: "submit", sessionId: "s1", text: "hi", ...TURN_FIELDS, piSessionFile: "pi/abc.jsonl" });
    await flush();
    ctx.kernel().emit({ type: "ready" });
    assert.equal(await pending, null);
    const session = ctx.kernel().posted[1];
    assert.ok(session?.type === "session");
    assert.deepEqual(session.command, { type: "submit", sessionId: "s1", text: "hi", ...TURN_FIELDS, piSessionFile: "pi/abc.jsonl" });
  });

  test("failed 带同一个 sessionId —— 错误交回调用方，不是只广播一条事件", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = ctx.host.submit({ type: "submit", sessionId: "s1", text: "hi", ...TURN_FIELDS });
    await flush();
    ctx.kernel().emit({ type: "ready" });
    await flush();
    ctx.kernel().emit({ type: "failed", sessionId: "s1", message: "no provider" });
    await assert.rejects(pending, /no provider/);
  });

  test("route 拒绝（迁移失败过、只读）：原因交回调用方，什么都不发", async () => {
    const kernel = new FakeKernel();
    const lane: KernelLane = { ...laneOf(() => kernel), route: async () => Promise.reject(new Error("read-only")) };
    const host = new AgentHostCore(() => new FakeChild(), () => undefined, lane);
    await assert.rejects(host.submit({ type: "submit", sessionId: "s1", text: "hi", ...TURN_FIELDS, piSessionFile: "/p" }), /read-only/);
    assert.equal(kernel.posted.length, 0);
  });
});

describe("agent 进程（家务）：还没迁的旧会话的分支、进程退出与重拉", () => {
  test("无等待者的 created：转发 onEvent 给主进程钩子", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const builtins = ctx.host.listBuiltins(); // 拉起进程（懒启动）
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s7", piSessionFile: "pi/new.jsonl" });
    // host-core 不消化它，原样交给 onEvent（main/index.ts 的 meta 校准钩子）
    assert.deepEqual(ctx.events.at(-1), { type: "created", sessionId: "s7", piSessionFile: "pi/new.jsonl" });
    ctx.host.dispose();
    await Promise.race([builtins.catch(() => undefined), Promise.resolve()]);
  });

  test("branchSession（没给源会话 / 源是还没迁的旧会话）：agent 进程裁 pi 本子，created 回分支文件；对账失败经 failed 拒绝", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost({ old: "legacy" });
    const ok = ctx.host.branchSession({ sourcePiSessionFile: "pi/src.jsonl", cwd: "C:/work", roles: ["user", "assistant"] }, "s9", "old");
    await flush();
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s9", piSessionFile: "pi/branch.jsonl" });
    assert.equal(await ok, "pi/branch.jsonl");
    assert.deepEqual(ctx.child().posted[0], {
      type: "branch",
      sessionId: "s9",
      sourcePiSessionFile: "pi/src.jsonl",
      cwd: "C:/work",
      roles: ["user", "assistant"],
    });
    assert.equal(ctx.kernelForks(), 0, "旧会话的分支不拉起 kernel");

    const rejected = ctx.host.branchSession({ sourcePiSessionFile: "pi/src.jsonl", cwd: "C:/work", roles: ["user"] }, "s8");
    await flush();
    ctx.child().emit({ type: "failed", sessionId: "s8", message: "两本账对不上" });
    await assert.rejects(rejected, /两本账对不上/);
  });

  test("等着的分支遇上进程退出 —— reject、广播 failed(null)、下次 ensure 重新 fork", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const first = ctx.host.branchSession({ sourcePiSessionFile: "pi/a.jsonl", cwd: "C:/work", roles: ["user"] }, "b1");
    const second = ctx.host.branchSession({ sourcePiSessionFile: "pi/b.jsonl", cwd: "C:/work", roles: ["user"] }, "b2");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().exitWith(1);
    await assert.rejects(first, /exited with code 1/);
    await assert.rejects(second, /exited with code 1/);
    assert.ok(ctx.events.some((event) => event.type === "failed" && event.sessionId === null && /code 1/.test(event.message)));

    // 进程死了不等于 host 死了：下一次用时重新 fork
    const again = ctx.host.branchSession({ sourcePiSessionFile: "pi/c.jsonl", cwd: "C:/work", roles: ["user"] }, "b3");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "b3", piSessionFile: "pi/c-branch.jsonl" });
    assert.equal(await again, "pi/c-branch.jsonl");
    assert.equal(ctx.forks(), 2);
  });
});

describe("ensure —— fork 同步抛错不缓存在 ready 里（Windows ENOTCONN）", () => {
  test("第一次同步抛错交给调用方，第二次请求重新拉起并成功", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fail = true;
    let forks = 0;
    let child!: FakeChild;
    const host = new AgentHostCore(
      () => {
        forks += 1;
        if (fail) {
          fail = false;
          throw new Error("spawn ENOTCONN");
        }
        child = new FakeChild();
        return child;
      },
      () => undefined,
      laneOf(() => new FakeKernel()),
    );

    // 第一次：forkRuntime 同步抛错 → 这次调用方拿到错误，而不是被挂起
    await assert.rejects(host.probeProvider(TURN_FIELDS.provider, "m"), /ENOTCONN/);
    assert.equal(forks, 1);

    // 第二次：同一个 host 还能拉起（ready 没被缓存的 rejected promise 占住），请求成功
    const pending = host.probeProvider(TURN_FIELDS.provider, "m");
    child.emit({ type: "ready" });
    await flush();
    const command = child.posted.find((c): c is Extract<AgentCommand, { type: "probeProvider" }> => c.type === "probeProvider");
    assert.ok(command !== undefined);
    child.emit({ type: "providerProbed", requestId: command.requestId, ok: true, message: "ok" });
    assert.deepEqual(await pending, { ok: true, message: "ok" });
    assert.equal(forks, 2);
  });
});

describe("内建 provider 目录的到达时机（债务 B #2）", () => {
  test("目录未到就等，builtins 事件一到立刻返回；之后走缓存", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const providers = [
      {
        id: "zai",
        name: "Z.ai",
        baseUrl: "https://api.z.ai",
        api: "openai-completions",
        models: [
          {
            id: "m",
            contextWindow: 200_000,
            maxTokens: 8_192,
            input: ["text"] as ("text" | "image")[],
            cost: { input: 0.6, output: 2.2, cacheRead: 0.05, cacheWrite: 0.6 },
          },
        ],
      },
    ];
    const pending = ctx.host.listBuiltins();
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "builtins", providers });
    assert.deepEqual(await pending, providers);
    // 已到手：再问立即返回，也不再 fork
    assert.deepEqual(await ctx.host.listBuiltins(), providers);
    assert.equal(ctx.forks(), 1);
  });

  test("目录刷新后再报一次：缓存换成新的，并交给 onEvent 广播（窗口不用刷新）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const model = (id: string) => ({
      id,
      contextWindow: 1_000_000,
      maxTokens: 8_192,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
    });
    const first = [{ id: "anthropic", name: "Anthropic", baseUrl: "https://a", api: "anthropic-messages", models: [model("old")] }];
    const refreshed = [{ ...first[0]!, models: [model("old"), { ...model("claude-opus-5-5"), name: "Claude Opus 5.5" }] }];
    const pending = ctx.host.listBuiltins();
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "builtins", providers: first });
    await pending;
    ctx.child().emit({ type: "builtins", providers: refreshed });
    assert.deepEqual(await ctx.host.listBuiltins(), refreshed);
    assert.deepEqual(
      ctx.events.filter((event) => event.type === "builtins"),
      [
        { type: "builtins", providers: first },
        { type: "builtins", providers: refreshed },
      ],
    );
  });
});

describe("会话级命令跟着会话走 —— 没交给过 kernel 的会话此刻没有在跑的轮", () => {
  test("disposeSession：从未交给过 kernel 不拉起任何进程；交给过的发 dispose；进程不在时静默", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    ctx.host.disposeSession("never-created");
    assert.equal(ctx.forks(), 0);
    assert.equal(ctx.kernelForks(), 0);
    for (const id of ["s1", "s2", "s3"]) {
      await kernelTurn(ctx, id);
      ctx.host.disposeSession(id);
    }
    const disposed = ctx.kernel().posted.flatMap((command) => (command.type === "session" && command.command.type === "dispose" ? [command.command.sessionId] : []));
    assert.deepEqual(disposed, ["s1", "s2", "s3"]);
    ctx.host.dispose();
    ctx.host.disposeSession("s1"); // 不抛
  });

  test("停止 / 标题：没交给过 kernel 的会话什么都不发、不拉起进程", async () => {
    const ctx = await freshHost();
    // 不 await：改坏成「拉起进程再发」时它会等 ready 挂住，这里照样能看出拉起了
    void ctx.host.abort("idle");
    ctx.host.generateTitle("idle", "第一句");
    await flush();
    assert.equal(ctx.forks(), 0);
    assert.equal(ctx.kernelForks(), 0);
  });

  test("插话：交给过 kernel 的发给 kernel（delivery 原样带上）；没交给过的抛错——调用方（deliverToChild）据此按投递失败处理", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    assert.throws(() => ctx.host.steer("s1", "x", "steer"), /no running turn/);
    await kernelTurn(ctx, "s1");
    ctx.host.steer("s1", "先别改这个文件", "followUp");
    const last = ctx.kernel().posted.at(-1);
    assert.ok(last?.type === "session");
    assert.deepEqual(last.command, { type: "steer", sessionId: "s1", text: "先别改这个文件", delivery: "followUp" });
  });

  test("setModel：交给过 kernel 的由 kernel 校验；没交给过的由 agent 进程校验并报 model 事件（provider 与 modelId 原样带上）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const provider = { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k2", models: [] };
    const idle = ctx.host.setModel("idle", provider, "glm-5.3");
    ctx.child().emit({ type: "ready" });
    await idle;
    assert.deepEqual(ctx.child().posted.at(-1), { type: "setModel", sessionId: "idle", provider, modelId: "glm-5.3" });
    await kernelTurn(ctx, "s1");
    await ctx.host.setModel("s1", provider, "glm-5.3");
    const last = ctx.kernel().posted.at(-1);
    assert.ok(last?.type === "session");
    assert.deepEqual(last.command, { type: "setModel", sessionId: "s1", provider, modelId: "glm-5.3" });
    assert.equal(ctx.child().posted.filter((command) => command.type === "setModel").length, 1, "交给过 kernel 的不再发给 agent 进程");
  });
});

describe("回执回到 kernel —— 载荷逐字段（漏一个字段，工具结果里就少一块）；对不上号的丢掉", () => {
  test("answerIntentConfirm：按 requestId 原样转给 kernel；进程都没起时静默（不拉起）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const idle = await freshHost();
    const decision = { action: "confirm" as const, answers: [{ askId: "a1", verdict: "yes" as const }], note: "" };
    idle.host.answerIntentConfirm("q0", decision);
    assert.equal(idle.forks(), 0);
    assert.equal(idle.kernelForks(), 0);
    const ctx = await kernelRequesting(["q1"]);
    ctx.host.answerIntentConfirm("q1", decision);
    assert.deepEqual(ctx.kernel().replies().at(-1), { type: "intentConfirmResult", requestId: "q1", decision });
  });

  test("answerReadTask：成功回执带 card 与 text；失败回执只带 error；对不上号的丢掉、不拉起 agent 进程", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await kernelRequesting(["r1", "r2"]);
    ctx.host.answerReadTask("r0", { ok: false, error: "gone" });
    ctx.host.answerReadTask("r1", { ok: true, card: { sessionId: "t-1", title: "Demo", mode: "briefing", roundCount: 3 }, text: "Task \"Demo\"…" });
    ctx.host.answerReadTask("r2", { ok: false, error: "No task matches" });
    assert.equal(ctx.forks(), 0);
    assert.deepEqual(ctx.kernel().replies(), [
      { type: "readTaskResult", requestId: "r1", ok: true, card: { sessionId: "t-1", title: "Demo", mode: "briefing", roundCount: 3 }, text: "Task \"Demo\"…" },
      { type: "readTaskResult", requestId: "r2", ok: false, error: "No task matches" },
    ]);
    // 同一个 requestId 回第二次：已经结过，丢掉
    ctx.host.answerReadTask("r1", { ok: false, error: "late" });
    assert.equal(ctx.kernel().replies().length, 2);
  });

  test("answerModelCosts：成功带 text，失败只带 error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await kernelRequesting(["r1", "r2"]);
    ctx.host.answerModelCosts("r1", { ok: true, text: "model | thinking" });
    ctx.host.answerModelCosts("r2", { ok: false, error: "boom" });
    assert.deepEqual(ctx.kernel().replies(), [
      { type: "modelCostsResult", requestId: "r1", ok: true, text: "model | thinking" },
      { type: "modelCostsResult", requestId: "r2", ok: false, error: "boom" },
    ]);
  });

  test("answerAutomation：成功回执逐字段带上卡、列表与「改权限」那一行（漏了行，工具结果里就没有那一行）；失败只带 error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await kernelRequesting(["q1", "q2", "q3"]);
    const card = {
      id: "au1",
      title: "每日一篇",
      schedule: { kind: "daily" as const, time: "08:00" },
      target: "new_session" as const,
      status: "active" as const,
      nextRunAt: 1,
      runCount: 0,
    };
    ctx.host.answerAutomation("q1", { ok: true, text: "created", automation: card });
    ctx.host.answerAutomation("q2", { ok: true, text: "list", automations: [card] });
    ctx.host.answerAutomation("q3", { ok: false, error: "No such automation" });
    assert.deepEqual(ctx.kernel().replies(), [
      { type: "automationResult", requestId: "q1", ok: true, text: "created", automation: card },
      { type: "automationResult", requestId: "q2", ok: true, text: "list", automations: [card] },
      { type: "automationResult", requestId: "q3", ok: false, error: "No such automation" },
    ]);
  });

  test("answerDelegate：成功带 childId/title/card，失败只带 error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await kernelRequesting(["r1", "r2"]);
    const card = { childId: "c1", title: "调研分支", modelId: "m", thinkingLevel: "medium" as const, workbench: "/wb/c1" };
    ctx.host.answerDelegate("r1", { ok: true, childId: "c1", title: "调研分支", card });
    ctx.host.answerDelegate("r2", { ok: false, error: "empty task" });
    assert.deepEqual(ctx.kernel().replies(), [
      { type: "delegateResult", requestId: "r1", ok: true, childId: "c1", title: "调研分支", card },
      { type: "delegateResult", requestId: "r2", ok: false, error: "empty task" },
    ]);
  });

  test("answerChannelSend：成功带 messageId，失败只带 error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await kernelRequesting(["r1", "r2"]);
    ctx.host.answerChannelSend("r1", { ok: true, messageId: "m1" });
    ctx.host.answerChannelSend("r2", { ok: false, error: "kind not allowed" });
    assert.deepEqual(ctx.kernel().replies(), [
      { type: "channelSendResult", requestId: "r1", ok: true, messageId: "m1" },
      { type: "channelSendResult", requestId: "r2", ok: false, error: "kind not allowed" },
    ]);
  });
});

describe("probeProvider（Test 的 OAuth 路由）", () => {
  test("按 requestId 结回执：结果原样 resolve；回执不广播给窗口；进程退出 reject", async () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    const host = new AgentHostCore(() => child, (event) => events.push(event), laneOf(() => new FakeKernel()));
    const pending = host.probeProvider(TURN_FIELDS.provider, "claude-sonnet-5");
    child.emit({ type: "ready" });
    await flush();
    const command = child.posted.find(
      (command): command is Extract<AgentCommand, { type: "probeProvider" }> => command.type === "probeProvider",
    );
    assert.ok(command !== undefined);
    assert.equal(command.modelId, "claude-sonnet-5");
    child.emit({ type: "providerProbed", requestId: command.requestId, ok: true, message: "Connected — claude-sonnet-5 responded." });
    assert.deepEqual(await pending, { ok: true, message: "Connected — claude-sonnet-5 responded." });
    assert.equal(events.length, 0);

    const late = host.probeProvider(TURN_FIELDS.provider, "m");
    await flush();
    const lateCommand = child.posted.filter(
      (command): command is Extract<AgentCommand, { type: "probeProvider" }> => command.type === "probeProvider",
    ).at(-1);
    assert.ok(lateCommand !== undefined);
    child.exitWith(1);
    await assert.rejects(late, /exited/);
  });
});

describe("mcpReload —— 回执共享在飞的一份（PR #163 验收：单槽顶号让面板永远冻结）", () => {
  /** 先把 agent 进程拉起来（mcpReload 不 ensure：进程没起直接 resolve，没有等待者） */
  async function runningHost(): Promise<{ host: AgentHostCore; child: () => FakeChild }> {
    const ctx = await freshHost();
    const builtins = ctx.host.listBuiltins();
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "builtins", providers: [] });
    await builtins;
    return ctx;
  }

  test("60 秒内第二次 reload 不顶掉前一个：一份快照把两个调用方都结掉", async () => {
    const { host, child } = await runningHost();
    const first = host.mcpReload();
    const second = host.mcpReload();
    // 共享在飞：第二个调用不必再发一条 reset——reset 不读配置，连发两次语义相同
    assert.equal(child().posted.filter((m) => m.type === "mcpReload").length, 1);
    child().emit({ type: "mcp", servers: [] });
    await Promise.all([first, second]);
    // 落定后下一次调用重新起一份
    const third = host.mcpReload();
    assert.equal(child().posted.filter((m) => m.type === "mcpReload").length, 2);
    child().emit({ type: "mcp", servers: [] });
    await third;
  });

  test("进程退出：在等的 reload 如实 reject，不装作重载成功", async () => {
    const { host, child } = await runningHost();
    const pending = host.mcpReload();
    await assert.rejects(Promise.all([pending, Promise.resolve().then(() => child().exitWith(1))]), /exited/);
  });

  test("kernel 进程开着：它也收到 mcpReload（它有自己的一份连接）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const builtins = ctx.host.listBuiltins();
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "builtins", providers: [] });
    await builtins;
    await kernelTurn(ctx, "s1");
    const reload = ctx.host.mcpReload();
    assert.ok(ctx.kernel().posted.some((command) => command.type === "mcpReload"));
    ctx.child().emit({ type: "mcp", servers: [] });
    await reload;
  });
});

describe("choreComplete（收尾清单按反馈改写）", () => {
  test("不是会话里的一轮：命令不带 sessionId、不碰任何会话；回执只结发起方，不广播（没有 thinking / model 事件可被输入卡对齐）", async () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    const host = new AgentHostCore(() => child, (event) => events.push(event), laneOf(() => new FakeKernel()));
    const pending = host.choreComplete(TURN_FIELDS.provider, "flash", "sys", "prompt");
    child.emit({ type: "ready" });
    await flush();
    const commands = child.posted.filter((command) => command.type !== "listBuiltins");
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.type, "choreComplete");
    assert.equal("sessionId" in (commands[0] ?? {}), false);
    const command = commands[0] as Extract<AgentCommand, { type: "choreComplete" }>;
    child.emit({ type: "choreCompleted", requestId: command.requestId, text: "```json\n{}\n```" });
    assert.equal(await pending, "```json\n{}\n```");
    assert.equal(events.length, 0);
  });

  test("失败回执 reject 带原因；进程退出 reject", async () => {
    const child = new FakeChild();
    const host = new AgentHostCore(() => child, () => undefined, laneOf(() => new FakeKernel()));
    const failed = host.choreComplete(TURN_FIELDS.provider, "m", "s", "p");
    child.emit({ type: "ready" });
    await flush();
    const command = child.posted.find((c) => c.type === "choreComplete") as Extract<AgentCommand, { type: "choreComplete" }>;
    child.emit({ type: "choreCompleted", requestId: command.requestId, text: null, error: "401" });
    await assert.rejects(failed, /401/);
    const late = host.choreComplete(TURN_FIELDS.provider, "m", "s", "p");
    await flush();
    child.exitWith(1);
    await assert.rejects(late, /exited/);
  });
});

describe("目录刷新范围 —— 只送已添加服务商的目录（审核 F-1）", () => {
  function scopedHost(scope: () => Promise<readonly string[]>) {
    let child!: FakeChild;
    const host = new AgentHostCore(
      () => {
        child = new FakeChild();
        return child;
      },
      () => undefined,
      laneOf(() => new FakeKernel()),
      scope,
    );
    return { host, child: () => child };
  }
  const refreshes = (child: FakeChild) => child.posted.filter((command) => command.type === "refreshCatalogs");

  test("进程拉起（ready）后送一份 added 全量；崩溃重拉后再送一份", async () => {
    let ids: string[] = ["deepseek"];
    const ctx = scopedHost(async () => ids);
    void ctx.host.listBuiltins().catch(() => undefined);
    const first = ctx.child();
    assert.deepEqual(refreshes(first), [], "ready 之前不送");
    first.emit({ type: "ready" });
    await flush();
    assert.deepEqual(refreshes(first), [{ type: "refreshCatalogs", scope: "added", catalogIds: ["deepseek"] }]);

    first.exitWith(1);
    ids = ["deepseek", "tokenrhythm"];
    void ctx.host.listBuiltins().catch(() => undefined);
    ctx.child().emit({ type: "ready" });
    await flush();
    assert.notEqual(ctx.child(), first);
    assert.deepEqual(refreshes(ctx.child()), [
      { type: "refreshCatalogs", scope: "added", catalogIds: ["deepseek", "tokenrhythm"] },
    ]);
  });

  test("服务商列表变了：送新的全量；进程没起时不为它拉起", async () => {
    let ids: string[] = [];
    let forks = 0;
    let child!: FakeChild;
    const host = new AgentHostCore(
      () => {
        forks += 1;
        child = new FakeChild();
        return child;
      },
      () => undefined,
      laneOf(() => new FakeKernel()),
      async () => ids,
    );
    host.syncCatalogScope();
    await flush();
    assert.equal(forks, 0, "没起的进程不拉起：下次拉起时 ready 会送");

    void host.listBuiltins().catch(() => undefined);
    child.emit({ type: "ready" });
    await flush();
    ids = ["tokenrhythm"];
    host.syncCatalogScope();
    await flush();
    assert.deepEqual(refreshes(child).map((command) => command.type === "refreshCatalogs" && command.catalogIds), [
      [],
      ["tokenrhythm"],
    ]);
  });

  test("peek：点开卡片时拉起进程，只送那一份", async () => {
    const ctx = scopedHost(async () => []);
    const peek = ctx.host.peekCatalog("tokenrhythm");
    ctx.child().emit({ type: "ready" });
    await peek;
    await flush();
    // 两条谁先到无所谓：agent 侧排队串行（CatalogRefresher）
    const sent = refreshes(ctx.child()).map((command) => JSON.stringify(command)).sort();
    assert.deepEqual(sent, [
      JSON.stringify({ type: "refreshCatalogs", scope: "added", catalogIds: [] }),
      JSON.stringify({ type: "refreshCatalogs", scope: "peek", catalogIds: ["tokenrhythm"] }),
    ]);
  });

  test("没给 catalogScope（测试 / 裸跑）：一条刷新命令都不送", async () => {
    const ctx = await freshHost();
    void ctx.host.listBuiltins().catch(() => undefined);
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.host.syncCatalogScope();
    await flush();
    assert.deepEqual(refreshes(ctx.child()), []);
  });
});


/** roots：会话 → 树根（缺省它自己）；edits：本子编辑交给谁（缺省 kernel）；migrateBytes：这一轮要迁的旧本子多大 */
function kernelRig(roots: Record<string, string> = {}, edits: Record<string, "kernel" | "legacy"> = {}, migrateBytes: Record<string, number> = {}) {
  const legacy = new FakeChild();
  const kernel = new FakeKernel();
  const events: AgentEvent[] = [];
  const settled: string[] = [];
  const exited: string[][] = [];
  const lane: KernelLane = {
    fork: () => kernel,
    dir: "/durable",
    route: async (command): Promise<KernelTurnRoute> => ({
      to: "kernel",
      root: roots[command.sessionId] ?? command.sessionId,
      ...(migrateBytes[command.sessionId] === undefined ? {} : { migrateBytes: migrateBytes[command.sessionId] }),
    }),
    editRoute: async (sessionId): Promise<KernelRoute> => (edits[sessionId] === "legacy" ? { to: "legacy" } : { to: "kernel", root: roots[sessionId] ?? sessionId }),
    settled: (sessionId) => settled.push(sessionId),
    exited: (running) => exited.push([...running]),
  };
  const host = new AgentHostCore(() => legacy, (event) => events.push(event), lane);
  return { host, legacy, kernel, events, settled, exited };
}

describe("AgentHostCore：新内核那条道", () => {
  test("根会话与子会话的开轮都交给 kernel（init 先于第一条会话命令；子会话带父的树根）；agent 进程不被拉起", async () => {
    const r = kernelRig({ child: "root" });
    const turn = r.host.submit({ type: "submit", sessionId: "s1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    assert.equal(await turn, null);
    assert.deepEqual(
      r.kernel.posted.map((command) => command.type),
      ["init", "session"],
    );
    const session = r.kernel.posted[1];
    assert.ok(session?.type === "session" && session.root === "s1" && session.command.type === "submit");
    await r.host.submit({ type: "submit", sessionId: "child", text: "x", piSessionFile: "/c.jsonl", ...TURN_FIELDS });
    const childTurn = r.kernel.posted.at(-1);
    assert.ok(childTurn?.type === "session" && childTurn.root === "root" && childTurn.command.type === "submit");
    assert.equal(r.legacy.posted.length, 0);
  });

  test("停止 / 插话跟着会话走：交给过 kernel 的去 kernel", async () => {
    const r = kernelRig();
    const turn = r.host.submit({ type: "submit", sessionId: "s1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await turn;
    await r.host.abort("s1");
    r.host.steer("s1", "插话", "steer");
    const sessionCommands = r.kernel.posted.flatMap((command) => (command.type === "session" ? [command.command.type] : []));
    assert.deepEqual(sessionCommands, ["submit", "abort", "steer"]);
  });

  test("标题（新内核）：只给这一轮建出来的全新会话起一次——续聊、分支会话的第一句不起（与旧内核实际的门一致）", async () => {
    const r = kernelRig();
    const titles = () => r.kernel.posted.flatMap((command) => (command.type === "session" && command.command.type === "generateTitle" ? [command.root] : []));
    // 全新会话：开轮命令没带本子，等过 created
    const fresh = r.host.submit({ type: "submit", sessionId: "fresh", text: "hi", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await flush();
    r.kernel.emit({ type: "created", sessionId: "fresh", piSessionFile: "durable:fresh" });
    await fresh;
    r.host.generateTitle("fresh", "第一句");
    // 同一条会话的第二轮：不再起
    await r.host.submit({ type: "submit", sessionId: "fresh", text: "again", piSessionFile: "durable:fresh", ...TURN_FIELDS });
    r.host.generateTitle("fresh", "第二句");
    // 分支出来的会话（带着本子）第一句：不起
    await r.host.submit({ type: "submit", sessionId: "branch", text: "b1", piSessionFile: "durable:branch", ...TURN_FIELDS });
    r.host.generateTitle("branch", "分支里");
    assert.deepEqual(titles(), ["fresh"]);
  });

  test("每个事件只交给 onEvent 一次（两个子进程都是）——交两次会让 renderer 一个 idle 投递两条排队消息", async () => {
    const r = kernelRig();
    const turn = r.host.submit({ type: "submit", sessionId: "s1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await turn;
    r.kernel.emit({ type: "phase", sessionId: "s1", phase: "idle" });
    const builtins = r.host.listBuiltins();
    r.legacy.emit({ type: "ready" });
    await flush();
    r.legacy.emit({ type: "builtins", providers: [] });
    await builtins;
    assert.equal(r.events.filter((event) => event.type === "phase" && event.sessionId === "s1").length, 1);
    assert.equal(r.events.filter((event) => event.type === "builtins").length, 1);
  });

  test("kernel 发出的请求，回执回到 kernel；对不上号的回执丢掉（agent 进程不跑轮，没有在途请求）", async () => {
    const r = kernelRig();
    const turn = r.host.submit({ type: "submit", sessionId: "s1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await turn;
    // agent 进程也开着（内建目录）：对不上号的回执也不该落到它那里
    const builtins = r.host.listBuiltins();
    r.legacy.emit({ type: "ready" });
    await flush();
    r.legacy.emit({ type: "builtins", providers: [] });
    await builtins;
    r.kernel.emit({ type: "readTaskRequest", requestId: "r-kernel", sessionId: "s1" });
    r.host.answerReadTask("r-kernel", { ok: false, error: "x" });
    r.host.answerReadTask("r-legacy", { ok: false, error: "y" });
    const replies = r.kernel.posted.flatMap((command) => (command.type === "reply" ? [command.command.type] : []));
    assert.deepEqual(replies, ["readTaskResult"]);
    assert.deepEqual(r.legacy.posted.map((command) => command.type), [], "agent 进程一条回执都没收到");
    assert.ok(r.events.some((event) => event.type === "readTaskRequest"), "kernel 的事件照常交给 onEvent");
  });

  test("kernel 进程意外退出：在跑的会话标「被打断、可继续」并回到空闲，交给善后；落定过的不标", async () => {
    const r = kernelRig();
    const a = r.host.submit({ type: "submit", sessionId: "a", text: "hi", piSessionFile: "/a.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await a;
    await r.host.submit({ type: "submit", sessionId: "b", text: "hi", piSessionFile: "/b.jsonl", ...TURN_FIELDS });
    r.kernel.emit({ type: "turnSettled", sessionId: "b", result: { ok: true, conversationId: 1, migration: "none", status: "done" } });
    r.kernel.exitWith(137);
    assert.deepEqual(r.settled, ["b"]);
    assert.deepEqual(r.exited, [["a"]]);
    const failed = r.events.find((event) => event.type === "failed");
    assert.ok(failed !== undefined && failed.type === "failed" && failed.sessionId === "a" && failed.continuable === true && failed.turn === true);
    assert.ok(r.events.some((event) => event.type === "phase" && event.sessionId === "a" && event.phase === "idle"));
    assert.ok(!r.events.some((event) => event.type === "failed" && event.sessionId === "b"));
  });

  test("本子编辑（回退 / 撤销）与分支交给 kernel：子会话带父的树根、分支是新树；回执结掉等待；kernel 退出时等待者被拒", async () => {
    const r = kernelRig({ child: "root" }, { legacyOne: "legacy" });
    const revert = r.host.editPiBook({ type: "revertPiBook", sessionId: "child", sourcePiSessionFile: "/p", cwd: "/", roles: ["user", "assistant"], targetMessageId: "m" });
    await flush();
    r.kernel.emit({ type: "ready" });
    await flush();
    r.kernel.emit({ type: "piBookEdited", sessionId: "child", edit: "revert" });
    await revert;
    const branch = r.host.branchSession({ sourcePiSessionFile: "/p", cwd: "/", roles: ["user", "assistant"] }, "fresh", "child");
    await flush();
    r.kernel.emit({ type: "created", sessionId: "fresh", piSessionFile: "durable:fresh" });
    assert.equal(await branch, "durable:fresh");
    const sessions = r.kernel.posted.flatMap((command) => (command.type === "session" ? [command] : []));
    assert.deepEqual(
      sessions.map((command) => [command.root, command.command.type]),
      [
        ["root", "revertPiBook"],
        ["fresh", "branch"],
      ],
    );
    const branched = sessions[1]?.command;
    assert.ok(branched?.type === "branch" && branched.sourceSessionId === "child" && branched.sourceRoot === "root");
    // 还没在新内核里跑过的旧会话：交给 agent 进程编辑 pi 本子
    const legacyEdit = r.host.editPiBook({ type: "undoPiBook", sessionId: "legacyOne", sourcePiSessionFile: "/p", cwd: "/", notice: "n" });
    await flush();
    r.legacy.emit({ type: "ready" });
    await flush();
    assert.deepEqual(r.legacy.posted.map((command) => command.type), ["undoPiBook"]);
    r.legacy.emit({ type: "piBookEdited", sessionId: "legacyOne", edit: "undo" });
    await legacyEdit;
    // 等着的编辑遇上 kernel 退出：立刻被拒，不等 30 秒
    const hanging = r.host.editPiBook({ type: "undoPiBook", sessionId: "child", sourcePiSessionFile: "/p", cwd: "/", notice: "n" });
    await flush();
    r.kernel.exitWith(1);
    await assert.rejects(hanging, /kernel runtime exited/);
  });

  test("插话退回（steerBounced）：交给通道的「子空闲时的投递」；没人接时报 failed", async () => {
    const r = kernelRig();
    const turn = r.host.submit({ type: "submit", sessionId: "c1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await turn;
    r.kernel.emit({ type: "steerBounced", sessionId: "c1", text: "<channel …>", delivery: "steer" });
    assert.ok(r.events.some((event) => event.type === "failed" && event.sessionId === "c1"));
    const bounced: string[] = [];
    r.host.onSteerBounced((sessionId, text, delivery) => bounced.push(`${sessionId}|${delivery}|${text}`));
    const before = r.events.length;
    r.kernel.emit({ type: "steerBounced", sessionId: "c1", text: "<channel …>", delivery: "followUp" });
    assert.deepEqual(bounced, ["c1|followUp|<channel …>"]);
    assert.equal(r.events.length, before, "交给了通道就不再报失败");
  });

  test("闲置回收：没有在跑的轮、没有等回执的请求时到点先收尾（关库）再结束进程；之后的命令懒拉起新进程；有请求挂着不回收", async () => {
    const kernels: FakeKernel[] = [];
    const events: AgentEvent[] = [];
    const lane: KernelLane = {
      fork: () => {
        const next = new FakeKernel();
        kernels.push(next);
        return next;
      },
      dir: "/durable",
      route: async (command): Promise<KernelTurnRoute> => ({ to: "kernel", root: command.sessionId }),
      editRoute: async (sessionId): Promise<KernelRoute> => ({ to: "kernel", root: sessionId }),
      settled: () => undefined,
      exited: () => undefined,
      idleRecycleMs: 30,
    };
    const host = new AgentHostCore(() => new FakeChild(), (event) => events.push(event), lane);
    const bounced: string[] = [];
    host.onSteerBounced((sessionId) => bounced.push(sessionId));
    const first = host.submit({ type: "submit", sessionId: "s1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    kernels[0]?.emit({ type: "ready" });
    await first;
    // 一个工具请求挂着：到点也不回收
    kernels[0]?.emit({ type: "readTaskRequest", requestId: "r1", sessionId: "s1" } as never);
    kernels[0]?.emit({ type: "turnSettled", sessionId: "s1", result: { ok: true, conversationId: 1, migration: "none", status: "done" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(!kernels[0]?.posted.some((command) => command.type === "shutdown"), "有请求挂着不回收");
    host.answerReadTask("r1", { ok: false, error: "x" } as never);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const shutdown = kernels[0]?.posted.find((command) => command.type === "shutdown");
    assert.ok(shutdown !== undefined && shutdown.type === "shutdown", "闲着到点：先让它收尾（关库）");
    assert.equal(host.kernelAlive(), false);
    // 回收期间插话：没有轮可插，退回通道开一轮；停止不为闲着的会话拉起进程
    host.steer("s1", "<channel>", "steer");
    void host.abort("s1");
    assert.deepEqual(bounced, ["s1"]);
    kernels[0]?.emit({ type: "shutdownDone", requestId: shutdown.requestId });
    await flush();
    assert.equal(kernels.length, 1, "回收后没有命令就不拉起");
    // 下一轮：懒拉起新进程（init 先于会话命令）
    const second = host.submit({ type: "submit", sessionId: "s1", text: "again", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    kernels[1]?.emit({ type: "ready" });
    await second;
    assert.equal(kernels.length, 2);
    assert.deepEqual(kernels[1]?.posted.map((command) => command.type), ["init", "session"]);
    assert.ok(!events.some((event) => event.type === "failed"), "回收不是崩溃：不报被打断");
    host.dispose();
  });

  test("kernel 闲置回收之后换模型：交给 agent 进程校验并报 model 事件（不能丢——meta 靠这个事件落新型号）", async () => {
    const kernels: FakeKernel[] = [];
    let agent!: FakeChild;
    const lane: KernelLane = { ...laneOf(() => {
      const next = new FakeKernel();
      kernels.push(next);
      return next;
    }), idleRecycleMs: 30 };
    const host = new AgentHostCore(() => {
      agent = new FakeChild();
      return agent;
    }, () => undefined, lane);
    const first = host.submit({ type: "submit", sessionId: "s1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    kernels[0]?.emit({ type: "ready" });
    await first;
    kernels[0]?.emit({ type: "turnSettled", sessionId: "s1", result: { ok: true, conversationId: 1, migration: "none", status: "done" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const shutdown = kernels[0]?.posted.find((command) => command.type === "shutdown");
    assert.ok(shutdown?.type === "shutdown");
    kernels[0]?.emit({ type: "shutdownDone", requestId: shutdown.requestId });
    await flush();
    assert.equal(host.kernelAlive(), false, "kernel 已闲置回收");
    const provider = { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k2", models: [] };
    const pending = host.setModel("s1", provider, "glm-5.3");
    await flush();
    agent.emit({ type: "ready" });
    await pending;
    assert.deepEqual(agent.posted.filter((command) => command.type === "setModel"), [{ type: "setModel", sessionId: "s1", provider, modelId: "glm-5.3" }]);
    assert.equal(kernels.length, 1, "不为换模型拉起 kernel");
    host.dispose();
  });

  test("kernelRunningSessions：交给 kernel 的轮在 turnSettled 之前都算在跑（窗口晚起来时据此补上 phase turn）", async () => {
    const r = kernelRig();
    const turn = r.host.submit({ type: "submit", sessionId: "c1", text: "hi", piSessionFile: "/p.jsonl", ...TURN_FIELDS });
    await flush();
    r.kernel.emit({ type: "ready" });
    await turn;
    assert.deepEqual(r.host.kernelRunningSessions(), ["c1"]);
    r.kernel.emit({ type: "turnSettled", sessionId: "c1", result: { ok: true, conversationId: 1, migration: "none", status: "done" } });
    assert.deepEqual(r.host.kernelRunningSessions(), []);
  });

  test("要迁一条大会话（本子 ≥ 16 MB）：发送那一刻就报 migration running（expected），kernel 开完这条会话时补 done；小的不报", async () => {
    const r = kernelRig({}, {}, { big: MIGRATION_HINT_BYTES, small: MIGRATION_HINT_BYTES - 1 });
    const big = r.host.submit({ type: "submit", sessionId: "big", text: "hi", piSessionFile: "/big.jsonl", ...TURN_FIELDS });
    const small = r.host.submit({ type: "submit", sessionId: "small", text: "hi", piSessionFile: "/small.jsonl", ...TURN_FIELDS });
    await flush();
    const migrations = () => r.events.flatMap((event) => (event.type === "migration" ? [`${event.sessionId}:${event.state}:${event.expected === true ? "expected" : ""}`] : []));
    assert.deepEqual(migrations(), ["big:running:expected"], "kernel 还没起来就已经报了，小的不报");
    r.kernel.emit({ type: "ready" });
    await big;
    await small;
    r.kernel.emit({ type: "created", sessionId: "big", piSessionFile: "/big.jsonl" });
    r.kernel.emit({ type: "created", sessionId: "small", piSessionFile: "/small.jsonl" });
    assert.deepEqual(migrations(), ["big:running:expected", "big:done:"]);
  });

  test("闲置回收不在在途的本子编辑、分支、删库收尾当中发生：到点先等它们回执，回执到了才回收", async () => {
    const kernels: FakeKernel[] = [];
    const lane: KernelLane = {
      fork: () => {
        const next = new FakeKernel();
        kernels.push(next);
        return next;
      },
      dir: "/durable",
      route: async (command): Promise<KernelTurnRoute> => ({ to: "kernel", root: command.sessionId }),
      editRoute: async (sessionId): Promise<KernelRoute> => ({ to: "kernel", root: sessionId }),
      settled: () => undefined,
      exited: () => undefined,
      idleRecycleMs: 30,
    };
    const host = new AgentHostCore(() => new FakeChild(), () => undefined, lane);
    const shutdowns = () => kernels[0]?.posted.filter((command) => command.type === "shutdown").length ?? 0;
    // 本子编辑（回退）在途：kernel 还没回 piBookEdited
    const revert = host.editPiBook({ type: "revertPiBook", sessionId: "s1", sourcePiSessionFile: "/p", cwd: "/", roles: ["user", "assistant"], targetMessageId: "m" });
    await flush();
    kernels[0]?.emit({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(shutdowns(), 0, "回退在途不回收");
    // 分支在途：kernel 还没回 created
    const branch = host.branchSession({ sourcePiSessionFile: "/p", cwd: "/", roles: ["user", "assistant"] }, "fresh", "s1");
    kernels[0]?.emit({ type: "piBookEdited", sessionId: "s1", edit: "revert" });
    await revert;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(shutdowns(), 0, "分支在途不回收");
    kernels[0]?.emit({ type: "created", sessionId: "fresh", piSessionFile: "durable:fresh" });
    await branch;
    // 删库的收尾在途（kernel 还没回 dropped）
    const drop = host.dropKernelLibrary("s1.sqlite");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(shutdowns(), 0, "删库收尾在途不回收");
    const dropMessage = kernels[0]?.posted.find((command) => command.type === "drop");
    assert.ok(dropMessage?.type === "drop");
    kernels[0]?.emit({ type: "dropped", requestId: dropMessage.requestId });
    assert.equal(await drop, true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(shutdowns(), 1, "都回执了、闲着到点：回收");
    host.dispose();
  });
});
