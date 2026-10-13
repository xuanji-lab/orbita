/**
 * AgentHostCore 的回归网 —— 债务 B 的三处竞态，这里盖住前两处：
 *   #1 pendingCreates（创建请求与 created 事件的竞态）
 *   #2 内建 provider 目录的到达时机竞态
 * （#3 跨会话事件串台由 session-states.test.ts 的 A/B 交错用例盖住。）
 *
 * 真子进程是 Electron 的 utilityProcess，测试里换成脚本化的假货：命令记进
 * `posted`，runtime 事件由测试手动 `emit`。createSession / listBuiltins 内部的
 * 超时兜底是真 setTimeout——不 mock 的话 node --test 会挂到计时器走完才退。
 *
 * 时序约定：createSession 在 `await ensure()` 处挂起，ready 事件只是 resolve 了
 * 那个 promise，**注册 pendingCreates、发出 create 命令是之后一跳的微任务**——
 * 所以 emit(ready) 之后必须先 `await flush()` 再喂后续事件，否则事件落空、
 * promise 永远不结。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentCommand, AgentEvent } from "../../shared/agent-ipc.ts";
import { AgentHostCore, type AgentChild } from "./host-core.ts";

/** 脚本化的假子进程。 */
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

const TURN_FIELDS = {
  cwd: "C:/work",
  provider: { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k", models: [{ id: "m" }] },
  modelId: "m",
  mode: "manual" as const,
  thinkingLevel: "medium" as const,
  piSessionDir: "C:/pi-sessions",
  attachmentsDir: "C:/sessions/test.attachments",
  protectedPaths: ["C:/pi-sessions"],
  skillsDirs: ["C:/skills"],
  workspaceId: null,
  mcpServers: {},
};

/** 首轮 submit（不带 piSessionFile）：host 等 created 才返回，与旧 create 同构。 */
function firstSubmit(host: AgentHostCore, sessionId: string, text = "hi") {
  return host.submit({ type: "submit", sessionId, text, ...TURN_FIELDS });
}

/** 排空微任务队列——emit(ready) 之后 host 的续体（注册 pending、发命令）要等一跳才跑。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function freshHost(): Promise<{
  host: AgentHostCore;
  child: () => FakeChild;
  forks: () => number;
  events: AgentEvent[];
}> {
  let child!: FakeChild;
  let forks = 0;
  const events: AgentEvent[] = [];
  const host = new AgentHostCore(
    () => {
      forks += 1;
      child = new FakeChild();
      return child;
    },
    (event) => events.push(event),
  );
  return { host, child: () => child, forks: () => forks, events };
}

describe("pendingCreates —— 首轮开机与 created 事件的竞态（债务 B #1）", () => {
  test("created 到了才返回，piSessionFile 原样交回", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: "pi/abc.jsonl" });
    assert.equal(await pending, "pi/abc.jsonl");
    assert.equal(ctx.child().posted[0]?.type, "submit");
  });

  test("续轮（piSessionFile 已带）：不等 created，发完即回 null", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = ctx.host.submit({
      type: "submit",
      sessionId: "s1",
      text: "hi",
      ...TURN_FIELDS,
      piSessionFile: "pi/abc.jsonl",
    });
    ctx.child().emit({ type: "ready" });
    await flush();
    // 没等 created 就返回了；命令带着完整开工上下文
    assert.equal(await pending, null);
    assert.deepEqual(ctx.child().posted[0], {
      type: "submit",
      sessionId: "s1",
      text: "hi",
      ...TURN_FIELDS,
      piSessionFile: "pi/abc.jsonl",
    });
  });

  test("无等待者的 created（续轮自愈）：转发 onEvent 给主进程钩子", async (t) => {
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

  test("failed 带同一个 sessionId —— 错误交回调用方，不是只广播一条事件", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "failed", sessionId: "s1", message: "no provider" });
    await assert.rejects(pending, /no provider/);
  });

  test("branchSession：created 回分支文件；对账失败经 failed 拒绝（C-2 共用同一条等待通路）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const ok = ctx.host.branchSession(
      { sourcePiSessionFile: "pi/src.jsonl", cwd: "C:/work", roles: ["user", "assistant"] },
      "s9",
    );
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

    const rejected = ctx.host.branchSession(
      { sourcePiSessionFile: "pi/src.jsonl", cwd: "C:/work", roles: ["user"] },
      "s8",
    );
    await flush();
    ctx.child().emit({ type: "failed", sessionId: "s8", message: "两本账对不上" });
    await assert.rejects(rejected, /两本账对不上/);
  });

  test("pending 中进程退出 —— 全部 reject、广播 failed(null)、下次 ensure 重新 fork", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const first = firstSubmit(ctx.host, "s1");
    const second = firstSubmit(ctx.host, "s2");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().exitWith(1);

    await assert.rejects(first, /exited with code 1/);
    await assert.rejects(second, /exited with code 1/);
    assert.ok(
      ctx.events.some(
        (event) =>
          event.type === "failed" && event.sessionId === null && /code 1/.test(event.message),
      ),
    );

    // 进程死了不等于 host 死了：下一次用时重新 fork
    const again = firstSubmit(ctx.host, "s3");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s3", piSessionFile: null });
    assert.equal(await again, null);
    assert.equal(ctx.forks(), 2);
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
});

describe("disposeSession —— 会话释放（刀 0-4 债务 A）", () => {
  test("从未启动过 agent：不拉起进程、不抛错（懒启动不破）", async () => {
    const ctx = await freshHost();
    ctx.host.disposeSession("never-created");
    assert.equal(ctx.forks(), 0);
  });

  test("活着就发 dispose 命令；进程已死就静默", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    ctx.host.disposeSession("s1");
    assert.deepEqual(ctx.child().posted.at(-1), { type: "dispose", sessionId: "s1" });

    ctx.host.dispose(); // kill → exit → child 置空
    ctx.host.disposeSession("s1"); // 不抛
  });

  test("建 3 条销 3 条 —— 每条都收到 dispose 命令（清单验收的等价形式）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    for (const id of ["s1", "s2", "s3"]) {
      const pending = firstSubmit(ctx.host, id);
      ctx.child().emit({ type: "ready" });
      await flush();
      ctx.child().emit({ type: "created", sessionId: id, piSessionFile: null });
      await pending;
      ctx.host.disposeSession(id);
    }
    const disposed = ctx
      .child()
      .posted.filter((command) => command.type === "dispose")
      .map((command) => (command as { sessionId: string }).sessionId);
    assert.deepEqual(disposed, ["s1", "s2", "s3"]);
  });
});

describe("generateTitle —— 标题生成的发送侧（C-3）", () => {
  test("从未启动过 agent：不拉起进程、不抛错——标题不值得为它 fork", async () => {
    const ctx = await freshHost();
    ctx.host.generateTitle("s1", "第一句");
    assert.equal(ctx.forks(), 0);
  });

  test("活着就发 generateTitle 命令，文本原样带上", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    ctx.host.generateTitle("s1", "把登录按钮修一下");
    assert.deepEqual(ctx.child().posted.at(-1), {
      type: "generateTitle",
      sessionId: "s1",
      text: "把登录按钮修一下",
    });
  });
});

describe("setModel —— 会话内换模型的发送侧（C-4）", () => {
  test("ensure 后发命令，provider 载荷与 modelId 原样带上", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    const provider = { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k2", models: [] };
    await ctx.host.setModel("s1", provider, "glm-5.3");
    assert.deepEqual(ctx.child().posted.at(-1), {
      type: "setModel",
      sessionId: "s1",
      provider,
      modelId: "glm-5.3",
    });
  });
});

describe("answerIntentConfirm —— 意图确认卡应答的发送侧", () => {
  test("进程在时按 requestId 原样转给 runtime；进程没了就静默（不 ensure）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const decision = { action: "confirm" as const, answers: [{ askId: "a1", verdict: "yes" as const }], note: "" };
    ctx.host.answerIntentConfirm("q0", decision);
    assert.equal(ctx.forks(), 0);

    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    ctx.host.answerIntentConfirm("q1", decision);
    assert.equal(ctx.forks(), 1);
    assert.deepEqual(ctx.child().posted.at(-1), { type: "intentConfirmResult", requestId: "q1", decision });
  });
});

describe("answerReadTask —— 读 task 请求的发送侧（B-1）", () => {
  test("成功回执带 card 与 text；失败回执只带 error；进程没了就静默（不 ensure）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    // 没开机时静默：不为一条回执拉起整个 runtime（answerPermission 同款理由）
    ctx.host.answerReadTask("r0", { ok: false, error: "gone" });
    assert.equal(ctx.forks(), 0);
    assert.equal(ctx.child(), undefined);

    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    ctx.host.answerReadTask("r1", {
      ok: true,
      card: { sessionId: "t-1", title: "Demo", mode: "briefing", roundCount: 3 },
      text: "Task \"Demo\"…",
    });
    ctx.host.answerReadTask("r2", { ok: false, error: "No task matches" });
    assert.equal(ctx.forks(), 1); // 不二次 fork
    assert.deepEqual(ctx.child().posted.at(-2), {
      type: "readTaskResult",
      requestId: "r1",
      ok: true,
      card: { sessionId: "t-1", title: "Demo", mode: "briefing", roundCount: 3 },
      text: "Task \"Demo\"…",
    });
    assert.deepEqual(ctx.child().posted.at(-1), {
      type: "readTaskResult",
      requestId: "r2",
      ok: false,
      error: "No task matches",
    });
  });
});

describe("steer —— 父→子注入的发送侧（子会话）", () => {
  test("进程活着就发 steer 命令，delivery 原样带上", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    ctx.host.steer("s1", "先别改这个文件", "followUp");
    assert.deepEqual(ctx.child().posted.at(-1), {
      type: "steer",
      sessionId: "s1",
      text: "先别改这个文件",
      delivery: "followUp",
    });
  });

  test("进程没起（或已死）就抛——调用方（deliverToChild）据此按投递失败处理", async () => {
    const ctx = await freshHost();
    assert.throws(() => ctx.host.steer("s1", "x", "steer"), /agent runtime is not running/);
  });
});

describe("answerDelegate / answerChannelSend —— 子会话请求的回执", () => {
  test("answerDelegate：成功带 childId/title/card，失败只带 error；进程没了就静默", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    // 没开机时静默：不为一条回执拉起整个 runtime
    ctx.host.answerDelegate("r0", { ok: false, error: "gone" });
    assert.equal(ctx.forks(), 0);

    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    const card = { childId: "c1", title: "调研分支", modelId: "m", thinkingLevel: "medium" as const, workbench: "/wb/c1" };
    ctx.host.answerDelegate("r1", { ok: true, childId: "c1", title: "调研分支", card });
    ctx.host.answerDelegate("r2", { ok: false, error: "empty task" });
    assert.deepEqual(ctx.child().posted.at(-2), {
      type: "delegateResult",
      requestId: "r1",
      ok: true,
      childId: "c1",
      title: "调研分支",
      card,
    });
    assert.deepEqual(ctx.child().posted.at(-1), {
      type: "delegateResult",
      requestId: "r2",
      ok: false,
      error: "empty task",
    });
  });

  test("answerChannelSend：成功带 messageId，失败只带 error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;

    ctx.host.answerChannelSend("r1", { ok: true, messageId: "m1" });
    ctx.host.answerChannelSend("r2", { ok: false, error: "kind not allowed" });
    assert.deepEqual(ctx.child().posted.at(-2), {
      type: "channelSendResult",
      requestId: "r1",
      ok: true,
      messageId: "m1",
    });
    assert.deepEqual(ctx.child().posted.at(-1), {
      type: "channelSendResult",
      requestId: "r2",
      ok: false,
      error: "kind not allowed",
    });
  });
});

describe("classifyGreetings（迁移的「只随手发了一句」检查）", () => {
  test("按 requestId 结回执：判中的下标 resolve；判不了 reject 带原因；回执不广播给窗口", async () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    const host = new AgentHostCore(() => child, (event) => events.push(event));
    const first = host.classifyGreetings(TURN_FIELDS.provider, "m", ["hi", "fix the build"]);
    child.emit({ type: "ready" });
    await flush();
    const second = host.classifyGreetings(TURN_FIELDS.provider, "m", ["test"]);
    await flush();
    const commands = child.posted.filter(
      (command): command is Extract<AgentCommand, { type: "classifyGreetings" }> => command.type === "classifyGreetings",
    );
    assert.deepEqual(commands.map((command) => command.messages), [["hi", "fix the build"], ["test"]]);
    child.emit({ type: "greetingsClassified", requestId: commands[1]!.requestId, throwaway: null, error: "rate limited" });
    child.emit({ type: "greetingsClassified", requestId: commands[0]!.requestId, throwaway: [0] });
    assert.deepEqual(await first, [0]);
    await assert.rejects(second, /rate limited/);
    assert.equal(events.length, 0);
  });

  test("进程退出：在等的检查 reject", async () => {
    const child = new FakeChild();
    const host = new AgentHostCore(() => child, () => undefined);
    const pending = host.classifyGreetings(TURN_FIELDS.provider, "m", ["hi"]);
    child.emit({ type: "ready" });
    await flush();
    child.exitWith(1);
    await assert.rejects(pending, /exited/);
  });
});

describe("probeProvider（Test 的 OAuth 路由）", () => {
  test("按 requestId 结回执：结果原样 resolve；回执不广播给窗口；进程退出 reject", async () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    const host = new AgentHostCore(() => child, (event) => events.push(event));
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
  /** 先把进程拉起来（mcpReload 不 ensure：进程没起直接 resolve，没有等待者） */
  async function runningHost(): Promise<{ host: AgentHostCore; child: () => FakeChild }> {
    const ctx = await freshHost();
    const pending = firstSubmit(ctx.host, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: null });
    await pending;
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
});
