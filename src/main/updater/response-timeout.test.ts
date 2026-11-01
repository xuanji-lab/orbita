import { test } from "node:test";
import assert from "node:assert/strict";
import { armTimeout, type TimeoutScheduler } from "./response-timeout.ts";

class FakeScheduler implements TimeoutScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  set(callback: () => void, _delayMs: number): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    assert.equal(typeof handle, "number");
    this.callbacks.delete(handle as number);
  }

  fireAll(): void {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) callback();
  }

  get size(): number {
    return this.callbacks.size;
  }
}

test("armTimeout：清除后不触发；超时只触发一次", () => {
  const scheduler = new FakeScheduler();
  let calls = 0;
  const cancel = armTimeout(scheduler, 30_000, () => {
    calls += 1;
  });

  assert.equal(scheduler.size, 1);
  cancel();
  scheduler.fireAll();
  assert.equal(calls, 0);
  assert.equal(scheduler.size, 0);

  const secondCancel = armTimeout(scheduler, 30_000, () => {
    calls += 1;
  });
  scheduler.fireAll();
  scheduler.fireAll();
  assert.equal(calls, 1);
  secondCancel();
});
