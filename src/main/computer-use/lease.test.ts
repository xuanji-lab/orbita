/**
 * 沙箱租约（main/computer-use/lease.ts）：按资源分键 —— 桌面独占、每会话一个浏览器。
 *
 * 时钟与定时器全是假的（fakeClock），所以 30s / 60s / 15min 这几条线都是真断言，不是
 * 睡眠——真等 15 分钟跑一遍的测试不会有人跑第二遍。每条用例只碰一个性质：宁可多几条
 * 用例，也不要一条「顺便把别的也验了」的巨型断言（挂了不知道断在哪）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createComputerUseLease, runWithLease, type LeaseClock, type LeaseEvent } from "./lease.ts";
import {
  COMPUTER_USE_DESKTOP_KEY,
  COMPUTER_USE_LEASE,
  browserKey,
} from "../../shared/computer-use.ts";

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
  const lease = createComputerUseLease({ clock, onEvent: (event) => events.push(event) });
  return { clock, lease, events };
};

/** 把「悬着的 Promise」变成可断言的「现在是否已落定」：租约的等待不该被意外提前唤醒 */
async function state<T>(pending: Promise<T>): Promise<"pending" | T> {
  const marker = Symbol("pending");
  const result = await Promise.race([pending, Promise.resolve(marker)]);
  return result === marker ? "pending" : (result as T);
}

const DESKTOP = COMPUTER_USE_DESKTOP_KEY;

describe("租约：按资源分键", () => {
  test("A 持桌面时 B 的浏览器键立即可用（网页任务不再被桌面串行）", async () => {
    const { lease, clock } = setup();
    assert.deepEqual(await lease.acquire(DESKTOP, "A", "任务甲"), { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");

    // 同一时刻 B 要自己的浏览器键：不等、不排队
    assert.deepEqual(await lease.acquire(browserKey("B"), "B", "任务乙"), { ok: true });
    assert.equal(lease.owner(browserKey("B"))?.sessionId, "B");
    assert.equal(lease.queueDepth(DESKTOP), 0);
    clock.advance(0);
  });

  test("浏览器键不因 idle 放手，也不吃 15 分钟硬上限（它没占别人的东西）", async () => {
    const { lease, clock, events } = setup();
    await lease.acquire(browserKey("A"), "A", "任务甲");
    clock.advance(COMPUTER_USE_LEASE.idleMs);
    assert.equal(lease.owner(browserKey("A"))?.sessionId, "A");
    clock.advance(COMPUTER_USE_LEASE.holdMaxMs);
    assert.equal(lease.owner(browserKey("A"))?.sessionId, "A");
    assert.equal(events.filter((event) => event.type === "released").length, 0);
  });

  test("idle / 硬上限按 key 独立：桌面到点收回，浏览器键还在", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    await lease.acquire(browserKey("A"), "A", "任务甲");

    clock.advance(COMPUTER_USE_LEASE.idleMs);
    assert.equal(lease.owner(DESKTOP), null); // idle 线到点
    assert.equal(lease.owner(browserKey("A"))?.sessionId, "A");

    // 重新拿桌面，这次每 30s 续一次 → idle 不会到点，只有 15 分钟硬上限会
    await lease.acquire(DESKTOP, "A", "任务甲");
    for (let elapsed = 0; elapsed < COMPUTER_USE_LEASE.holdMaxMs - 30_000; elapsed += 30_000) {
      clock.advance(30_000);
      lease.renew(DESKTOP, "A");
    }
    clock.advance(30_000);
    assert.equal(lease.owner(DESKTOP), null);
    assert.equal(lease.owner(browserKey("A"))?.sessionId, "A");
  });

  test("浏览器键被另一个会话错拿 → 当场拒绝（不排一条没有超时线的队）", async () => {
    const { lease, clock } = setup();
    await lease.acquire(browserKey("A"), "A", "任务甲");
    const result = await lease.acquire(browserKey("A"), "B", "任务乙");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /不排队/);
      assert.match(result.error, /任务甲/);
      assert.match(result.error, /不要重试/);
    }
    // 时钟一动也不动就落定，队列里也没留下东西
    clock.advance(0);
    assert.equal(lease.queueDepth(browserKey("A")), 0);
  });

  test("同一个会话在两个键上互不干扰：桌面让掉不影响它自己的浏览器", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    await lease.acquire(browserKey("A"), "A", "任务甲");
    lease.release(DESKTOP, "A");
    assert.equal(lease.owner(DESKTOP), null);
    assert.equal(lease.owner(browserKey("A"))?.sessionId, "A");
  });
});

