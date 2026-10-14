import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTabLedger, agentTabNotice, type AgentTabLedgerOptions } from "./agent-tab-ledger.ts";

const IDLE_MS = 15 * 60_000;

/** 可拨的时钟：测试里手动推进 */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

function ledger(options: Partial<AgentTabLedgerOptions> & { now: () => number }): AgentTabLedger {
  return new AgentTabLedger({ idleMs: IDLE_MS, maxTabs: 8, ...options });
}

test("register / touch / forget：账本只记有 tab 的会话，touch 不凭空建账", () => {
  const time = clock();
  const book = ledger({ now: time.now });
  assert.equal(book.size(), 0);
  book.touch("ghost");
  assert.equal(book.size(), 0, "没有 tab 的会话不该被记进账本");
  book.register("a");
  assert.equal(book.size(), 1);
  book.forget("a");
  assert.equal(book.size(), 0);
});

test("闲置边界：恰好 idleMs 就回收，差 1ms 不回收", () => {
  const time = clock();
  const book = ledger({ now: time.now });
  book.register("a");
  time.advance(IDLE_MS - 1);
  assert.deepEqual(book.reclaimable(), [], "差 1 毫秒还没到点");
  time.advance(1);
  assert.deepEqual(book.reclaimable(), [{ sessionId: "a", reason: "idle" }], "到点即回收");
});

test("touch 刷新活跃时间：正在被请求的 tab 不因闲置被回收", () => {
  const time = clock();
  const book = ledger({ now: time.now });
  book.register("a");
  time.advance(IDLE_MS - 1);
  book.touch("a");
  time.advance(IDLE_MS - 1);
  assert.deepEqual(book.reclaimable(), [], "touch 把窗口重新推满");
  time.advance(1);
  assert.deepEqual(book.reclaimable(), [{ sessionId: "a", reason: "idle" }]);
});

test("多个闲置：最久未活跃的在前（整体 LRU 顺序）", () => {
  const time = clock();
  const book = ledger({ now: time.now });
  book.register("old");
  time.advance(1000);
  book.register("mid");
  time.advance(1000);
  book.register("new");
  time.advance(IDLE_MS);
  assert.deepEqual(book.reclaimable(), [
    { sessionId: "old", reason: "idle" },
    { sessionId: "mid", reason: "idle" },
    { sessionId: "new", reason: "idle" },
  ]);
});

test("恰好到上限：不淘汰（size == maxTabs 且没有闲置）", () => {
  const time = clock();
  const book = ledger({ now: time.now, maxTabs: 2 });
  book.register("a");
  book.register("b");
  assert.equal(book.size(), 2);
  assert.deepEqual(book.reclaimable(), [], "到上限不等于超上限");
});

test("超过上限：按 LRU 淘汰最旧的，原因记 evicted", () => {
  const time = clock();
  const book = ledger({ now: time.now, maxTabs: 2 });
  book.register("old");
  time.advance(1000);
  book.register("mid");
  time.advance(1000);
  book.register("new");
  assert.deepEqual(book.reclaimable(), [{ sessionId: "old", reason: "evicted" }]);
});

test("reserve 给即将新建的 tab 留位：在恰好到上限时淘汰一个，没到上限一个都不淘汰", () => {
  const time = clock();
  const full = ledger({ now: time.now, maxTabs: 2 });
  full.register("old");
  time.advance(1000);
  full.register("new");
  assert.deepEqual(full.reclaimable(1), [{ sessionId: "old", reason: "evicted" }]);

  const room = ledger({ now: time.now, maxTabs: 3 });
  room.register("a");
  room.register("b");
  assert.deepEqual(room.reclaimable(1), [], "还没到上限，不必为新建腾位");
});

test("忙碌保护：最旧的那个正在导航就跳过它，淘汰下一个；全忙则一个都不动", () => {
  const time = clock();
  const book = ledger({ now: time.now, maxTabs: 2 });
  book.register("busy");
  time.advance(1000);
  book.register("idle");
  time.advance(1000);
  book.register("new");
  book.setBusy("busy", true);
  assert.deepEqual(book.reclaimable(), [{ sessionId: "idle", reason: "evicted" }]);

  const allBusy = ledger({ now: time.now, maxTabs: 2 });
  allBusy.register("a");
  allBusy.register("b");
  allBusy.register("c");
  allBusy.setBusy("a", true);
  allBusy.setBusy("b", true);
  allBusy.setBusy("c", true);
  assert.deepEqual(allBusy.reclaimable(), [], "宁可暂时超上限，也不拆跑着的调用");
});

test("忙碌只挡回收，不挡闲置判定：交接中（busy）的 tab 即使闲置也不回收", () => {
  const time = clock();
  const book = ledger({ now: time.now });
  book.register("handoff");
  book.setBusy("handoff", true);
  time.advance(IDLE_MS * 2);
  assert.deepEqual(book.reclaimable(), []);
  book.setBusy("handoff", false);
  assert.deepEqual(book.reclaimable(), [{ sessionId: "handoff", reason: "idle" }], "忙完了立刻可回收");
});

test("崩溃后重建：forget + register 等于一张新 tab，回到最活跃、busy 归零", () => {
  const time = clock();
  const book = ledger({ now: time.now, maxTabs: 2 });
  book.register("a");
  time.advance(1000);
  book.register("b");
  book.setBusy("a", true);
  // 崩溃：sandbox 先 forget，下一次请求再 register（重建）
  book.forget("a");
  time.advance(1000);
  book.register("a");
  assert.equal(book.size(), 2);
  assert.deepEqual(book.reclaimable(1), [{ sessionId: "b", reason: "evicted" }], "重建后的 a 是最新的，被淘汰的是 b");
});

test("forget 之后不再进候选，size 也跟着掉", () => {
  const time = clock();
  const book = ledger({ now: time.now, maxTabs: 1 });
  book.register("gone");
  book.register("kept");
  book.forget("gone");
  assert.equal(book.size(), 1);
  assert.deepEqual(book.reclaimable(), []);
});

test("clear 清空账本（沙盒销毁时用）", () => {
  const time = clock();
  const book = ledger({ now: time.now });
  book.register("a");
  book.register("b");
  book.clear();
  assert.equal(book.size(), 0);
  assert.deepEqual(book.reclaimable(), []);
});

test("agentTabNotice：三种原因各说清旧页面没了、要重新导航", () => {
  const context = { idleMinutes: 15, maxTabs: 8 };
  const idle = agentTabNotice("idle", context);
  assert.match(idle, /15 minutes/);
  assert.match(idle, /call browser_navigate/);
  const evicted = agentTabNotice("evicted", context);
  assert.match(evicted, /limit of 8 agent browser tabs/);
  assert.match(evicted, /call browser_navigate/);
  const crashed = agentTabNotice("crashed", context);
  assert.match(crashed, /crashed and was replaced/);
  assert.match(crashed, /call browser_navigate/);
});
