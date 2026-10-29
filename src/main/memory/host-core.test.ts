/**
 * MemoryServiceHostCore ——拉起 / 转发 / 超时与崩溃回空。纯模块直测
 * （node --test）：fork 用脚本假货顶上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryServiceHostCore, type MemoryChild } from "./host-core.ts";
import type { MemoryBackfillProgress, MemoryDownloadProgress, MemoryServiceMessage } from "../../shared/memory.ts";

/** 脚本假子进程：ready 要主进程等、消息可注入、kill 可观察。 */
class FakeChild implements MemoryChild {
  listeners = new Map<string, ((payload: unknown) => void)[]>();
  posted: unknown[] = [];
  killed = false;
  private readonly behavior: { readyAfterMs?: number };
  constructor(behavior: { readyAfterMs?: number }) {
    this.behavior = behavior;
  }
  on(event: string, listener: (payload: never) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (payload: unknown) => void);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: "message", message: MemoryServiceMessage): void {
    for (const listener of this.listeners.get("message") ?? []) listener(message);
  }
  exit(code: number): void {
    for (const listener of this.listeners.get("exit") ?? []) listener(code);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  kill(): void {
    this.killed = true;
  }
  async waitReady(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.behavior.readyAfterMs ?? 0));
    this.emit("message", { type: "ready" });
  }
}

function host(childRef: { current: FakeChild | null }, readyDelayMs = 0): MemoryServiceHostCore {
  return new MemoryServiceHostCore({
    forkRuntime: () => {
      const child = new FakeChild({ readyAfterMs: readyDelayMs });
      childRef.current = child;
      void child.waitReady();
      return child;
    },
    dir: "/tmp/memory-dir",
    recallTimeoutMs: 30,
    log: () => undefined,
  });
}

test("ensureStarted：ready 后发 init（带目录与 chore）；重复调用不重拉", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const h = host(ref);
  assert.equal(await h.ensureStarted(), true);
  assert.equal(await h.ensureStarted(), true);
  const posted = ref.current!.posted[0] as { type: string; dir: string };
  assert.equal(posted.type, "init");
  assert.equal(posted.dir, "/tmp/memory-dir");
});

test("recall：回执配对；超时回空命中；服务不在直接空命中", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const h = host(ref);
  assert.deepEqual(await h.recall({ sessionId: "s", scopeId: "w", turn: 1, query: "q" }), []); // 没起
  await h.ensureStarted();
  const pending = h.recall({ sessionId: "s", scopeId: "w", turn: 1, query: "q" });
  const sent = ref.current!.posted[1] as { type: string; requestId: string };
  assert.equal(sent.type, "recall");
  ref.current!.emit("message", { type: "recallResult", requestId: sent.requestId, hits: [] });
  assert.deepEqual(await pending, []);
  // 不回执 → 超时（30ms）回空命中
  const slow = h.recall({ sessionId: "s", scopeId: "w", turn: 2, query: "q" });
  assert.deepEqual(await slow, []);
});

test("子进程退出：在途召回回空、状态复位，下次 ensureStarted 重拉", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const h = host(ref);
  await h.ensureStarted();
  const first = ref.current!;
  const pending = h.recall({ sessionId: "s", scopeId: "w", turn: 1, query: "q" });
  first.exit(1);
  assert.deepEqual(await pending, []);
  assert.equal(h.isRunning(), false);
  assert.equal(first.killed, false); // 已经死了，不再补刀
  assert.equal(await h.ensureStarted(), true);
  assert.notEqual(ref.current, first);
});

test("stop：主动 kill + 在途回空", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const h = host(ref);
  await h.ensureStarted();
  const pending = h.recall({ sessionId: "s", scopeId: "w", turn: 1, query: "q" });
  h.stop();
  assert.deepEqual(await pending, []);
  assert.equal(ref.current!.killed, true);
  assert.equal(h.isRunning(), false);
});

test("turnSettled：服务不在就丢（构建是易耗品）；在就转发", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const h = host(ref);
  h.turnSettled({ sessionId: "s", scopeId: "w", turn: 1, at: 1, userText: "u", assistantText: "a" });
  assert.equal(ref.current, null); // 没起进程，什么都没发
  await h.ensureStarted();
  h.turnSettled({
    sessionId: "s",
    scopeId: "w",
    turn: 1,
    at: 1,
    userText: "u",
    assistantText: "a",
    chore: { provider: { id: "p", api: "openai", baseUrl: "https://x", apiKey: "k", models: [] }, modelId: "m" },
  });
  const sent = ref.current!.posted[1] as { type: string; turn: number };
  assert.equal(sent.type, "turnSettled");
  assert.equal(sent.turn, 1);
});