describe("桌面键：独占", () => {
  test("A 持有期间 B 拿不到；A 释放后 B 立刻拿到", async () => {
    const { lease } = setup();
    assert.deepEqual(await lease.acquire(DESKTOP, "A", "任务甲"), { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");

    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    assert.equal(await state(waiting), "pending");
    assert.equal(lease.queueDepth(DESKTOP), 1);

    lease.release(DESKTOP, "A");
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "B");
    assert.equal(lease.queueDepth(DESKTOP), 0);
  });

  test("同一个会话重复 acquire 是幂等的（它在手上的命令每条都问一次）", async () => {
    const { lease, events } = setup();
    assert.deepEqual(await lease.acquire(DESKTOP, "A", "任务甲"), { ok: true });
    assert.deepEqual(await lease.acquire(DESKTOP, "A", "任务甲"), { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
    // 只有一次真正的「拿到」，重复的那次只是续期
    assert.equal(events.filter((event) => event.type === "acquired").length, 1);
    assert.equal(lease.queueDepth(DESKTOP), 0);
  });

  test("非持有者的 renew / release 是 no-op（不报错、不抢锁）", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    lease.renew(DESKTOP, "B");
    lease.release(DESKTOP, "B");
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
  });

  test("排队中的会话被 release（abort / 关会话）→ 撤出队列并回错误，不占名额", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const b = lease.acquire(DESKTOP, "B", "任务乙");
    lease.release(DESKTOP, "B");
    const result = await b;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /不要重试/);
    assert.equal(lease.queueDepth(DESKTOP), 0);
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A"); // 持有者不受影响
  });

  test("releaseSession 一次放掉这个会话的所有键（轮次结束 / 会话删除）", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    await lease.acquire(browserKey("A"), "A", "任务甲");
    await lease.acquire(browserKey("B"), "B", "任务乙");
    lease.releaseSession("A");
    assert.equal(lease.owner(DESKTOP), null);
    assert.equal(lease.owner(browserKey("A")), null);
    assert.equal(lease.owner(browserKey("B"))?.sessionId, "B"); // 别人的不动
  });
});

describe("桌面键：FIFO", () => {
  test("B、C、D 按到达顺序接手（不是按等待时长，也不是随机）", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const b = lease.acquire(DESKTOP, "B", "任务乙");
    const c = lease.acquire(DESKTOP, "C", "任务丙");
    const d = lease.acquire(DESKTOP, "D", "任务丁");
    assert.equal(lease.queueDepth(DESKTOP), 3);

    lease.release(DESKTOP, "A");
    assert.deepEqual(await b, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "B");
    assert.equal(lease.queueDepth(DESKTOP), 2);

    lease.release(DESKTOP, "B");
    assert.deepEqual(await c, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "C");

    lease.release(DESKTOP, "C");
    assert.deepEqual(await d, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "D");
    assert.equal(lease.queueDepth(DESKTOP), 0);
  });

  test("同一个会话在队列里只占一个位置（两条并发的命令不分到两个位置）", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const b1 = lease.acquire(DESKTOP, "B", "任务乙");
    const b2 = lease.acquire(DESKTOP, "B", "任务乙");
    assert.equal(lease.queueDepth(DESKTOP), 1);
    lease.release(DESKTOP, "A");
    assert.deepEqual(await b1, { ok: true });
    assert.deepEqual(await b2, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "B");
  });

  test("排队的会话各自看自己的键：桌面在排队，浏览器照样能拿", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const b = lease.acquire(DESKTOP, "B", "任务乙");
    assert.equal(lease.queueDepth(DESKTOP), 1);
    assert.deepEqual(await lease.acquire(browserKey("B"), "B", "任务乙"), { ok: true });
    lease.release(DESKTOP, "A");
    assert.deepEqual(await b, { ok: true });
  });
});

