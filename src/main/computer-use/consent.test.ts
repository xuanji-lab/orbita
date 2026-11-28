/**
 * 电脑使用的会话授权（2026-11-27）的可测核：提问表（发出 / 应答 / 超时 / 取消 / 陈旧应答 /
 * 同会话合并）与会话闸门（三态、fail closed、取消不写 meta、落盘确认、只允许主会话）。
 *
 * 这里全部是主进程侧的纯逻辑：不碰 electron、不碰真沙箱——工具是否真的执行由
 * dispatch.test.ts 钉，本文件只验闸门的裁决与落库。
 *
 * 「取消 ≠ 拒绝」与「写盘要确认」两条是 2026-11-27 独立验收抓出来的真 fail-open
 * （停轮后点允许会真的执行、急停落成 denied、会话被删仍放行），本文件逐条钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computerUseBlockedReason,
  computerUseConsentTexts,
  type ComputerUseConsent,
  type ComputerUseConsentAskCancelledEvent,
  type ComputerUseConsentSource,
  type ComputerUseConsentAskEvent,
  type ComputerUseConsentStateEvent,
  type ComputerUseConsentTexts,
  type ComputerUseSessionShape,
  type ComputerUseTurnOrigin,
} from "../../shared/computer-use.ts";

/** 测试里默认用中文那一份：正文断言与产品默认行为（中文界面）一致 */
const ZH = computerUseConsentTexts("zh");
const EN = computerUseConsentTexts("en");
import { ComputerUseConsentWaiter, createComputerUseConsentGate } from "./consent.ts";

function collectAsk(): {
  events: ComputerUseConsentAskEvent[];
  cancelled: ComputerUseConsentAskCancelledEvent[];
  send: (event: ComputerUseConsentAskEvent) => void;
  notifyCancelled: (event: ComputerUseConsentAskCancelledEvent) => void;
} {
  const events: ComputerUseConsentAskEvent[] = [];
  const cancelled: ComputerUseConsentAskCancelledEvent[] = [];
  return { events, cancelled, send: (event) => events.push(event), notifyCancelled: (event) => cancelled.push(event) };
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

test("提问表：cancel 按「本轮已停止」结掉，并通知 renderer 撤下确认行（不是拒绝）", async () => {
  const { events, cancelled, send, notifyCancelled } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send, notifyCancelled });
  const pending = waiter.ask("s1", "click");
  const requestId = events[0]!.requestId;
  waiter.cancel("s1");
  const outcome = await pending;
  assert.equal(outcome.decision, "cancelled", "取消不是 denied——不能写 meta");
  assert.equal(outcome.requestId, requestId);
  assert.deepEqual(cancelled, [
    { type: "computerUseConsentAskCancelled", sessionId: "s1", requestId, reason: "turn-ended" },
  ]);
  assert.equal(waiter.size, 0);
  // 取消之后再回答：已经没有挂起项，丢弃（停轮后迟到的「允许」改不了任何东西）
  assert.equal(waiter.answer(requestId, true), false);
  // 没有挂起的会话来 cancel 是 no-op
  waiter.cancel("s1");
});

test("提问表：abandonAll（窗口全关）按 denied 结掉（没人能答就是拒绝）", async () => {
  const { send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send });
  const first = waiter.ask("s1", "screenshot");
  const second = waiter.ask("s2", "sandbox-navigate");
  waiter.abandonAll();
  const a = await first;
  const b = await second;
  assert.equal(a.decision, "denied");
  assert.equal(a.source, "unavailable");
  assert.equal(b.decision, "denied");
  assert.equal(waiter.size, 0);
});

test("提问表：cancelAll（agent 进程退出）按 cancelled 结掉，不写 meta", async () => {
  const { send } = collectAsk();
  const waiter = new ComputerUseConsentWaiter({ send });
  const first = waiter.ask("s1", "screenshot");
  const second = waiter.ask("s2", "click");
  waiter.cancelAll();
  assert.equal((await first).decision, "cancelled");
  assert.equal((await second).decision, "cancelled");
  assert.equal(waiter.size, 0);
});

/**
 * 一个最小的会话假实现：授权值 + 是否存在 + 写记录。
 * 会话身份与「这一轮是谁发起的」走**真判据** computerUseBlockedReason——闸门测试要覆盖的
 * 正是「自动化把一轮投回用户会话」这条入口，假一份 blockedReason 就测不到它。
 */
