/**
 * 电脑使用的会话授权（2026-11-27）的可测核：提问表（发出 / 应答 / 超时 / 陈旧应答 /
 * 同会话合并）与会话闸门（三态、fail closed、落盘、撤销）。
 *
 * 这里全部是主进程侧的纯逻辑：不碰 electron、不碰真沙箱——工具是否真的执行由
 * dispatch.test.ts 钉（本文件只验闸门的裁决与落库）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_USE_CONSENT_DENIED_TEXT,
  type ComputerUseConsent,
  type ComputerUseConsentAskEvent,
  type ComputerUseConsentStateEvent,
} from "../../shared/computer-use.ts";
import { ComputerUseConsentWaiter, createComputerUseConsentGate } from "./consent.ts";

function collectAsk(): { events: ComputerUseConsentAskEvent[]; send: (event: ComputerUseConsentAskEvent) => void } {
  const events: ComputerUseConsentAskEvent[] = [];
  return { events, send: (event) => events.push(event) };
}

test("提问表：发一条 computerUseConsentAsk，应答按 requestId 结掉", async () => {
  const { events, send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send });
  const pending = waiter.ask("s1", "screenshot");
  assert.equal(events.length, 1);
  const ask = events[0]!;
  assert.equal(ask.type, "computerUseConsentAsk");
  assert.equal(ask.sessionId, "s1");
  assert.equal(ask.action, "screenshot");
  assert.ok(ask.requestId.startsWith("s1:consent:"));
  assert.equal(waiter.answer(ask.requestId, true), true);
  assert.deepEqual(await pending, { decision: "allowed", requestId: ask.requestId, source: "answered" });
  assert.equal(waiter.size, 0);
});

test("提问表：同一会话的并发提问合并成一次（一批工具只问一次）", async () => {
  const { events, send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send });
  const first = waiter.ask("s1", "screenshot");
  const second = waiter.ask("s1", "click");
  assert.equal(events.length, 1, "第二条请求不该再弹一张确认行");
  const ask = events[0]!;
  waiter.answer(ask.requestId, false);
  assert.equal((await first).decision, "denied");
  assert.equal((await second).decision, "denied");
  assert.equal(waiter.size, 0);
});

test("提问表：陈旧 / 坏 requestId 的应答丢弃，不串台到下一条会话", async () => {
  const { events, send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send });
  const pending = waiter.ask("s1", "screenshot");
  assert.equal(waiter.answer("s1:consent:stale", true), false);
  assert.equal(waiter.answer("not-a-request-id", true), false);
  assert.equal(waiter.size, 1);
  // 应答仍然按真的那一条结掉
  waiter.answer(events[0]!.requestId, true);
  assert.equal((await pending).decision, "allowed");
});

test("提问表：超时按 denied 结掉（绝不默默放行）", async () => {
  const { events, send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send, timeoutMs: 20, log: () => {} });
  const pending = waiter.ask("s1", "screenshot");
  const outcome = await pending;
  assert.equal(outcome.decision, "denied");
  assert.equal(outcome.source, "timeout");
  assert.equal(outcome.requestId, events[0]!.requestId);
  assert.equal(waiter.size, 0);
});

test("提问表：cancelAll 把挂起的提问按拒绝结掉（窗口全关 / 急停）", async () => {
  const { send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send });
  const first = waiter.ask("s1", "screenshot");
  const second = waiter.ask("s2", "sandbox-navigate");
  waiter.cancelAll();
  assert.equal((await first).decision, "denied");
  assert.equal((await first).source, "cancelled");
  assert.equal((await second).decision, "denied");
  assert.equal(waiter.size, 0);
});

/** 一个最小的会话 meta 假实现：只存一个值，读写都记下来 */
function fakeSession(initial: ComputerUseConsent | null): {
  read: () => Promise<ComputerUseConsent | null>;
  write: (next: ComputerUseConsent) => Promise<void>;
  state: () => ComputerUseConsent | null;
  writes: ComputerUseConsent[];
} {
  let value = initial;
  const writes: ComputerUseConsent[] = [];
  return {
    read: async () => value,
    write: async (next) => {
      value = next;
      writes.push(next);
    },
    state: () => value,
    writes,
  };
}