describe("桌面键：有界等待", () => {
  test("等满 30 秒没等到 → 拒绝，文案点名占用者与「不要重试」", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "整理发票");
    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    clock.advance(COMPUTER_USE_LEASE.waitMs - 1);
    assert.equal(await state(waiting), "pending");
    clock.advance(1);
    const result = await waiting;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /整理发票/); // 占用者标题
    assert.match(result.error, /不要重试/);
    assert.match(result.error, /30 秒/);
    assert.equal(lease.queueDepth(DESKTOP), 0); // 超时的等待者撤出队列，不占名额
  });

  test("占用者没有标题时不硬塞一对空引号", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "");
    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    clock.advance(COMPUTER_USE_LEASE.waitMs);
    const result = await waiting;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.doesNotMatch(result.error, /「」/);
    assert.match(result.error, /不要重试/);
  });

  test("队列上限 8：第 9 个不等，直接拒绝", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const waiting = [];
    for (let index = 1; index <= COMPUTER_USE_LEASE.queueLimit; index += 1) {
      waiting.push(lease.acquire(DESKTOP, `W${String(index)}`, `排队者 ${String(index)}`));
    }
    assert.equal(lease.queueDepth(DESKTOP), COMPUTER_USE_LEASE.queueLimit);

    const ninth = await lease.acquire(DESKTOP, "W9", "第九个");
    assert.equal(ninth.ok, false);
    if (!ninth.ok) {
      assert.match(ninth.error, /上限（8 个）/);
      assert.match(ninth.error, /不要重试/);
    }
    // 被拒绝的那个没有占队列（第 9 个不在队列里，队列深度不变）
    assert.equal(lease.queueDepth(DESKTOP), COMPUTER_USE_LEASE.queueLimit);

    // 收尾：把排队的都放掉，别让悬着的定时器跑进下一个用例
    lease.revoke("用例结束");
    clock.advance(COMPUTER_USE_LEASE.waitMs);
    for (const item of waiting) await item;
  });
});

describe("桌面键：idle 与续期", () => {
  test("60 秒无命令自动释放，锁给队列头", async () => {
    const { lease, clock, events } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    // B 在 idle 线之前很久进来：先走到 45s 再让 B 排队，于是 B 的 30s 超时
    // （75s 到点）落在 idle（60s）之后——这轮先到的是 idle
    clock.advance(45_000);
    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    clock.advance(15_000 - 1);
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
    clock.advance(1);
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "B");
    assert.ok(events.some((event) => event.type === "released" && event.reason === "idle"));
  });

  test("每条命令续期能续命：59 秒一次命令就一直持有", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    for (let index = 0; index < 5; index += 1) {
      clock.advance(59_000);
      lease.renew(DESKTOP, "A");
    }
    // 5 轮 × 59s = 295s，远超 60s，但每次都在 idle 线之前续上
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
    clock.advance(60_000);
    assert.equal(lease.owner(DESKTOP), null);
  });

  test("空闲自动释放时没有等待者 → 锁空着，owner 为 null", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    clock.advance(COMPUTER_USE_LEASE.idleMs);
    assert.equal(lease.owner(DESKTOP), null);
    assert.equal(lease.queueDepth(DESKTOP), 0);
  });
});

