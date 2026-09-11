/**
 * turn-cycle 的回归网 —— B2 无状态化的核心不变量（文档 B5）：
 *   submit 跑完 running 空 / 同 id 在跑再 submit 抛 already running /
 *   abort 后收尾出表 / dispose 直杀后收尾不再二次 dispose /
 *   open 期间的 abort 在 open 完成时兑现 / settled 晚于出表。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { abortCycle, killCycle, startCycle, type CycleParts, type CycleSlot } from "./turn-cycle.ts";

/** 手排进度的假对象：open 由测试用 deferred 控制「何时开完」。 */
class FakeParts implements CycleParts {
  readonly calls: string[] = [];
  abort(): void {
    this.calls.push("abort");
  }
  dispose(): void {
    this.calls.push("dispose");
  }
  unsubscribe(): void {
    this.calls.push("unsubscribe");
  }
}

const defer = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const newTable = (): Map<string, CycleSlot<FakeParts>> => new Map();

/** 排空微任务：open promise 的 resolve 传播到 slot.opened 赋值需要一跳。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("startCycle —— 占坑与双开保险丝", () => {
  test("跑完后 running 为空，收尾序 = 退订 → dispose → 出表 → settled", async () => {
    const running = newTable();
    const settledOrder: string[] = [];
    const parts = new FakeParts();
    const lifecycle = startCycle(
      running,
      "s1",
      async () => parts,
      async () => {
        assert.equal(running.has("s1"), true, "跑的时候坑要在");
      },
      () => {
        assert.equal(running.has("s1"), false, "settled 回调时已出表");
        settledOrder.push("settled");
      },
    );
    await lifecycle;
    assert.equal(running.has("s1"), false, "跑完 running 为空");
    assert.deepEqual(parts.calls, ["unsubscribe", "dispose"]);
    assert.deepEqual(settledOrder, ["settled"]);
  });

  test("同 id 还在跑（含还在 open）再 start → 抛 already running，不开第二本", async () => {
    const running = newTable();
    const gate = defer<FakeParts>();
    const first = startCycle(running, "s1", () => gate.promise, async () => {}, () => {});
    // open 还挂着（占坑期）：第二个 start 必须被保险丝拦下（同步拒绝，不给它开第二本的机会）
    assert.throws(
      () => startCycle(running, "s1", async () => new FakeParts(), async () => {}, () => {}),
      /already running/,
    );
    gate.resolve(new FakeParts());
    await first;
  });

  test("跑中再 start 同样被拦；上一轮结束后可再开", async () => {
    const running = newTable();
    const parts = new FakeParts();
    const gate = defer<FakeParts>();
    const hold = defer<void>();
    const first = startCycle(running, "s1", () => gate.promise, () => hold.promise, () => {});
    gate.resolve(parts);
    await flush(); // open 完成、坑里是跑态
    assert.throws(
      () => startCycle(running, "s1", async () => new FakeParts(), async () => {}, () => {}),
      /already running/,
    );
    hold.resolve();
    await first;
    // 收尾完成，坑已空：可以再开
    await startCycle(running, "s1", async () => new FakeParts(), async () => {}, () => {});
    assert.equal(running.has("s1"), false);
  });
});

describe("abortCycle —— open 期间与跑中两条路", () => {
  test("open 期间到达的 abort 记账，open 一完成立刻兑现（不被开机竞态吞掉）", async () => {
    const running = newTable();
    const gate = defer<FakeParts>();
    const parts = new FakeParts();
    const lifecycle = startCycle(running, "s1", () => gate.promise, async () => {}, () => {});
    abortCycle(running, "s1"); // 此时 parts 还没 open 出来
    assert.deepEqual(parts.calls, [], "open 前无对象可停");
    gate.resolve(parts);
    await lifecycle;
    assert.ok(parts.calls.includes("abort"), "open 完成后兑现 abort");
    assert.equal(running.has("s1"), false, "收尾照常出表");
  });

  test("跑中 abort：对象当场停，轮结束后 running 空", async () => {
    const running = newTable();
    const parts = new FakeParts();
    const gate = defer<FakeParts>();
    const hold = defer<void>();
    const lifecycle = startCycle(running, "s1", () => gate.promise, () => hold.promise, () => {});
    gate.resolve(parts);
    await flush(); // open 完成，对象已在坑里
    abortCycle(running, "s1");
    assert.deepEqual(parts.calls, ["abort"]);
    hold.resolve();
    await lifecycle;
    assert.equal(running.has("s1"), false);
  });

  test("没在跑就静默（abort 对空闲会话是 no-op）", () => {
    const running = newTable();
    abortCycle(running, "never");
    assert.equal(running.size, 0);
  });

  test("preempt 抢跑：收尾不发 settled——退订 / dispose / 出表照走", async () => {
    const running = newTable();
    const parts = new FakeParts();
    const gate = defer<FakeParts>();
    const hold = defer<void>();
    let settled = 0;
    const lifecycle = startCycle(
      running,
      "s1",
      () => gate.promise,
      () => hold.promise,
      () => {
        settled += 1;
      },
    );
    gate.resolve(parts);
    await flush();
    abortCycle(running, "s1", { preempt: true });
    hold.resolve();
    await lifecycle;
    assert.deepEqual(parts.calls, ["abort", "unsubscribe", "dispose"], "收尾序照走");
    assert.equal(running.has("s1"), false, "照常出表");
    assert.equal(settled, 0, "抢跑的旧轮不发 settled——中间没有「空闲」");
  });

  test("不传 preempt 的 abort 照旧发 settled（stop 的投递链依赖它）", async () => {
    const running = newTable();
    const parts = new FakeParts();
    const gate = defer<FakeParts>();
    const hold = defer<void>();
    let settled = 0;
    const lifecycle = startCycle(
      running,
      "s1",
      () => gate.promise,
      () => hold.promise,
      () => {
        settled += 1;
      },
    );
    gate.resolve(parts);
    await flush();
    abortCycle(running, "s1"); // 普通 stop：不 preempt
    hold.resolve();
    await lifecycle;
    assert.equal(settled, 1, "stop 的 idle 要发——队列接着投递靠它");
  });
});

describe("killCycle —— 删除会话的直杀", () => {
  test("dispose 立刻执行；收尾跳过二次 dispose，退订与出表仍做", async () => {
    const running = newTable();
    const parts = new FakeParts();
    const gate = defer<FakeParts>();
    const hold = defer<void>();
    const lifecycle = startCycle(running, "s1", () => gate.promise, () => hold.promise, () => {});
    gate.resolve(parts);
    await flush(); // open 完成，对象已在坑里
    const killed = killCycle(running, "s1");
    assert.deepEqual(parts.calls, ["dispose"], "直杀当场执行");
    hold.resolve(); // run 的 promise 结束，收尾序列跑
    await Promise.all([lifecycle, killed]);
    assert.deepEqual(parts.calls, ["dispose", "unsubscribe"], "没有第二次 dispose");
    assert.equal(running.has("s1"), false);
  });

  test("没在跑：返回已结的 promise，不碰表", async () => {
    const running = newTable();
    await killCycle(running, "never");
    assert.equal(running.size, 0);
  });
});

describe("收尾不因 run 抛错而漏 —— finally 语义", () => {
  test("run 抛错：退订 / dispose / 出表 / settled 照走，错误原样冒泡", async () => {
    const running = newTable();
    const parts = new FakeParts();
    let settled = false;
    const lifecycle = startCycle(
      running,
      "s1",
      async () => parts,
      async () => {
        throw new Error("模型调用失败");
      },
      () => {
        settled = true;
      },
    );
    await assert.rejects(lifecycle, /模型调用失败/);
    assert.deepEqual(parts.calls, ["unsubscribe", "dispose"]);
    assert.equal(running.has("s1"), false);
    assert.equal(settled, true, "失败轮也要发 idle——renderer 的槽不能停在 turn");
  });
});