function fakeSession(
  initial: ComputerUseConsent | null,
  options: {
    session?: ComputerUseSessionShape;
    origin?: ComputerUseTurnOrigin;
    /** 盘上已经有的结局原因（模拟刷新后读到 meta） */
    initialSource?: ComputerUseConsentSource;
  } = {},
): {
  read: () => Promise<{
    consent: ComputerUseConsent;
    source: ComputerUseConsentSource | null;
    blocked: "main-session-only" | "unattended" | null;
  } | null>;
  write: (next: ComputerUseConsent, source?: ComputerUseConsentSource) => Promise<boolean>;
  state: () => ComputerUseConsent | null;
  /** 落盘过的结局原因（与授权值同一次写；撤销清成 null） */
  source: () => ComputerUseConsentSource | null;
  writes: ComputerUseConsent[];
  remove: () => void;
} {
  let value = initial;
  let source: ComputerUseConsentSource | null = options.initialSource ?? null;
  let alive = initial !== null;
  const writes: ComputerUseConsent[] = [];
  const session = options.session ?? {};
  const origin = options.origin ?? "user";
  return {
    // 忠实复刻 store.update：meta 不在就是「没写」，不抛错
    read: async () =>
      alive && value !== null
        ? { consent: value, source, blocked: computerUseBlockedReason(session, origin) }
        : null,
    write: async (next, nextSource) => {
      if (!alive) return false;
      value = next;
      // 与 store 同一条语义：unset 时不带来源
      source = next === "unset" ? null : (nextSource ?? null);
      writes.push(next);
      return true;
    },
    state: () => (alive ? value : null),
    source: () => source,
    writes,
    remove: () => {
      alive = false;
    },
  };
}

function makeGate(options: {
  initial: ComputerUseConsent | null;
  decision?: "allowed" | "denied" | "timeout";
  canAsk?: boolean;
  writeFails?: boolean;
  silentWrite?: boolean;
  session?: ComputerUseSessionShape;
  origin?: ComputerUseTurnOrigin;
  texts?: ComputerUseConsentTexts;
  timeoutMs?: number;
}): {
  gate: ReturnType<typeof createComputerUseConsentGate>;
  store: ReturnType<typeof fakeSession>;
  states: ComputerUseConsentStateEvent[];
  asked: string[];
  waiter: ComputerUseConsentWaiter;
} {
  const store = fakeSession(options.initial, { session: options.session, origin: options.origin });
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
    read: () => store.read(),
    write: async (_sessionId, next, source) => {
      if (options.writeFails === true) throw new Error("disk full");
      if (options.silentWrite === true) return false; // 会话已删：store.update 静默 no-op
      return await store.write(next, source);
    },
    ask: (sessionId, action) => {
      asked.push(action);
      return waiter.ask(sessionId, action);
    },
    canAsk: () => options.canAsk !== false,
    notify: (event) => states.push(event),
    texts: async () => options.texts ?? ZH,
    log: () => {},
  });
  void events;
  return { gate, store, states, asked, waiter };
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
    error: ZH.denied,
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
    error: ZH.denied,
  });
  assert.deepEqual(store.writes, ["denied"]);
});

test("闸门：超时按 denied 落库并拒绝（fail closed），且落盘结局原因是 timeout", async () => {
  const { gate, store, states } = makeGate({ initial: "unset", decision: "timeout", timeoutMs: 20 });
  // 超时 ≠ 用户拒绝：给模型（也就是界面「已告知模型」那行）的是另一句
  assert.deepEqual(await gate.ensure("s1", "screenshot"), {
    ok: false,
    error: ZH.deniedUnanswered,
  });
  assert.deepEqual(store.writes, ["denied"]);
  assert.equal(store.source(), "timeout", "结局原因与授权值同一次写落进 meta（刷新后分得出来）");
  assert.equal(states[0]!.source, "timeout");
  assert.equal(states[0]!.state, "denied");
});