describe("桌面键：硬上限", () => {
  test("15 分钟到点强制释放，续期也拦不住", async () => {
    const { lease, clock, events } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    // 每 30 秒续一次：idle 永远不会到点，只有硬上限会
    for (let elapsed = 0; elapsed < COMPUTER_USE_LEASE.holdMaxMs - 30_000; elapsed += 30_000) {
      clock.advance(30_000);
      lease.renew(DESKTOP, "A");
      assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
    }
    clock.advance(30_000);
    assert.equal(lease.owner(DESKTOP), null);
    assert.ok(
      events.some(
        (event) => event.type === "released" && event.reason === "holdExpired" && event.sessionId === "A",
      ),
    );
  });

  test("硬上限到点时排队者还没超时 → 直接接手（沙箱还在，不该让下一位也失败）", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    // 让 B 在硬上限到点前 10 秒才进队：它的 30s 超时线落在上限之后
    clock.advance(COMPUTER_USE_LEASE.holdMaxMs - 10_000);
    lease.renew(DESKTOP, "A");
    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    clock.advance(10_000);
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(lease.owner(DESKTOP)?.sessionId, "B");
  });
});

describe("租约：revoke（沙箱被停 / 进 error）——所有键一起清", () => {
  test("桌面持有者、浏览器持有者与全部等待者立刻拿到「沙箱已关闭」", async () => {
    const { lease, clock, events } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    await lease.acquire(browserKey("A"), "A", "任务甲");
    const b = lease.acquire(DESKTOP, "B", "任务乙");
    const c = lease.acquire(DESKTOP, "C", "任务丙");
    lease.revoke("用户停掉了沙箱");
    const [rb, rc] = await Promise.all([b, c]);
    assert.equal(rb.ok, false);
    assert.equal(rc.ok, false);
    if (!rb.ok) {
      assert.match(rb.error, /沙箱已经关闭/);
      assert.match(rb.error, /用户停掉了沙箱/);
      assert.match(rb.error, /不要重试/);
    }
    assert.equal(lease.owner(DESKTOP), null);
    assert.equal(lease.owner(browserKey("A")), null); // 浏览器也在沙箱里
    assert.equal(lease.queueDepth(DESKTOP), 0);
    // 时钟一动也不动就全部落定——这正是 revoke 与「等满 30s」的区别
    clock.advance(0);
    const revoked = events.find((event) => event.type === "revoked");
    assert.ok(revoked !== undefined && revoked.type === "revoked" && revoked.keys === 2);
  });

  test("revoke 之后新的 acquire 能成功（沙箱重启复用同一把租约对象）", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    await lease.acquire(browserKey("A"), "A", "任务甲");
    lease.revoke("沙箱进 error");
    assert.deepEqual(await lease.acquire(DESKTOP, "A", "任务甲"), { ok: true });
    assert.deepEqual(await lease.acquire(browserKey("A"), "A", "任务甲"), { ok: true });
  });
});

