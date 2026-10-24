/**
 * 沙箱租约（main/computer-use/lease.ts）：独占、FIFO、有界等待、idle 线、硬上限、revoke。
 *
 * 时钟与定时器全是假的（fakeClock），所以 30s / 60s / 15min 这几条线都是真断言，不是
 * 睡眠——真等 15 分钟跑一遍的测试不会有人跑第二遍。每条用例只碰一个性质：宁可多几条
 * 用例，也不要一条「顺便把别的也验了」的巨型断言（挂了不知道断在哪）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSandboxLease, runWithLease, type LeaseClock, type LeaseEvent } from "./lease.ts";
import { COMPUTER_USE_LEASE } from "../../shared/computer-use.ts";

/**
 * 假时钟：手动推进。setTimeout 按截止时刻排序，推进时逐个触发——**触发期间新挂的定时器
 * 也参与同一次推进**（续期就是这种：回调里重新挂两根），所以按序 while 循环而不是快照。
 */
function fakeClock(start: number = 1_000): LeaseClock & { advance(ms: number): void; now(): number } {
  let current = start;
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

const setup = () => {
  const clock = fakeClock();
  const events: LeaseEvent[] = [];
  const lease = createSandboxLease({ clock, onEvent: (event) => events.push(event) });
  return { clock, lease, events };
};

/** 把「悬着的 Promise」变成可断言的「现在是否已落定」：租约的等待不该被意外提前唤醒 */
async function state<T>(pending: Promise<T>): Promise<"pending" | T> {
  const marker = Symbol("pending");
  const result = await Promise.race([pending, Promise.resolve(marker)]);
  return result === marker ? "pending" : (result as T);
}

describe("沙箱租约：独占", () => {
  test("A 持有期间 B 拿不到；A 释放后 B 立刻拿到", async () => {
    const { lease } = setup();
    assert.deepEqual(await lease.acquire("A", "任务甲"), { ok: true });
    assert.equal(lease.owner()?.sessionId, "A");

    const waiting = lease.acquire("B", "任务乙");
    assert.equal(await state(waiting), "pending");
    assert.equal(lease.queueDepth(), 1);

    lease.release("A", "这一轮做完了");
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(lease.owner()?.sessionId, "B");
    assert.equal(lease.queueDepth(), 0);
  });

  test("同一个会话重复 acquire 是幂等的（它在手上的命令每条都问一次）", async () => {
    const { lease, events } = setup();
    assert.deepEqual(await lease.acquire("A", "任务甲"), { ok: true });
    assert.deepEqual(await lease.acquire("A", "任务甲"), { ok: true });
    assert.equal(lease.owner()?.sessionId, "A");
    // 只有一次真正的「拿到」，重复的那次只是续期
    assert.equal(events.filter((event) => event.type === "acquired").length, 1);
    assert.equal(lease.queueDepth(), 0);
  });

  test("非持有者的 renew / release 是 no-op（不报错、不抢锁）", async () => {
    const { lease } = setup();
    await lease.acquire("A", "任务甲");
    lease.renew("B");
    lease.release("B");
    assert.equal(lease.owner()?.sessionId, "A");
  });
});

describe("沙箱租约：FIFO", () => {
  test("B、C、D 按到达顺序接手（不是按等待时长，也不是随机）", async () => {
    const { lease } = setup();
    await lease.acquire("A", "任务甲");
    const b = lease.acquire("B", "任务乙");
    const c = lease.acquire("C", "任务丙");
    const d = lease.acquire("D", "任务丁");
    assert.equal(lease.queueDepth(), 3);

    lease.release("A");
    assert.deepEqual(await b, { ok: true });
    assert.equal(lease.owner()?.sessionId, "B");
    assert.equal(lease.queueDepth(), 2);

    lease.release("B");
    assert.deepEqual(await c, { ok: true });
    assert.equal(lease.owner()?.sessionId, "C");

    lease.release("C");
    assert.deepEqual(await d, { ok: true });
    assert.equal(lease.owner()?.sessionId, "D");
    assert.equal(lease.queueDepth(), 0);
  });

  test("同一个会话在队列里只占一个位置（两条并发的命令不分到两个位置）", async () => {
    const { lease } = setup();
    await lease.acquire("A", "任务甲");
    const b1 = lease.acquire("B", "任务乙");
    const b2 = lease.acquire("B", "任务乙");
    assert.equal(lease.queueDepth(), 1);
    lease.release("A");
    assert.deepEqual(await b1, { ok: true });
    assert.deepEqual(await b2, { ok: true });
    assert.equal(lease.owner()?.sessionId, "B");
  });
});

describe("沙箱租约：有界等待", () => {
  test("等满 30 秒没等到 → 拒绝，文案点名占用者与「不要重试」", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "整理发票");
    const waiting = lease.acquire("B", "任务乙");
    clock.advance(COMPUTER_USE_LEASE.waitMs - 1);
    assert.equal(await state(waiting), "pending");
    clock.advance(1);
    const result = await waiting;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /整理发票/); // 占用者标题
    assert.match(result.error, /不要重试/);
    assert.match(result.error, /30 秒/);
    assert.equal(lease.queueDepth(), 0); // 超时的等待者撤出队列，不占名额
  });

  test("占用者没有标题时不硬塞一对空引号", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "");
    const waiting = lease.acquire("B", "任务乙");
    clock.advance(COMPUTER_USE_LEASE.waitMs);
    const result = await waiting;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.doesNotMatch(result.error, /「」/);
    assert.match(result.error, /不要重试/);
  });

  test("队列上限 8：第 9 个不等，直接拒绝", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "任务甲");
    const waiting = [];
    for (let index = 1; index <= COMPUTER_USE_LEASE.queueLimit; index += 1) {
      waiting.push(lease.acquire(`W${String(index)}`, `排队者 ${String(index)}`));
    }
    assert.equal(lease.queueDepth(), COMPUTER_USE_LEASE.queueLimit);

    const ninth = await lease.acquire("W9", "第九个");
    assert.equal(ninth.ok, false);
    if (!ninth.ok) {
      assert.match(ninth.error, /上限（8 个）/);
      assert.match(ninth.error, /不要重试/);
    }
    // 被拒绝的那个没有占队列（第 9 个不在队列里，队列深度不变）
    assert.equal(lease.queueDepth(), COMPUTER_USE_LEASE.queueLimit);

    // 收尾：把排队的都放掉，别让悬着的定时器跑进下一个用例
    lease.revoke("用例结束");
    clock.advance(COMPUTER_USE_LEASE.waitMs);
    for (const item of waiting) await item;
  });
});

