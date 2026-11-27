import assert from "node:assert/strict";
import { test } from "node:test";
import { createDedupe, createLimiter, webThumbKey } from "./web-thumb-queue.ts";

test("缓存键：路径、mtime、大小任一变了都不同", () => {
  const base = webThumbKey("/a.html", 100, 10);
  assert.equal(base, webThumbKey("/a.html", 100.4, 10));
  assert.notEqual(base, webThumbKey("/b.html", 100, 10));
  assert.notEqual(base, webThumbKey("/a.html", 101, 10));
  assert.notEqual(base, webThumbKey("/a.html", 100, 11));
});

test("限并发：同时在跑的不超过上限，按到达顺序执行", async () => {
  const limit = createLimiter(1);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (n: number) =>
    limit(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(n);
      running -= 1;
      return n;
    });
  const results = await Promise.all([job(1), job(2), job(3)]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(peak, 1);
});

test("限并发：一个任务抛错不堵队列", async () => {
  const limit = createLimiter(1);
  const failing = limit(async () => {
    throw new Error("boom");
  });
  const after = limit(async () => "ok");
  await assert.rejects(failing);
  assert.equal(await after, "ok");
});

test("同键并发只跑一次，结束后可再跑", async () => {
  const dedupe = createDedupe<number>();
  let runs = 0;
  const run = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return runs;
  };
  const [a, b] = await Promise.all([dedupe("k", run), dedupe("k", run)]);
  assert.equal(a, b);
  assert.equal(runs, 1);
  await dedupe("k", run);
  assert.equal(runs, 2);
});
