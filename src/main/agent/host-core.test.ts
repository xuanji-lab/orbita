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

const CREATE_INPUT = {
  cwd: "C:/work",
  provider: { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k", models: ["m"] },
  modelId: "m",
  mode: "manual" as const,
  piSessionDir: "C:/pi-sessions",
};

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

describe("pendingCreates —— 创建请求与 created 事件的竞态（债务 B #1）", () => {
  test("created 到了才返回，piSessionFile 原样交回", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = ctx.host.createSession(CREATE_INPUT, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s1", piSessionFile: "pi/abc.jsonl" });
    assert.deepEqual(await pending, { sessionId: "s1", piSessionFile: "pi/abc.jsonl" });
    assert.equal(ctx.child().posted[0]?.type, "create");
  });

  test("failed 带同一个 sessionId —— 错误交回调用方，不是只广播一条事件", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const pending = ctx.host.createSession(CREATE_INPUT, "s1");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "failed", sessionId: "s1", message: "no provider" });
    await assert.rejects(pending, /no provider/);
  });

  test("pending 中进程退出 —— 全部 reject、广播 failed(null)、下次 ensure 重新 fork", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctx = await freshHost();
    const first = ctx.host.createSession(CREATE_INPUT, "s1");
    const second = ctx.host.createSession(CREATE_INPUT, "s2");
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
    const again = ctx.host.createSession(CREATE_INPUT, "s3");
    ctx.child().emit({ type: "ready" });
    await flush();
    ctx.child().emit({ type: "created", sessionId: "s3", piSessionFile: null });
    assert.deepEqual(await again, { sessionId: "s3", piSessionFile: null });
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
        models: ["m"],
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
    const pending = ctx.host.createSession(CREATE_INPUT, "s1");
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
      const pending = ctx.host.createSession(CREATE_INPUT, id);
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
