import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOC_META_REFRESH_DEBOUNCE_MS, watchDocMeta, type MetaTimers } from "./doc-meta-refresh.ts";

/** 手动拨的假时钟：只记「到点要跑什么」 */
function fakeTimers(): { timers: MetaTimers; advance(ms: number): void } {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      set: (callback, ms) => {
        const id = nextId++;
        queue.set(id, { at: now + ms, callback });
        return id;
      },
      clear: (handle) => void queue.delete(handle as number),
    },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...queue]) {
        if (task.at <= now) {
          queue.delete(id);
          task.callback();
        }
      }
    },
  };
}

function setup() {
  const clock = fakeTimers();
  const listeners = new Set<(event: { path: string }) => void>();
  let refreshed = 0;
  const off = watchDocMeta(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    "/w/a.md",
    () => {
      refreshed += 1;
    },
    clock.timers,
  );
  const emit = (path: string): void => listeners.forEach((listener) => listener({ path }));
  return { clock, emit, off, listeners, count: () => refreshed };
}

describe("文档头部大小 / 修改时间的刷新", () => {
  it("盘上变了：去抖之后重读一次；别的文档的变化不理", () => {
    const { clock, emit, count } = setup();
    emit("/w/other.md");
    clock.advance(1000);
    assert.equal(count(), 0);
    emit("/w/a.md");
    clock.advance(DOC_META_REFRESH_DEBOUNCE_MS - 1);
    assert.equal(count(), 0);
    clock.advance(1);
    assert.equal(count(), 1);
  });

  it("连续的变化（打字自动保存）合并成一次", () => {
    const { clock, emit, count } = setup();
    for (let i = 0; i < 5; i += 1) {
      emit("/w/a.md");
      clock.advance(100);
    }
    clock.advance(DOC_META_REFRESH_DEBOUNCE_MS);
    assert.equal(count(), 1);
  });

  it("退订后不再重读，在途的也取消", () => {
    const { clock, emit, off, listeners, count } = setup();
    emit("/w/a.md");
    off();
    clock.advance(5000);
    assert.equal(count(), 0);
    assert.equal(listeners.size, 0);
  });
});
