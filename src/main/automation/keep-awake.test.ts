import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { KeepAwake, type PowerBlocker } from "./keep-awake.ts";

/** 假 blocker：只记 start / stop，不碰系统 */
function fakeBlocker(): PowerBlocker & { starts: number; stops: number[]; live: Set<number> } {
  let next = 100;
  const live = new Set<number>();
  const state = {
    starts: 0,
    stops: [] as number[],
    live,
    start(): number {
      next += 1;
      state.starts += 1;
      live.add(next);
      return next;
    },
    stop(id: number): void {
      state.stops.push(id);
      live.delete(id);
    },
  };
  return state;
}

describe("KeepAwake：只在有运行在执行、且设置开着时才拦", () => {
  test("设置关着：有运行也不拦", async () => {
    const blocker = fakeBlocker();
    const keep = new KeepAwake(blocker, async () => false);
    await keep.sync(2);
    assert.equal(blocker.starts, 0);
    assert.equal(keep.isHolding(), false);
  });

  test("设置开着：运行数 0 → 1 拦住，1 → 0 放开；多个运行只拦一次", async () => {
    const blocker = fakeBlocker();
    const keep = new KeepAwake(blocker, async () => true);
    await keep.sync(0);
    assert.equal(blocker.starts, 0);
    await keep.sync(1);
    assert.equal(blocker.starts, 1);
    assert.equal(keep.isHolding(), true);
    await keep.sync(3);
    await keep.sync(2);
    assert.equal(blocker.starts, 1, "已拦着时不重复 start");
    await keep.sync(0);
    assert.equal(blocker.live.size, 0);
    assert.equal(keep.isHolding(), false);
    await keep.sync(1);
    assert.equal(blocker.starts, 2, "下一批运行重新拦");
  });

  test("运行中途用户关掉设置：不带参数的 sync 按当前数重对一次，立刻放开", async () => {
    const blocker = fakeBlocker();
    let enabled = true;
    const keep = new KeepAwake(blocker, async () => enabled);
    await keep.sync(1);
    assert.equal(keep.isHolding(), true);
    enabled = false;
    await keep.sync();
    assert.equal(keep.isHolding(), false);
    // 再打开：运行还在跑，就重新拦
    enabled = true;
    await keep.sync();
    assert.equal(keep.isHolding(), true);
  });

  test("连续的 sync 串行：设置读取很慢时也不会先放后拦错序", async () => {
    const blocker = fakeBlocker();
    const keep = new KeepAwake(blocker, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    });
    // 同一拍里连发：1 → 0 → 1，最终状态必须是拦着（最后一个数说了算）
    const done = [keep.sync(1), keep.sync(0), keep.sync(1)];
    await Promise.all(done);
    assert.equal(keep.isHolding(), true);
    assert.equal(blocker.live.size, 1);
  });

  test("拦住 / 放开各回调一次（状态没变不回调）", async () => {
    const blocker = fakeBlocker();
    const changes: boolean[] = [];
    const keep = new KeepAwake(blocker, async () => true, (holding) => changes.push(holding));
    await keep.sync(1);
    await keep.sync(2);
    await keep.sync(0);
    await keep.sync(0);
    await keep.sync(1);
    keep.release();
    assert.deepEqual(changes, [true, false, true, false]);
  });

  test("release 无条件放开（应用退出，不读设置）", async () => {
    const blocker = fakeBlocker();
    const keep = new KeepAwake(blocker, async () => true);
    await keep.sync(1);
    keep.release();
    assert.equal(blocker.live.size, 0);
    assert.equal(keep.isHolding(), false);
    keep.release(); // 幂等
    assert.equal(blocker.stops.length, 1);
  });

  test("读设置抛错不卡死后面的 sync", async () => {
    const blocker = fakeBlocker();
    let fail = true;
    const keep = new KeepAwake(blocker, async () => {
      if (fail) throw new Error("读不了");
      return true;
    });
    await assert.rejects(keep.sync(1));
    fail = false;
    await keep.sync(1);
    assert.equal(keep.isHolding(), true);
  });
});
