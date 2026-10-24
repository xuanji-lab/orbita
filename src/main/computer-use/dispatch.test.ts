/**
 * 接线层（main/computer-use/dispatch.ts）：按动作选资源键 → 要租约 → 下发。
 *
 * 这里只验三件事，都是真实事故的形状：
 *   1. computer_* 拿不到桌面键时**不下发**（否则两条动作序列交错、两边都收到成功）；
 *   2. sandbox_* 在别人持桌面时**照常下发**（每会话一个 Edge 之后的并行，v1.5-2 的关键回归）；
 *   3. 桌面键被硬上限收回后，那个会话的下一条命令收到终态错误，只拦一条。
 *
 * 下发函数是注入的：数调用次数就够，不需要沙箱、不需要 electron。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createComputerUseDispatcher } from "./dispatch.ts";
import { createComputerUseLease, type LeaseClock } from "./lease.ts";
import type { ComputerUseToolOutcome, ComputerUseToolRequest } from "../../shared/computer-use.ts";

/** 假时钟（同 lease.test.ts：手动推进，触发期间新挂的定时器也参与本次推进） */
function fakeClock(): LeaseClock & { advance(ms: number): void } {
  let current = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => current,
    setTimeout(callback, ms): () => void {
      const id = nextId++;
      timers.set(id, { at: current + ms, callback });
      return () => timers.delete(id);
    },
    advance(ms: number): void {
      const target = current + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        if (timer === undefined) continue;
        current = timer.at;
        timer.callback();
      }
      current = target;
    },
  };
}

const SCREENSHOT: ComputerUseToolRequest = { action: "screenshot", maxWidth: 1280 };
const NAVIGATE: ComputerUseToolRequest = { action: "sandbox-navigate", url: "https://example.com" };

const titled = (titles: Record<string, string>) => async (sessionId: string) => titles[sessionId] ?? "";

/** 让 microtask / setImmediate 跑一轮：dispatch 内部先 await titleOf 才进队列 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(titles: Record<string, string> = {}) {
  const clock = fakeClock();
  const lease = createComputerUseLease({ clock });
  const calls: string[] = [];
  const dispatcher = createComputerUseDispatcher({
    lease,
    titleOf: titled(titles),
    runPixels: async (sessionId): Promise<ComputerUseToolOutcome> => {
      calls.push(`pixels:${sessionId}`);
      return { ok: true, text: "点完了" };
    },
    runBrowser: async (sessionId): Promise<ComputerUseToolOutcome> => {
      calls.push(`browser:${sessionId}`);
      return { ok: true, text: "页面打开了" };
    },
  });
  return { clock, lease, dispatcher, calls };
}

describe("接线：computer_* 走桌面独占", () => {
  test("A 持桌面时 B 的 computer_* 不下发，错误点名占用者", async () => {
    const { clock, lease, dispatcher, calls } = setup({ A: "整理发票", B: "任务乙" });
    await lease.acquire("desktop:exclusive", "A", "整理发票");
    const pending = dispatcher.dispatch("B", SCREENSHOT);
    await flush(); // 让 B 真正排进队列（30s 等待是假时钟）
    assert.equal(lease.queueDepth("desktop:exclusive"), 1);
    clock.advance(30_000);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.error, /整理发票/);
      assert.match(outcome.error, /不要重试/);
    }
    assert.deepEqual(calls, []); // 一次都没下发
  });

  test("桌面空着时 computer_* 正常下发", async () => {
    const { dispatcher, calls } = setup({ A: "任务甲" });
    const outcome = await dispatcher.dispatch("A", SCREENSHOT);
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls, ["pixels:A"]);
  });
});

describe("接线：sandbox_* 走每会话浏览器（关键回归）", () => {
  test("别人持桌面时 sandbox_* 照常下发（不排队、不失败）", async () => {
    const { lease, dispatcher, calls } = setup({ A: "任务甲", B: "任务乙" });
    await lease.acquire("desktop:exclusive", "A", "任务甲");
    const outcome = await dispatcher.dispatch("B", NAVIGATE);
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls, ["browser:B"]);
    // 桌面仍然在 A 手上，B 没有偷偷占它
    assert.equal(lease.owner("desktop:exclusive")?.sessionId, "A");
  });

  test("两个会话同时做网页任务：都没进桌面的队列", async () => {
    const { lease, dispatcher, calls } = setup({ A: "任务甲", B: "任务乙" });
    const [a, b] = await Promise.all([
      dispatcher.dispatch("A", NAVIGATE),
      dispatcher.dispatch("B", NAVIGATE),
    ]);
    assert.deepEqual([a.ok, b.ok], [true, true]);
    assert.deepEqual(calls.sort(), ["browser:A", "browser:B"]);
    assert.equal(lease.queueDepth("desktop:exclusive"), 0);
    assert.equal(lease.owner("browser:A")?.sessionId, "A");
    assert.equal(lease.owner("browser:B")?.sessionId, "B");
  });
});

describe("接线：桌面键被硬上限收回后只拦一条", () => {
  test("收回后的下一条命令收到终态错误且不下发；再下一条照常", async () => {
    const { clock, dispatcher, calls } = setup({ A: "任务甲" });
    await dispatcher.dispatch("A", SCREENSHOT);
    // 模拟租约事件：15 分钟硬上限把这个会话收回了
    dispatcher.noteHoldExpired("A");
    clock.advance(15 * 60_000);

    const blocked = await dispatcher.dispatch("A", SCREENSHOT);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.match(blocked.error, /15 分钟/);
      assert.match(blocked.error, /不要重试/);
    }
    assert.deepEqual(calls, ["pixels:A"]); // 只有第一次真下发了

    const retried = await dispatcher.dispatch("A", SCREENSHOT);
    assert.equal(retried.ok, true);
    assert.deepEqual(calls, ["pixels:A", "pixels:A"]);
  });

  test("forget 之后不再拦（会话删了 / 重开）", async () => {
    const { dispatcher, calls } = setup({ A: "任务甲" });
    dispatcher.noteHoldExpired("A");
    dispatcher.forget("A");
    const outcome = await dispatcher.dispatch("A", SCREENSHOT);
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls, ["pixels:A"]);
  });
});