describe("租约：审计（waitedMs / heldMs / queueDepth / stats）", () => {
  test("拿到 / 放手 / 拒绝都记一条，字段是这次的真实数字", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    clock.advance(2_000);
    lease.release(DESKTOP, "A"); // B 接手的 waitedMs = 2000
    assert.deepEqual(await waiting, { ok: true });
    clock.advance(500);
    lease.release(DESKTOP, "B");

    const audit = lease.audit();
    const acquired = audit.filter((entry) => entry.kind === "acquired");
    assert.equal(acquired.length, 2);
    assert.deepEqual(
      acquired.map((entry) => [entry.key, entry.sessionId, entry.waitedMs]),
      [
        [DESKTOP, "A", 0],
        [DESKTOP, "B", 2_000],
      ],
    );
    const released = audit.filter((entry) => entry.kind === "released");
    assert.deepEqual(
      released.map((entry) => [entry.sessionId, entry.heldMs, entry.queueDepth]),
      [
        // A 放手那一刻 B 还在队列里（队列深度是当时的真实值）
        ["A", 2_000, 1],
        ["B", 500, 0],
      ],
    );
    // 每次记录的都带时刻
    for (const entry of audit) assert.ok(entry.at > 0);

    const stats = lease.stats().find((row) => row.key === DESKTOP);
    assert.ok(stats !== undefined);
    assert.equal(stats.acquired, 2);
    assert.equal(stats.released, 2);
    assert.equal(stats.rejected, 0);
    assert.equal(stats.averageWaitMs, 1_000); // (0 + 2000) / 2
    assert.equal(stats.averageHeldMs, 1_250); // (2000 + 500) / 2
    assert.equal(stats.owner, null);
  });

  test("拒绝也进账：超时记下真实等待，按 key 分开统计", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    const waiting = lease.acquire(DESKTOP, "B", "任务乙");
    clock.advance(COMPUTER_USE_LEASE.waitMs);
    await waiting;
    await lease.acquire(browserKey("A"), "A", "任务甲");

    const audit = lease.audit();
    const rejected = audit.filter((entry) => entry.kind === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.waitedMs, COMPUTER_USE_LEASE.waitMs);

    const desktop = lease.stats().find((row) => row.key === DESKTOP);
    const browser = lease.stats().find((row) => row.key === browserKey("A"));
    assert.ok(desktop !== undefined && browser !== undefined);
    assert.equal(desktop.rejected, 1);
    assert.equal(desktop.acquired, 1);
    assert.equal(browser.acquired, 1);
    assert.equal(browser.rejected, 0);
    assert.equal(browser.averageWaitMs, 0); // 自己的浏览器永远立刻可用
    assert.equal(browser.owner, "A");
  });
});

describe("租约：接线层 runWithLease", () => {
  /** 假的下发回执：与 ComputerUseToolOutcome 同形，用来验「拿到才下发、没拿到一次也不下发」 */
  type RunOutcome = { ok: true; text: string } | { ok: false; error: string };

  test("拿不到租约时**不调用**下发（调用次数 0），错误原样交给模型", async () => {
    const { lease } = setup();
    await lease.acquire(DESKTOP, "A", "任务甲");
    let calls = 0;
    // 先别 await：B 会排队悬着。拿到 Promise 之后 revoke 把它结掉
    const pending = runWithLease<RunOutcome>({
      lease,
      key: DESKTOP,
      sessionId: "B",
      title: "任务乙",
      run: async () => {
        calls += 1;
        return { ok: true, text: "不该走到这里" };
      },
      rejected: (error) => ({ ok: false, error }),
    });
    assert.equal(lease.queueDepth(DESKTOP), 1);
    lease.revoke("用例收尾");
    const outcome = await pending;
    assert.equal(calls, 0);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /沙箱已经关闭/);
    assert.equal(lease.queueDepth(DESKTOP), 0);
  });

  test("拿到租约才下发，下发的返回值原样交回去", async () => {
    const { lease } = setup();
    let calls = 0;
    const outcome = await runWithLease<RunOutcome>({
      lease,
      key: DESKTOP,
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
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
  });

  test("下发抛错：错误照旧上抛，但锁已经续过（模型紧接着重试还能拿到）", async () => {
    const { lease, clock } = setup();
    await assert.rejects(
      runWithLease<RunOutcome>({
        lease,
        key: DESKTOP,
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
    assert.equal(lease.owner(DESKTOP)?.sessionId, "A");
    clock.advance(10_000);
    assert.equal(lease.owner(DESKTOP), null);
  });

  test("超时被拒绝的会话：下发一次都没发生，错误里点名占用者", async () => {
    const { lease, clock } = setup();
    await lease.acquire(DESKTOP, "A", "整理发票");
    let calls = 0;
    const pending = runWithLease<RunOutcome>({
      lease,
      key: DESKTOP,
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