test("向量控制与进度：配置 / 电源 / 下载转发，状态回执配对且超时回 null", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const downloads: MemoryDownloadProgress[] = [];
  const backfills: MemoryBackfillProgress[] = [];
  const h = new MemoryServiceHostCore({
    forkRuntime: () => {
      const child = new FakeChild({});
      ref.current = child;
      void child.waitReady();
      return child;
    },
    dir: "/tmp/memory-dir",
    vectorStateTimeoutMs: 20,
    onDownloadProgress: (progress) => downloads.push(progress),
    onBackfillProgress: (progress) => backfills.push(progress),
    log: () => undefined,
  });
  await h.ensureStarted();
  h.setVectorConfig(null);
  h.setPower(true);
  h.startModelDownload({
    sources: ["https://example.test/model.gguf"],
    targetPath: "/tmp/model.gguf",
    sha256: "0".repeat(64),
    sizeBytes: 10,
  });
  assert.deepEqual(
    ref.current!.posted.slice(1).map((message) => (message as { type: string }).type),
    ["setVectorConfig", "setPower", "startModelDownload"],
  );

  ref.current!.emit("message", {
    type: "downloadProgress",
    progress: {
      requestId: "d1",
      phase: "downloading",
      source: "https://example.test/model.gguf",
      received: 5,
      total: 10,
    },
  });
  ref.current!.emit("message", {
    type: "backfillProgress",
    progress: { state: "running", done: 2, total: 5 },
  });
  assert.equal(downloads.length, 1);
  assert.equal(backfills[0]?.done, 2);

  const pending = h.vectorState();
  const request = ref.current!.posted.find(
    (message): message is { type: "vectorState"; requestId: string } =>
      (message as { type: string }).type === "vectorState",
  );
  assert.ok(request !== undefined);
  ref.current!.emit("message", {
    type: "vectorStateResult",
    requestId: request.requestId,
    llamaRunning: true,
    backfill: { state: "running", done: 2, total: 5 },
    vectors: { model: "m1", dims: 768, entries: 2 },
  });
  assert.deepEqual(await pending, {
    llamaRunning: true,
    backfill: { state: "running", done: 2, total: 5 },
    vectors: { model: "m1", dims: 768, entries: 2 },
  });
  assert.equal(await h.vectorState(), null);
});

test("mutate：回执配对；超时与服务不在回 ok:false；changed 回调被触发", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const changes: number[] = [];
  const h = new MemoryServiceHostCore({
    forkRuntime: () => {
      const child = new FakeChild({});
      ref.current = child;
      void child.waitReady();
      return child;
    },
    dir: "/tmp/memory-dir",
    recallTimeoutMs: 30,
    mutateTimeoutMs: 30,
    onChanged: () => changes.push(1),
    log: () => undefined,
  });
  // 服务不在：直接 ok:false，不 fork
  const offline = await h.mutate({ op: "remove", token: "user", entryId: "mem_x" });
  assert.equal(offline.ok, false);
  await h.ensureStarted();
  // 正常回执：ok 双分支原样透传
  const pending = h.mutate({ op: "edit", token: "user", entryId: "mem_1", text: "新正文" });
  const sent = ref.current!.posted[1] as { type: string; requestId: string; mutation: { op: string } };
  assert.equal(sent.type, "mutate");
  assert.equal(sent.mutation.op, "edit");
  ref.current!.emit("message", {
    type: "mutateResult",
    requestId: sent.requestId,
    ok: true,
    entry: { id: "mem_1", text: "新正文" } as never,
  });
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  // 服务侧写盘通知：changed → onChanged
  ref.current!.emit("message", { type: "changed" });
  assert.equal(changes.length, 1);
  // 超时：ok:false 带一句人话
  const slow = h.mutate({ op: "remove", token: "user", entryId: "mem_2" });
  assert.equal((await slow).ok, false);
  // 崩溃：在途 mutate 回 ok:false
  const inFlight = h.mutate({ op: "remove", token: "user", entryId: "mem_3" });
  ref.current!.exit(1);
  assert.equal((await inFlight).ok, false);
});

