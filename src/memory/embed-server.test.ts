/**
 * llama-server 生命周期核（embed-server.ts）——拉起等健康、embed 转发、
 * 失败退 null、空闲卸载、换模型重启。纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EmbedServerCore, type EmbedServerChild } from "./embed-server.ts";

const MODEL = {
  id: "m1",
  modelPath: "/models/m1.gguf",
  pooling: "mean" as const,
  ctx: 8192,
  queryPrefix: "q: ",
  docPrefix: "d: ",
  dims: 4,
};

class FakeChild implements EmbedServerChild {
  exited = false;
  killCount = 0;
  private readonly listeners: ((code: number | null) => void)[] = [];
  on(event: "exit", listener: (code: number | null) => void): unknown {
    this.listeners.push(listener);
    return this;
  }
  die(): void {
    this.exited = true;
    for (const listener of this.listeners) listener(1);
  }
  kill(): void {
    this.killCount += 1;
    this.die();
  }
}

function makeServer(overrides: {
  probeOk?: boolean;
  probe?: (port: number) => Promise<boolean>;
  post?: (texts: readonly string[]) => number[][] | Promise<number[][]>;
  resolve?: () => { binaryPath: string; model: typeof MODEL } | null;
  idleMs?: number;
}) {
  const children: FakeChild[] = [];
  const spawnedArgs: string[][] = [];
  const core = new EmbedServerCore({
    resolve:
      overrides.resolve ??
      (() => ({ binaryPath: "/bin/llama-server", model: MODEL })),
    spawn: (args) => {
      spawnedArgs.push([...args]);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    probe: overrides.probe ?? (async () => overrides.probeOk ?? true),
    post: async (_port, texts) => (overrides.post ?? ((input) => input.map(() => [1, 0, 0, 0])))(texts),
    freePort: async () => 8123,
    idleUnloadMs: overrides.idleMs ?? 60_000,
    log: () => undefined,
  });
  return { core, children, spawnedArgs };
}

test("ready→embed：spawn 带模型参数（pooling/ctx/embedding），向量归一化", async () => {
  const { core, children, spawnedArgs } = makeServer({});
  assert.equal(await core.ready(), true);
  assert.equal(children.length, 1);
  const args = spawnedArgs[0]!;
  assert.equal(args[0], "/bin/llama-server");
  assert.ok(args.includes("--embedding"));
  assert.deepEqual(args.slice(args.indexOf("--port"), args.indexOf("--port") + 2), ["--port", "8123"]);
  assert.deepEqual(args.slice(args.indexOf("--pooling"), args.indexOf("--pooling") + 2), ["--pooling", "mean"]);
  const vectors = await core.embed(["a", "b"]);
  assert.equal(vectors?.length, 2);
  // [1,0,0,0] 已是单位向量，归一化不变
  assert.deepEqual(Array.from(vectors![0]!), [1, 0, 0, 0]);
  assert.equal(core.isRunning(), true);
});

test("resolve null（未启用）与 spawn 后健康超时：embed 返回 null", async () => {
  const off = makeServer({ resolve: () => null });
  assert.equal(await off.core.ready(), false);
  assert.equal(await off.core.embed(["a"]), null);

  const sick = new EmbedServerCore({
    resolve: () => ({ binaryPath: "/bin/llama-server", model: MODEL }),
    spawn: () => new FakeChild(),
    probe: async () => false, // 永远不健康
    post: async () => [],
    freePort: async () => 1,
    startTimeoutMs: 50,
    log: () => undefined,
  });
  assert.equal(await sick.ready(), false);
  assert.equal(sick.isRunning(), false); // 超时后自清理
  assert.equal(await sick.embed(["a"]), null);
});

test("post 抛错：停进程回 null（下一轮 ready 重拉）", async () => {
  let fail = false;
  const { core, children } = makeServer({ post: () => { if (fail) throw new Error("boom"); return [[1, 0, 0, 0]]; } });
  assert.equal((await core.embed(["a"])) !== null, true);
  fail = true;
  assert.equal(await core.embed(["a"]), null);
  assert.equal(core.isRunning(), false);
  assert.ok(children[0]!.killCount >= 1);
});

test("空闲卸载：运行中改 idleMs 也生效；再有 embed 重新拉起", async () => {
  const { core, children } = makeServer({ idleMs: 60_000 });
  assert.equal((await core.embed(["a"])) !== null, true);
  core.setIdleUnloadMs(30);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(core.isRunning(), false);
  assert.ok(children[0]!.killCount >= 1);
  // 重拉
  assert.equal((await core.embed(["a"])) !== null, true);
  assert.equal(children.length, 2);
});

test("空闲卸载：嵌入请求在途时停表，结束后才重新计时", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { core, children } = makeServer({
    idleMs: 30,
    post: async (texts) => {
      await gate;
      return texts.map(() => [1, 0, 0, 0]);
    },
  });
  const pending = core.embed(["慢请求"]);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(core.isRunning(), true);
  assert.equal(children[0]!.killCount, 0);
  release();
  assert.notEqual(await pending, null);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(core.isRunning(), false);
});

test("健康检查中的并发 ready 共享同一 promise，不提前报就绪", async () => {
  const health: { release: () => void } = { release: () => undefined };
  const healthGate = new Promise<void>((resolve) => {
    health.release = resolve;
  });
  const { core, children } = makeServer({
    probe: async () => {
      await healthGate;
      return true;
    },
  });
  const first = core.ready();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = core.ready();
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondSettled, false);
  assert.equal(core.isRunning(), false);
  assert.equal(children.length, 1);
  health.release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(core.isRunning(), true);
  assert.equal(children.length, 1);
});

test("换模型：resolve 返回不同 id 时先停旧进程再拉新的", async () => {
  let modelId = "m1";
  const { core, children } = makeServer({
    resolve: () => ({ binaryPath: "/bin/llama-server", model: { ...MODEL, id: modelId } }),
  });
  assert.equal(await core.ready(), true);
  modelId = "m2";
  assert.equal(await core.ready(), true);
  assert.equal(children.length, 2);
  assert.ok(children[0]!.killCount >= 1);
});
