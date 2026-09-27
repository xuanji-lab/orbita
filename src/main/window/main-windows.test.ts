import { test } from "node:test";
import assert from "node:assert/strict";
import { MainWindows, type TrackableWindow } from "./main-windows.ts";

class FakeWindow implements TrackableWindow {
  destroyed = false;
  private closed: (() => void) | null = null;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  once(_event: "closed", listener: () => void): void {
    this.closed = listener;
  }
  close(): void {
    this.destroyed = true;
    this.closed?.();
  }
}

test("只列被 track 过的窗口：沙盒窗口不在其中", () => {
  const windows = new MainWindows<FakeWindow>();
  const main = new FakeWindow();
  windows.track(main);
  assert.deepEqual(windows.list(), [main]);
});

test("最后一个主窗口关闭才触发 onLastClosed，且只触发一次", () => {
  let fired = 0;
  const windows = new MainWindows<FakeWindow>();
  windows.onLastClosed(() => (fired += 1));
  const a = new FakeWindow();
  const b = new FakeWindow();
  windows.track(a);
  windows.track(b);
  a.close();
  assert.equal(fired, 0);
  assert.deepEqual(windows.list(), [b]);
  b.close();
  assert.equal(fired, 1);
  assert.deepEqual(windows.list(), []);
});

test("已销毁但 closed 还没到的窗口不列出（广播不会发给死窗口）", () => {
  const windows = new MainWindows<FakeWindow>();
  const main = new FakeWindow();
  windows.track(main);
  main.destroyed = true;
  assert.deepEqual(windows.list(), []);
});