describe("沙箱租约：idle 与续期", () => {
  test("60 秒无命令自动释放，锁给队列头", async () => {
    const { lease, clock, events } = setup();
    await lease.acquire("A", "任务甲");
    // B 在 idle 线之前很久进来：先走到 45s 再让 B 排队，于是 B 的 30s 超时
    // （75s 到点）落在 idle（60s）之后——这轮先到的是 idle
    clock.advance(45_000);
    const waiting = lease.acquire("B", "任务乙");
    clock.advance(15_000 - 1);
    assert.equal(lease.owner()?.sessionId, "A");
    clock.advance(1);
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(lease.owner()?.sessionId, "B");
    assert.ok(events.some((event) => event.type === "released" && event.reason === "idle"));
  });

  test("每条命令续期能续命：59 秒一次命令就一直持有", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "任务甲");
    for (let index = 0; index < 5; index += 1) {
      clock.advance(59_000);
      lease.renew("A");
    }
    // 5 轮 × 59s = 295s，远超 60s，但每次都在 idle 线之前续上
    assert.equal(lease.owner()?.sessionId, "A");
    clock.advance(60_000);
    assert.equal(lease.owner(), null);
  });

  test("空闲自动释放时没有等待者 → 锁空着，owner 为 null", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "任务甲");
    clock.advance(COMPUTER_USE_LEASE.idleMs);
    assert.equal(lease.owner(), null);
    assert.equal(lease.queueDepth(), 0);
  });
});

describe("沙箱租约：硬上限", () => {
  test("15 分钟到点强制释放，续期也拦不住", async () => {
    const { lease, clock, events } = setup();
    await lease.acquire("A", "任务甲");
    // 每 30 秒续一次：idle 永远不会到点，只有硬上限会
    for (let elapsed = 0; elapsed < COMPUTER_USE_LEASE.holdMaxMs - 30_000; elapsed += 30_000) {
      clock.advance(30_000);
      lease.renew("A");
      assert.equal(lease.owner()?.sessionId, "A");
    }
    clock.advance(30_000);
    assert.equal(lease.owner(), null);
    assert.ok(
      events.some(
        (event) => event.type === "released" && event.reason === "holdExpired" && event.sessionId === "A",
      ),
    );
  });

  test("硬上限到点时排队者还没超时 → 直接接手（沙箱还在，不该让下一位也失败）", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "任务甲");
    // 让 B 在硬上限到点前 10 秒才进队：它的 30s 超时线落在上限之后
    clock.advance(COMPUTER_USE_LEASE.holdMaxMs - 10_000);
    lease.renew("A");
    const waiting = lease.acquire("B", "任务乙");
    clock.advance(10_000);
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(lease.owner()?.sessionId, "B");
  });
});