function makeGate(options: {
  initial: ComputerUseConsent | null;
  decision?: "allowed" | "denied" | "timeout";
  canAsk?: boolean;
  writeFails?: boolean;
  timeoutMs?: number;
}): {
  gate: ReturnType<typeof createComputerUseConsentGate>;
  store: ReturnType<typeof fakeSession>;
  states: ComputerUseConsentStateEvent[];
  asked: string[];
} {
  const store = fakeSession(options.initial);
  const { events, send } = collectAsk();
  const states: ComputerUseConsentStateEvent[] = [];
  const asked: string[] = [];
  const waiter = new ComputerUseConsentWaiter({
    send: (event) => {
      send(event);
      // 自动扮演用户：按测试给的答复回答这次提问（timeout 时什么都不做，等真超时）
      if (options.decision === "allowed" || options.decision === "denied") {
        queueMicrotask(() => waiter.answer(event.requestId, options.decision === "allowed"));
      }
    },
    timeoutMs: options.timeoutMs ?? 20,
    log: () => {},
  });
  const gate = createComputerUseConsentGate({
    read: async () => await store.read(),
    write: async (_sessionId, next) => {
      if (options.writeFails === true) throw new Error("disk full");
      await store.write(next);
    },
    ask: (sessionId, action) => {
      asked.push(action);
      return waiter.ask(sessionId, action);
    },
    canAsk: () => options.canAsk !== false,
    notify: (event) => states.push(event),
    log: () => {},
  });
  return { gate, store, states, asked };
}

test("闸门：allowed 直接放行，不问、不写", async () => {
  const { gate, store, asked } = makeGate({ initial: "allowed" });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), { ok: true });
  assert.deepEqual(asked, []);
  assert.deepEqual(store.writes, []);
});

test("闸门：denied 不执行，回固定的那句拒绝文本（同一来源常量）", async () => {
  const { gate, asked } = makeGate({ initial: "denied" });
  assert.deepEqual(await gate.ensure("s1", "click"), {
    ok: false,
    error: COMPUTER_USE_CONSENT_DENIED_TEXT,
  });
  assert.deepEqual(asked, [], "拒绝过就不再打扰用户");
});

test("闸门：unset → 问一次；答允许 → 落 allowed 并放行", async () => {
  const { gate, store, states, asked } = makeGate({ initial: "unset", decision: "allowed" });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), { ok: true });
  assert.deepEqual(asked, ["screenshot"]);
  assert.deepEqual(store.writes, ["allowed"]);
  assert.equal(states.length, 1);
  assert.equal(states[0]!.state, "allowed");
  assert.equal(states[0]!.source, "answered");
  assert.ok(states[0]!.requestId?.startsWith("s1:consent:"));
  // 下一次直接放行
  assert.deepEqual(await gate.ensure("s1", "click"), { ok: true });
  assert.deepEqual(asked, ["screenshot"]);
});

test("闸门：unset → 答拒绝 → 落 denied 并拒绝（同一句固定文本）", async () => {
  const { gate, store } = makeGate({ initial: "unset", decision: "denied" });
  assert.deepEqual(await gate.ensure("s1", "sandbox-navigate"), {
    ok: false,
    error: COMPUTER_USE_CONSENT_DENIED_TEXT,
  });
  assert.deepEqual(store.writes, ["denied"]);
});

test("闸门：超时按 denied 落库并拒绝（fail closed）", async () => {
  const { gate, store, states } = makeGate({ initial: "unset", decision: "timeout", timeoutMs: 20 });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), {
    ok: false,
    error: COMPUTER_USE_CONSENT_DENIED_TEXT,
  });
  assert.deepEqual(store.writes, ["denied"]);
  assert.equal(states[0]!.source, "timeout");
  assert.equal(states[0]!.state, "denied");
});

test("闸门：没人能回答（窗口全关 / 自动化无人看守）不提问，直接 denied 落库", async () => {
  const { gate, store, asked } = makeGate({ initial: "unset", canAsk: false });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), {
    ok: false,
    error: COMPUTER_USE_CONSENT_DENIED_TEXT,
  });
  assert.deepEqual(asked, [], "不弹一个没人看的卡");
  assert.deepEqual(store.writes, ["denied"]);
});

