/**
 * MemoryServiceHostCore ——拉起 / 转发 / 超时与崩溃回空。纯模块直测
 * （node --test）：fork 用脚本假货顶上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryServiceHostCore, type MemoryChild } from "./host-core.ts";
import type { MemoryServiceMessage } from "../../shared/memory.ts";

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
