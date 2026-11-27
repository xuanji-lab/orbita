import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOARD_RESULT_MAX_VH, BOARD_ROW_EXTRA, BoardExpandStore, boardClip, boardRowEstimate, collapseScrollDelta } from "./board-expand.ts";

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

describe("没挂载过的看板结果行的高度估值", () => {
  const card = (size: "1x1" | "2x1" | "1x2" | "2x2") => ({ size });
  it("与实测对上：宽 734、窗口高 800 时，2x2 收起 = 400 + 36 = 436，2x1 = 326.7 + 36 = 362.7（实例里量到的行高）", () => {
    assert.equal(boardRowEstimate({ cards: [card("2x2")] }, { columnWidth: 734, windowHeight: 800, expanded: false }), 400 + BOARD_ROW_EXTRA);
    const two = boardRowEstimate({ cards: [card("2x1")] }, { columnWidth: 734, windowHeight: 800, expanded: false });
    assert.ok(Math.abs(two - 362.695) < 0.01, String(two));
  });
  it("多张卡：2x2 + 2x1 排成三行，收起时同样裁到限高", () => {
    assert.equal(boardRowEstimate({ cards: [card("2x2"), card("2x1")] }, { columnWidth: 734, windowHeight: 800, expanded: false }), 436);
  });
  it("展开后不裁：高度 = 整块网格 + 额外", () => {
    const expanded = boardRowEstimate({ cards: [card("2x2")] }, { columnWidth: 734, windowHeight: 800, expanded: true });
    // 2x2 = 2 行格高 + 1 个间距：格宽 (734-8)/2 = 363，格高 326.7
    assert.ok(Math.abs(expanded - (2 * 326.7 + 8 + BOARD_ROW_EXTRA)) < 0.1, String(expanded));
  });
  it("没有卡（全被跳过）只剩额外；比旧估值 230（toolCall 的先验）更接近实测的是新估值", () => {
    assert.equal(boardRowEstimate({ cards: [] }, { columnWidth: 734, windowHeight: 800, expanded: false }), BOARD_ROW_EXTRA);
    const measured = 436;
    const next = boardRowEstimate({ cards: [card("2x2")] }, { columnWidth: 734, windowHeight: 800, expanded: false });
    assert.ok(Math.abs(next - measured) < Math.abs(230 - measured));
  });
  it("容器宽还没量到（0）不抛、不出 NaN（ChatView 另外在宽度为 0 时不用它）", () => {
    const value = boardRowEstimate({ cards: [card("2x2")] }, { columnWidth: 0, windowHeight: 800, expanded: false });
    assert.ok(Number.isFinite(value) && value >= BOARD_ROW_EXTRA);
  });
});