test("闸门：会话不存在（meta 读不到）按拒绝处理，不提问", async () => {
  const { gate, asked } = makeGate({ initial: null });
  assert.equal((await gate.ensure("gone", "screenshot")).ok, false);
  assert.deepEqual(asked, []);
});

test("闸门：允许了但落盘失败 → 这次也不执行（不拿没记下来的允诺当授权）", async () => {
  const { gate, states } = makeGate({ initial: "unset", decision: "allowed", writeFails: true });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), {
    ok: false,
    error: COMPUTER_USE_CONSENT_DENIED_TEXT,
  });
  assert.deepEqual(states, []);
});

test("状态迁移：unset → allowed → denied → unset，每一步的落库值与广播都对", async () => {
  const store = fakeSession("unset");
  const states: ComputerUseConsentStateEvent[] = [];
  const decisions: Array<"allowed" | "denied"> = ["allowed", "denied"];
  let index = 0;
  const waiter = new ComputerUseConsentWaiter({
    send: (event) => {
      const decision = decisions[index]!;
      index += 1;
      queueMicrotask(() => waiter.answer(event.requestId, decision === "allowed"));
    },
    log: () => {},
  });
  const gate = createComputerUseConsentGate({
    read: async () => await store.read(),
    write: async (_id, next) => await store.write(next),
    ask: (sessionId, action) => waiter.ask(sessionId, action),
    canAsk: () => true,
    notify: (event) => states.push(event),
    log: () => {},
  });

  assert.deepEqual(await gate.ensure("s1", "screenshot"), { ok: true });
  assert.equal(store.state(), "allowed");

  // 撤销：回 unset，下一次会重新问（用户这次答拒绝）
  await gate.reset("s1", "revoked");
  assert.equal(store.state(), "unset");
  assert.equal(states.at(-1)!.source, "revoked");

  assert.equal((await gate.ensure("s1", "click")).ok, false);
  assert.equal(store.state(), "denied");

  // 急停：再回 unset
  await gate.reset("s1", "emergency-stop");
  assert.equal(store.state(), "unset");
  assert.equal(states.at(-1)!.source, "emergency-stop");
});

/**
 * 主进程把闸门与下发串成的形状（index.ts 的 computerUseRequest：
 * `gate.ensure → dispatch`）。这里用假 broker 计数——不碰真沙箱，
 * 只验「三种状态下工具到底跑没跑」。
 */
async function runWithFakeBroker(options: {
  initial: ComputerUseConsent | null;
  decision?: "allowed" | "denied" | "timeout";
  canAsk?: boolean;
  timeoutMs?: number;
}): Promise<{ ran: string[]; verdictError: string | null }> {
  const ran: string[] = [];
  const { gate } = makeGate(options);
  const dispatch = async (sessionId: string, action: string) => {
    ran.push(`${sessionId}:${action}`);
    return { ok: true as const, text: "done" };
  };
  const verdict = await gate.ensure("s1", "screenshot");
  if (verdict.ok) await dispatch("s1", "screenshot");
  return { ran, verdictError: verdict.ok ? null : verdict.error };
}

test("闸门 × 下发：allowed 执行；denied 不执行；超时也不执行（三态都只落在闸门上）", async () => {
  const allowed = await runWithFakeBroker({ initial: "allowed" });
  assert.deepEqual(allowed.ran, ["s1:screenshot"]);
  assert.equal(allowed.verdictError, null);

  const denied = await runWithFakeBroker({ initial: "denied" });
  assert.deepEqual(denied.ran, []);
  assert.equal(denied.verdictError, COMPUTER_USE_CONSENT_DENIED_TEXT);

  const timedOut = await runWithFakeBroker({ initial: "unset", decision: "timeout", timeoutMs: 20 });
  assert.deepEqual(timedOut.ran, []);
  assert.equal(timedOut.verdictError, COMPUTER_USE_CONSENT_DENIED_TEXT);

  const answered = await runWithFakeBroker({ initial: "unset", decision: "allowed" });
  assert.deepEqual(answered.ran, ["s1:screenshot"], "用户点头之后这一条才真的下发");
});