test("闸门：刷新后读到 denied + timeout → 仍然按「没人回答」说，不说成用户拒绝", async () => {
  const store = fakeSession("denied", { initialSource: "timeout" });
  const gate = createComputerUseConsentGate({
    read: () => store.read(),
    write: async (_id, next, source) => await store.write(next, source),
    ask: async () => {
      throw new Error("不该提问：已经是 denied");
    },
    canAsk: () => true,
    notify: () => {},
    texts: async () => ZH,
    log: () => {},
  });
  assert.deepEqual(await gate.ensure("s1", "click"), { ok: false, error: ZH.deniedUnanswered });
  // 存的是 answered：维持「用户拒绝」那句
  const answered = fakeSession("denied", { initialSource: "answered" });
  const gate2 = createComputerUseConsentGate({
    read: () => answered.read(),
    write: async (_id, next, source) => await answered.write(next, source),
    ask: async () => {
      throw new Error("不该提问");
    },
    canAsk: () => true,
    notify: () => {},
    texts: async () => ZH,
    log: () => {},
  });
  assert.deepEqual(await gate2.ensure("s1", "click"), { ok: false, error: ZH.denied });
  // 老会话文件没有这个键：按「用户拒绝」说（不编一个超时）
  const legacy = fakeSession("denied");
  const gate3 = createComputerUseConsentGate({
    read: () => legacy.read(),
    write: async (_id, next, source) => await legacy.write(next, source),
    ask: async () => {
      throw new Error("不该提问");
    },
    canAsk: () => true,
    notify: () => {},
    texts: async () => ZH,
    log: () => {},
  });
  assert.deepEqual(await gate3.ensure("s1", "click"), { ok: false, error: ZH.denied });
});

test("闸门：明确拒绝（answered）落 answered，文案维持「用户拒绝了电脑操作」", async () => {
  const { gate, store } = makeGate({ initial: "unset", decision: "denied" });
  assert.deepEqual(await gate.ensure("s1", "click"), { ok: false, error: ZH.denied });
  assert.deepEqual(store.writes, ["denied"]);
  assert.equal(store.source(), "answered");
});

test("闸门：没有窗口可答（unavailable）→ 落 unavailable，说的也是「没人回答」", async () => {
  const { gate, store } = makeGate({ initial: "unset", canAsk: false });
  assert.deepEqual(await gate.ensure("s1", "click"), { ok: false, error: ZH.deniedUnanswered });
  assert.deepEqual(store.writes, ["denied"]);
  assert.equal(store.source(), "unavailable");
});

test("闸门：停轮 → 挂起提问被取消 → 工具以「已停止」返回 → meta 仍是 unset → 之后再调用会重新问", async () => {
  const { gate, store, asked, states, waiter } = makeGate({ initial: "unset" });
  const pending = gate.ensure("s1", "click");
  // 等提问真的发出（waiter 挂上）再模拟「用户按了停止」
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(waiter.size, 1);
  waiter.cancel("s1");
  assert.deepEqual(await pending, { ok: false, error: ZH.stopped });
  assert.deepEqual(store.writes, [], "取消不写 meta");
  assert.deepEqual(states, [], "也没有状态广播（授权状态没变）");
  assert.equal(store.state(), "unset");
  // 停轮之后迟到的「允许」：没有挂起项可答，丢弃
  assert.equal(waiter.answer("s1:consent:dead", true), false);
  // 下一次调用会重新问：问到第二次就是证据（再取消收尾，不等 120s）
  const again = gate.ensure("s1", "click");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked.length, 2, "重新问了一次");
  waiter.cancel("s1");
  assert.deepEqual(await again, { ok: false, error: ZH.stopped });
  assert.deepEqual(store.writes, []);
});

test("闸门：停轮后即使等过 120s（缩小成 20ms），也不许写 denied", async () => {
  const { gate, store, waiter } = makeGate({ initial: "unset", timeoutMs: 20 });
  const pending = gate.ensure("s1", "click");
  await new Promise((resolve) => setTimeout(resolve, 5));
  waiter.cancel("s1");
  assert.deepEqual(await pending, { ok: false, error: ZH.stopped });
  // 超过原来的超时线再等一会：不能有任何 delayed 写入
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(store.writes, [], "取消之后没有任何写盘（既没 denied 也没别的）");
  assert.equal(store.state(), "unset");
});

test("闸门：没人能回答（窗口全关 / 自动化无人看守）不提问，直接 denied 落库", async () => {
  const { gate, store, asked } = makeGate({ initial: "unset", canAsk: false });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), {
    ok: false,
    error: ZH.deniedUnanswered,
  });
  assert.deepEqual(asked, [], "不弹一个没人看的卡");
  assert.deepEqual(store.writes, ["denied"]);
});