test("agentTool：回执配对透传；服务不在 / 超时 / 崩溃回 ok:false", async () => {
  const ref: { current: FakeChild | null } = { current: null };
  const h = new MemoryServiceHostCore({
    forkRuntime: () => {
      const child = new FakeChild({});
      ref.current = child;
      void child.waitReady();
      return child;
    },
    dir: "/tmp/memory-dir",
    mutateTimeoutMs: 30,
    log: () => undefined,
  });
  const input = { sessionId: "s1", scopeId: "ws-1", turn: 2, call: { op: "search" as const, query: "汇报" } };
  assert.equal((await h.agentTool(input)).ok, false); // 服务不在
  await h.ensureStarted();
  const pending = h.agentTool(input);
  const sent = ref.current!.posted[1] as { type: string; requestId: string; scopeId: string; call: { op: string } };
  assert.equal(sent.type, "agentTool");
  assert.equal(sent.scopeId, "ws-1");
  assert.equal(sent.call.op, "search");
  ref.current!.emit("message", { type: "agentToolResult", requestId: sent.requestId, ok: true, entries: [] });
  assert.deepEqual(await pending, { ok: true, entries: [] });
  assert.equal((await h.agentTool(input)).ok, false); // 超时
  const inFlight = h.agentTool(input);
  ref.current!.exit(1);
  assert.equal((await inFlight).ok, false); // 崩溃
});

/** 带 pid 补杀观察与 fork 计数的 host（#2 / #8 的回归）。 */
function hostWithKill() {
  const ref: { current: FakeChild | null } = { current: null };
  const killedPids: number[] = [];
  let forks = 0;
  const h = new MemoryServiceHostCore({
    forkRuntime: () => {
      forks += 1;
      const child = new FakeChild({});
      ref.current = child;
      void child.waitReady();
      return child;
    },
    dir: "/tmp/memory-dir",
    recallTimeoutMs: 30,
    log: () => undefined,
    killPid: (pid) => killedPids.push(pid),
  });
  return { h, ref, killedPids, forks: () => forks };
}

test("stop：先发 shutdown，再按服务报来的 pid 补杀 llama-server，最后 kill 服务", async () => {
  const { h, ref, killedPids } = hostWithKill();
  await h.ensureStarted();
  const child = ref.current!;
  child.emit("message", { type: "embedServerPid", pid: 4242 });
  h.stop();
  assert.deepEqual(child.posted.at(-1), { type: "shutdown" });
  assert.deepEqual(killedPids, [4242]);
  assert.equal(child.killed, true);
  // 再停一次不重复补杀（pid 已清）
  h.stop();
  assert.deepEqual(killedPids, [4242]);
});

test("服务自己崩了：同样按 pid 补杀 llama-server（它不会随服务退出）；引擎已退报 null 则不杀", async () => {
  const { h, ref, killedPids } = hostWithKill();
  await h.ensureStarted();
  ref.current!.emit("message", { type: "embedServerPid", pid: 7 });
  ref.current!.exit(1);
  assert.deepEqual(killedPids, [7]);
  await h.ensureStarted();
  ref.current!.emit("message", { type: "embedServerPid", pid: 8 });
  ref.current!.emit("message", { type: "embedServerPid", pid: null });
  ref.current!.exit(1);
  assert.deepEqual(killedPids, [7]);
});

test("initFailed：停掉服务并记住失败，之后不再每轮重拉；stop（开关关）后才重试", async () => {
  const { h, ref, forks } = hostWithKill();
  assert.equal(await h.ensureStarted(), true);
  const first = ref.current!;
  first.emit("message", { type: "initFailed", error: "EACCES" });
  assert.equal(first.killed, true);
  assert.equal(h.isRunning(), false);
  for (let turn = 0; turn < 3; turn += 1) assert.equal(await h.ensureStarted(), false);
  assert.equal(forks(), 1);
  const outcome = await h.mutate({ op: "remove", token: "user", entryId: "mem_1" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /初始化失败：EACCES/);
  h.stop();
  assert.equal(await h.ensureStarted(), true);
  assert.equal(forks(), 2);
});
