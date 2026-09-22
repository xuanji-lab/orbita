import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createProgressCoalescer } from "./progress-coalescer.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createProgressCoalescer", () => {
  test("窗口内的多帧攒成一批，apply 只调用一次", async () => {
    const batches: number[][] = [];
    const coalescer = createProgressCoalescer<number>((batch) => batches.push([...batch]), 30);
    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);
    assert.equal(batches.length, 0); // 窗口内不交付
    await sleep(80);
    assert.deepEqual(batches, [[1, 2, 3]]);
    coalescer.dispose();
  });

  test("flush 后重新起拍：下一帧进新的一批", async () => {
    const batches: number[][] = [];
    const coalescer = createProgressCoalescer<number>((batch) => batches.push([...batch]), 30);
    coalescer.push(1);
    await sleep(80);
    coalescer.push(2);
    await sleep(80);
    assert.deepEqual(batches, [[1], [2]]);
    coalescer.dispose();
  });

  test("dispose 丢弃未 flush 的帧，之后不再交付", async () => {
    const batches: number[][] = [];
    const coalescer = createProgressCoalescer<number>((batch) => batches.push([...batch]), 30);
    coalescer.push(1);
    coalescer.dispose();
    await sleep(80);
    assert.deepEqual(batches, []);
  });

  test("flush() 立刻交付攒着的帧：后来的事件不会赶超排队中的 progress", async () => {
    const order: string[] = [];
    const coalescer = createProgressCoalescer<number>(
      (batch) => order.push(`batch:${batch.join(",")}`),
      30,
    );
    coalescer.push(1);
    coalescer.push(2);
    coalescer.flush();
    order.push("phase:idle"); // 即时事件在 flush 之后应用
    assert.deepEqual(order, ["batch:1,2", "phase:idle"]);
    // flush 后定时器归零：下一帧重新起拍，不会把已交付的重发一遍
    coalescer.push(3);
    await sleep(80);
    assert.deepEqual(order, ["batch:1,2", "phase:idle", "batch:3"]);
    coalescer.dispose();
  });

  test("flush() 没攒着帧时不调 apply", () => {
    let calls = 0;
    const coalescer = createProgressCoalescer<number>(() => {
      calls++;
    }, 30);
    coalescer.flush();
    assert.equal(calls, 0);
    coalescer.dispose();
  });

  test("空批不触发 apply", async () => {
    let calls = 0;
    const coalescer = createProgressCoalescer<number>(() => {
      calls++;
    }, 30);
    coalescer.dispose(); // 没推过任何帧：定时器都不该存在
    await sleep(60);
    assert.equal(calls, 0);
  });
});