test("闸门：会话不存在（meta 读不到）按拒绝处理，不提问", async () => {
  const { gate, asked } = makeGate({ initial: null });
  assert.equal((await gate.ensure("gone", "screenshot")).ok, false);
  assert.deepEqual(asked, []);
});

test("闸门：允许了但落盘抛错 → 这次也不执行（不拿没记下来的允诺当授权）", async () => {
  const { gate, states } = makeGate({ initial: "unset", decision: "allowed", writeFails: true });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), {
    ok: false,
    error: ZH.denied,
  });
  assert.deepEqual(states, []);
});

test("闸门：允许了但写盘静默没落下（会话在挂起期间被删）→ 按拒绝收口，不下发", async () => {
  const { gate, asked, states } = makeGate({ initial: "unset", decision: "allowed", silentWrite: true });
  const verdict = await gate.ensure("s1", "screenshot");
  assert.deepEqual(verdict, { ok: false, error: ZH.denied });
  assert.deepEqual(asked, ["screenshot"], "提问是真的发出去了");
  assert.deepEqual(states, [], "没落下就不广播一条假的 allowed");
});

test("闸门：子会话 / 自动化会话立刻拒绝（主会话专用），不提问、不读它的授权", async () => {
  const { gate, asked, store } = makeGate({ initial: "allowed", session: { parentId: "p" } });
  assert.deepEqual(await gate.ensure("child", "screenshot"), {
    ok: false,
    error: ZH.mainSessionOnly,
  });
  assert.deepEqual(asked, [], "不问——它的提问用户看不到");
  assert.deepEqual(store.writes, [], "也不写它的 meta");
});

/**
 * 2026-11-27 验收（复验）要求的两条：自动化把一轮投回**用户的会话**时不能弹提问；
 * 反过来，promoted 的自动化会话是用户看得见的普通会话，用户手点的轮次照常问。
 */
test("闸门：自动化发起 + 主会话 → 即时拒绝、0 次提问、0 次写盘（this_session 那条入口）", async () => {
  const { gate, store, asked, states } = makeGate({ initial: "unset", origin: "automation" });
  assert.deepEqual(await gate.ensure("s1", "click"), { ok: false, error: ZH.unattended });
  assert.deepEqual(asked, [], "用户不在看：问也问不到，直接说清楚");
  assert.deepEqual(store.writes, [], "更不能借 120s 超时把 denied 写进用户的会话");
  assert.deepEqual(states, [], "没有状态广播");
});

test("闸门：promoted 自动化会话 + 用户发起 → 按普通会话走提问（会话身份不再把它误判成子会话）", async () => {
  const { gate, store, asked } = makeGate({
    initial: "unset",
    session: { automationId: "au1", promoted: true },
    origin: "user",
    decision: "allowed",
  });
  assert.deepEqual(await gate.ensure("s1", "screenshot"), { ok: true });
  assert.deepEqual(asked, ["screenshot"], "用户看得见这条会话，所以真的问了一次");
  assert.deepEqual(store.writes, ["allowed"]);
});

/** 同一对判据在闸门 × 下发上的结果（promoted 的自动化会话里，用户手点 → 放行；自动化发起 → 不执行） */
test("闸门 × 下发：promoted 自动化 + 用户发起会执行；同一会话换成自动化发起就不执行", async () => {
  const viaUser = await runWithFakeBroker({
    initial: "unset",
    session: { automationId: "au1", promoted: true },
    origin: "user",
    decision: "allowed",
  });
  assert.deepEqual(viaUser.ran, ["s1:screenshot"]);

  const viaAutomation = await runWithFakeBroker({
    initial: "allowed",
    session: { automationId: "au1", promoted: true },
    origin: "automation",
  });
  assert.deepEqual(viaAutomation.ran, [], "自动化那一轮不碰桌面，哪怕本会话早前被允许过");
  assert.equal(viaAutomation.verdictError, ZH.unattended);
});
/**
 * P2-1：给模型的固定文本按界面语言取。英文界面下四句都要是英文——
 * 拒绝文本会原样出现在界面「已告知模型：…」那一行里，夹中文就是夹生字。
 */
