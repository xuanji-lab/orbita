import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { POINTER_DRAG_ATTR, startPointerDrag, type PointerDragDelta } from "./pointer-drag.ts";

/**
 * 拖把手的收尾：松手落在 iframe 上时主窗口收不到 pointerup（实测：光标卡在 col-resize、监听不摘），
 * 所以收尾靠把手上的 pointerup / pointercancel / lostpointercapture 与窗口失焦。这里用最小的假 DOM 验证。
 */

class FakeHandle extends EventTarget {
  captured = new Set<number>();
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
  /** 系统收走捕获：先摘捕获再发 lostpointercapture（和浏览器一致） */
  lose(id: number): void {
    this.captured.delete(id);
    this.fire("lostpointercapture", id, 0, 0);
  }
  fire(type: string, pointerId: number, clientX: number, clientY: number): void {
    this.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX, clientY }));
  }
}

const win = new EventTarget();
const attrs = new Set<string>();
const body = { style: { userSelect: "text", cursor: "default" } };

beforeEach(() => {
  attrs.clear();
  body.style.userSelect = "text";
  body.style.cursor = "default";
  Object.assign(globalThis, {
    window: win,
    document: {
      body,
      documentElement: { setAttribute: (name: string) => attrs.add(name), removeAttribute: (name: string) => attrs.delete(name) },
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

function down(handle: FakeHandle, over: Partial<{ button: number; pointerId: number; clientX: number; clientY: number }> = {}): React.PointerEvent<HTMLElement> {
  return { button: 0, pointerId: 7, clientX: 100, clientY: 50, currentTarget: handle, preventDefault: () => undefined, ...over } as unknown as React.PointerEvent<HTMLElement>;
}

function start(handle: FakeHandle) {
  const moves: PointerDragDelta[] = [];
  const ends: PointerDragDelta[] = [];
  const started = startPointerDrag(down(handle), { cursor: "col-resize", onMove: (d) => moves.push(d), onEnd: (d) => ends.push(d) });
  return { started, moves, ends };
}

describe("startPointerDrag", () => {
  test("按下：捕获指针、光标与选择固定成拖拽语义、<html> 挂标记；位移相对按下点", () => {
    const handle = new FakeHandle();
    const { started, moves } = start(handle);
    assert.equal(started, true);
    assert.equal(handle.hasPointerCapture(7), true);
    assert.deepEqual([body.style.cursor, body.style.userSelect, attrs.has(POINTER_DRAG_ATTR)], ["col-resize", "none", true]);
    handle.fire("pointermove", 7, 130, 40);
    assert.deepEqual(moves, [{ x: 30, y: -10 }]);
  });

  test("松手（pointerup 在把手上）：还原光标与选择、摘标记、释放捕获、onEnd 一次，之后的 move 不再响应", () => {
    const handle = new FakeHandle();
    const { moves, ends } = start(handle);
    handle.fire("pointerup", 7, 160, 50);
    assert.deepEqual(ends, [{ x: 60, y: 0 }]);
    assert.deepEqual([body.style.cursor, body.style.userSelect, attrs.has(POINTER_DRAG_ATTR), handle.hasPointerCapture(7)], ["default", "text", false, false]);
    handle.fire("pointermove", 7, 999, 999);
    assert.equal(moves.length, 0);
  });

  test("松手点落在 iframe 上、主窗口没收到 pointerup：捕获被收走（lostpointercapture）也会收尾，按最后位移提交", () => {
    const handle = new FakeHandle();
    const { ends } = start(handle);
    handle.fire("pointermove", 7, 140, 50);
    handle.lose(7);
    assert.deepEqual(ends, [{ x: 40, y: 0 }]);
    assert.deepEqual([body.style.cursor, body.style.userSelect, attrs.has(POINTER_DRAG_ATTR)], ["default", "text", false]);
  });

  test("pointercancel 与窗口失焦同样收尾；收尾只做一次（先 up 后 lostpointercapture 不重复提交）", () => {
    const cancelled = new FakeHandle();
    const first = start(cancelled);
    cancelled.fire("pointermove", 7, 110, 50);
    cancelled.fire("pointercancel", 7, 0, 0);
    assert.deepEqual(first.ends, [{ x: 10, y: 0 }]);

    const blurred = new FakeHandle();
    const second = start(blurred);
    win.dispatchEvent(new Event("blur"));
    assert.equal(second.ends.length, 1);

    const once = new FakeHandle();
    const third = start(once);
    once.fire("pointerup", 7, 120, 50);
    once.lose(7);
    win.dispatchEvent(new Event("blur"));
    assert.equal(third.ends.length, 1);
  });

  test("别的指针的事件不管；非主键不开始拖拽", () => {
    const handle = new FakeHandle();
    const { moves, ends } = start(handle);
    handle.fire("pointermove", 8, 500, 500);
    handle.fire("pointerup", 8, 500, 500);
    assert.deepEqual([moves.length, ends.length], [0, 0]);
    handle.fire("pointerup", 7, 100, 50);
    assert.equal(ends.length, 1);

    const other = new FakeHandle();
    const started = startPointerDrag(down(other, { button: 2 }), { cursor: "col-resize", onMove: () => undefined, onEnd: () => undefined });
    assert.equal(started, false);
    assert.deepEqual([other.hasPointerCapture(7), attrs.has(POINTER_DRAG_ATTR)], [false, false]);
  });
});
