import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOARD_RESULT_MAX_VH, BoardExpandStore, boardClip, collapseScrollDelta } from "./board-expand.ts";

describe("对话里看板结果的限高与展开", () => {
  it("内容没超过半屏：不裁、不可折叠", () => {
    const clip = boardClip({ contentHeight: 300, windowHeight: 800, expanded: false });
    assert.equal(clip.cap, Math.round(800 * BOARD_RESULT_MAX_VH));
    assert.deepEqual([clip.foldable, clip.clipped, clip.maxHeight], [false, false, null]);
  });
  it("超过半屏且收着：裁到限高，出「展开」", () => {
    const clip = boardClip({ contentHeight: 1100, windowHeight: 800, expanded: false });
    assert.deepEqual([clip.foldable, clip.clipped, clip.maxHeight], [true, true, 400]);
  });
  it("展开后：去掉限高，完整显示，仍可折叠（出「收起」）", () => {
    const clip = boardClip({ contentHeight: 1100, windowHeight: 800, expanded: true });
    assert.deepEqual([clip.foldable, clip.clipped, clip.maxHeight], [true, false, null]);
  });
  it("刚好等于限高不算超出；展开状态在窗口变高到放得下时不再可折叠", () => {
    assert.equal(boardClip({ contentHeight: 400, windowHeight: 800, expanded: false }).foldable, false);
    assert.equal(boardClip({ contentHeight: 1100, windowHeight: 2400, expanded: true }).foldable, false);
  });
});

describe("收起时的滚动位置", () => {
  it("看板顶部在视口上方：上滚到顶部落在容器顶下边距处（返回负的增量）", () => {
    assert.equal(collapseScrollDelta(-600, 100, 12), -712);
  });
  it("看板顶部本来就在视口里（含贴着容器顶）：不动", () => {
    assert.equal(collapseScrollDelta(150, 100, 12), 0);
    assert.equal(collapseScrollDelta(100, 100, 12), 0);
  });
});

describe("展开状态按 toolCallId 记在内存里", () => {
  it("展开 / 收起各自独立，状态变了才通知，重复设置不通知", () => {
    const store = new BoardExpandStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    assert.equal(store.has("a"), false);
    store.set("a", true);
    store.set("a", true);
    assert.equal(store.has("a"), true);
    assert.equal(store.has("b"), false);
    assert.equal(notified, 1);
    store.set("a", false);
    assert.equal(store.has("a"), false);
    assert.equal(notified, 2);
  });
  it("取消订阅后不再通知", () => {
    const store = new BoardExpandStore();
    let notified = 0;
    const off = store.subscribe(() => {
      notified += 1;
    });
    off();
    store.set("a", true);
    assert.equal(notified, 0);
  });
});