describe("沙箱租约：revoke（沙箱被停 / 进 error）", () => {
  test("持有者与全部等待者立刻拿到「沙箱已关闭」，不等到 30 秒", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "任务甲");
    const b = lease.acquire("B", "任务乙");
    const c = lease.acquire("C", "任务丙");
    lease.revoke("用户停掉了沙箱");
    const [rb, rc] = await Promise.all([b, c]);
    assert.equal(rb.ok, false);
    assert.equal(rc.ok, false);
    if (!rb.ok) {
      assert.match(rb.error, /沙箱已经关闭/);
      assert.match(rb.error, /用户停掉了沙箱/);
      assert.match(rb.error, /不要重试/);
    }
    assert.equal(lease.owner(), null);
    assert.equal(lease.queueDepth(), 0);
    // 时钟一动也不动就全部落定——这正是 revoke 与「等满 30s」的区别
    clock.advance(0);
  });

  test("revoke 之后新的 acquire 能成功（沙箱重启复用同一把租约对象）", async () => {
    const { lease } = setup();
    await lease.acquire("A", "任务甲");
    lease.revoke("沙箱进 error");
    assert.deepEqual(await lease.acquire("A", "任务甲"), { ok: true });
  });

  test("排队中的会话被 release（abort / 关会话）→ 撤出队列并回错误，不占名额", async () => {
    const { lease } = setup();
    await lease.acquire("A", "任务甲");
    const b = lease.acquire("B", "任务乙");
    lease.release("B", "会话被关掉了");
    const result = await b;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /不要重试/);
    assert.equal(lease.queueDepth(), 0);
    assert.equal(lease.owner()?.sessionId, "A"); // 持有者不受影响
  });
});

describe("沙箱租约：接线层 runWithLease", () => {
  /** 假的下发回执：与 ComputerUseToolOutcome 同形，用来验「拿到才下发、没拿到一次也不下发」 */
  type RunOutcome = { ok: true; text: string } | { ok: false; error: string };

  test("拿不到租约时**不调用**下发（调用次数 0），错误原样交给模型", async () => {
    const { lease } = setup();
    await lease.acquire("A", "任务甲");
    let calls = 0;
    // 先别 await：B 会排队悬着。拿到 Promise 之后 revoke 把它结掉
    const pending = runWithLease<RunOutcome>({
      lease,
      sessionId: "B",
      title: "任务乙",
      run: async () => {
        calls += 1;
        return { ok: true, text: "不该走到这里" };
      },
      rejected: (error) => ({ ok: false, error }),
    });
    assert.equal(lease.queueDepth(), 1);
    lease.revoke("用例收尾");
    const outcome = await pending;
    assert.equal(calls, 0);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /沙箱已经关闭/);
    assert.equal(lease.queueDepth(), 0);
  });

  test("拿到租约才下发，下发的返回值原样交回去", async () => {
    const { lease } = setup();
    let calls = 0;
    const outcome = await runWithLease<RunOutcome>({
      lease,
      sessionId: "A",
      title: "任务甲",
      run: async () => {
        calls += 1;
        return { ok: true, text: "点完了" };
      },
      rejected: (error) => ({ ok: false, error }),
    });
    assert.equal(calls, 1);
    assert.deepEqual(outcome, { ok: true, text: "点完了" });
    assert.equal(lease.owner()?.sessionId, "A");
  });

  test("下发抛错：错误照旧上抛，但锁已经续过（模型紧接着重试还能拿到）", async () => {
    const { lease, clock } = setup();
    await assert.rejects(
      runWithLease<RunOutcome>({
        lease,
        sessionId: "A",
        title: "任务甲",
        run: async () => {
          clock.advance(50_000);
          throw new Error("文件协议炸了");
        },
        rejected: (error) => ({ ok: false, error }),
      }),
      /文件协议炸了/,
    );
    // 50s 时抛的错，但 finally 里续过期 → 再走 50s 仍然持有（idle 线从续期点重算）
    clock.advance(50_000);
    assert.equal(lease.owner()?.sessionId, "A");
    clock.advance(10_000);
    assert.equal(lease.owner(), null);
  });

  test("超时被拒绝的会话：下发一次都没发生，错误里点名占用者", async () => {
    const { lease, clock } = setup();
    await lease.acquire("A", "整理发票");
    let calls = 0;
    const pending = runWithLease<RunOutcome>({
      lease,
      sessionId: "B",
      title: "任务乙",
      run: async () => {
        calls += 1;
        return { ok: true, text: "" };
      },
      rejected: (error) => ({ ok: false, error }),
    });
    clock.advance(COMPUTER_USE_LEASE.waitMs);
    const outcome = await pending;
    assert.equal(calls, 0);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /整理发票/);
  });
});