test("英文界面：拒绝 / 停止 / 主会话专用 / 自动化 四句都走英文", async () => {
  const denied = makeGate({ initial: "denied", texts: EN });
  assert.deepEqual(await denied.gate.ensure("s1", "click"), { ok: false, error: EN.denied });

  const stopped = makeGate({ initial: "unset", texts: EN, timeoutMs: 5_000 });
  const pending = stopped.gate.ensure("s1", "click");
  await new Promise((resolve) => setTimeout(resolve, 5));
  stopped.waiter.cancel("s1");
  assert.deepEqual(await pending, { ok: false, error: EN.stopped });

  const child = makeGate({ initial: "allowed", texts: EN, session: { parentId: "p" } });
  assert.deepEqual(await child.gate.ensure("s1", "click"), { ok: false, error: EN.mainSessionOnly });

  const unattended = makeGate({ initial: "unset", texts: EN, origin: "automation" });
  assert.deepEqual(await unattended.gate.ensure("s1", "click"), { ok: false, error: EN.unattended });
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
    read: () => store.read(),
    write: async (_id, next, source) => await store.write(next, source),
    ask: (sessionId, action) => waiter.ask(sessionId, action),
    canAsk: () => true,
    notify: (event) => states.push(event),
    texts: async () => ZH,
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
  session?: ComputerUseSessionShape;
  origin?: ComputerUseTurnOrigin;
  texts?: ComputerUseConsentTexts;
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
  assert.equal(denied.verdictError, ZH.denied);

  const timedOut = await runWithFakeBroker({ initial: "unset", decision: "timeout", timeoutMs: 20 });
  assert.deepEqual(timedOut.ran, []);
  assert.equal(timedOut.verdictError, ZH.deniedUnanswered, "超时 ≠ 用户拒绝");

  const answered = await runWithFakeBroker({ initial: "unset", decision: "allowed" });
  assert.deepEqual(answered.ran, ["s1:screenshot"], "用户点头之后这一条才真的下发");

  const child = await runWithFakeBroker({ initial: "allowed", session: { parentId: "p" } });
  assert.deepEqual(child.ran, [], "子会话永远不下发");
  assert.equal(child.verdictError, ZH.mainSessionOnly);
});

test("闸门 × 下发：停轮取消之后，动作一次都不下发", async () => {
  const ran: string[] = [];
  const { gate, waiter } = makeGate({ initial: "unset", timeoutMs: 5000 });
  const ensure = gate.ensure("s1", "click");
  await new Promise((resolve) => setTimeout(resolve, 5));
  waiter.cancel("s1");
  const verdict = await ensure;
  if (verdict.ok) ran.push("click-dispatched");
  assert.deepEqual(ran, [], "停轮之后的迟到回答/迟到取消都不能让动作跑起来");
  assert.deepEqual(verdict, { ok: false, error: ZH.stopped });
});

test("急停写序：有挂起提问时先 cancel（不写）再 reset → 最终 unset，写序列里没有 denied", async () => {
  const store = fakeSession("allowed");
  const writes: string[] = [];
  const states: ComputerUseConsentStateEvent[] = [];
  const waiter = new ComputerUseConsentWaiter({ send: () => {}, log: () => {} });
  const gate = createComputerUseConsentGate({
    read: () => store.read(),
    write: async (_id, next) => {
      writes.push(next);
      return await store.write(next);
    },
    ask: (sessionId, action) => waiter.ask(sessionId, action),
    canAsk: () => true,
    notify: (event) => states.push(event),
    texts: async () => ZH,
    log: () => {},
  });
  // 造一个挂起提问（模拟「正要动手」的那一轮）
  await store.write("unset");
  writes.length = 0;
  const pending = gate.ensure("s1", "click");
  await new Promise((resolve) => setTimeout(resolve, 5));
  // index.ts 的急停顺序：cancelAll() → reset(emergency-stop)
  waiter.cancelAll();
  await gate.reset("s1", "emergency-stop");
  const verdict = await pending;
  assert.deepEqual(verdict, { ok: false, error: ZH.stopped });
  assert.deepEqual(writes, ["unset"], "只写了 reset 的 unset，没有任何 denied");
  assert.equal(store.state(), "unset");
  assert.deepEqual(states.map((event) => [event.state, event.source]), [["unset", "emergency-stop"]]);
});
