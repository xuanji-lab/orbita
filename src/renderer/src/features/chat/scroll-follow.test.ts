import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOW_INTENT_TTL_MS,
  JUMP_WINDOW_MS,
  PROGRAMMATIC_GRACE_MS,
  createFollowTracker,
  forceFollowLatest,
  isFollowing,
  isScrollbarPointer,
  scrollIntentDirection,
  mayPinToBottom,
  noteFollowIntent,
  noteFollowJump,
  noteFollowScroll,
  notePinnedScroll,
  type ScrollSnapshot,
} from "./scroll-follow.ts";

/** 视口 600、内容 2000 的一屏：贴底 scrollTop = 1400 */
function snap(scrollTop: number): ScrollSnapshot {
  return { scrollTop, viewportHeight: 600, scrollHeight: 2000 };
}

const AT_BOTTOM = 1400;
/** 离底 400px（远超 40px 容差） */
const READING_POS = 1000;
/** 距底 20px（在 40px 容差内，仍算贴底） */
const NEAR_BOTTOM = 1380;

describe("显式跟随态的默认值与钉底", () => {
  test("新建即 Latest，可以钉底", () => {
    const tracker = createFollowTracker();
    assert.equal(tracker.state, "latest");
    assert.equal(isFollowing(tracker), true);
    assert.equal(mayPinToBottom(tracker, 0), true);
  });

  test("内容不足一屏（无处可滚）也算贴底", () => {
    const tracker = createFollowTracker();
    const state = noteFollowScroll(
      tracker,
      { scrollTop: 0, viewportHeight: 600, scrollHeight: 300 },
      0,
    );
    assert.equal(state, "latest");
  });
});

describe("用户意图 → 上滚离底 → Reading", () => {
  test("上滚意图先暂停钉底，滚动事件把状态改为 Reading", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 1000, "up");
    // 意图已到、滚动还没来：这一帧不能钉（否则用户的上滚被吃掉）
    assert.equal(mayPinToBottom(tracker, 1010), false);
    assert.equal(noteFollowScroll(tracker, snap(READING_POS), 1020), "reading");
    assert.equal(isFollowing(tracker), false);
  });

  test("Reading 期间程序化贴底 / 内容长高都不拉回", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowScroll(tracker, snap(READING_POS), 10);
    // 之后的 commit：钉底一律不许
    assert.equal(mayPinToBottom(tracker, 500), false);
    notePinnedScroll(tracker, 500);
    // 意图窗口过去之后，程序化滚动即使到了底部也不改态（Reading 必须由新的用户意图恢复）
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), 2000), "reading");
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), 10_000), "reading");
    assert.equal(mayPinToBottom(tracker, 10_000), false);
  });

  test("滚回底部（意图窗口内）恢复 Latest 与钉底", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowScroll(tracker, snap(READING_POS), 10);
    noteFollowIntent(tracker, 2000, "down");
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), 2040), "latest");
    assert.equal(isFollowing(tracker), true);
    assert.equal(mayPinToBottom(tracker, 2500), true);
  });

  test("容差内（距底 20px）仍算回到低部", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowScroll(tracker, snap(READING_POS), 10);
    noteFollowIntent(tracker, 100, "down");
    assert.equal(noteFollowScroll(tracker, snap(NEAR_BOTTOM), 120), "latest");
  });

  test("意图之后先到的滚动事件仍离底：不钉底", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "unknown");
    assert.equal(mayPinToBottom(tracker, 5), false);
    noteFollowScroll(tracker, snap(READING_POS), 15);
    assert.equal(mayPinToBottom(tracker, 20), false);
  });
});

describe("程序化滚动与用户滚动的区分", () => {
  test("向下意图不暂停钉底（在底部轻滚一下不该漏 1.2s）", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "down");
    assert.equal(mayPinToBottom(tracker, 10), true);
  });

  test("意图窗口内收到滚动事件并确认贴底后，钉底立即恢复", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowScroll(tracker, snap(NEAR_BOTTOM), 20);
    assert.equal(mayPinToBottom(tracker, 30), true);
  });

  test("程序化静默期内的「离底」不当作 Reading（测高 / 分页锚定的余波）", () => {
    const tracker = createFollowTracker();
    notePinnedScroll(tracker, 1000);
    assert.equal(
      noteFollowScroll(tracker, snap(READING_POS), 1000 + PROGRAMMATIC_GRACE_MS - 1),
      "latest",
    );
  });

  test("静默期过后的离底（没捕获到意图的滚动条拖动）兜底进 Reading", () => {
    const tracker = createFollowTracker();
    notePinnedScroll(tracker, 1000);
    assert.equal(
      noteFollowScroll(tracker, snap(READING_POS), 1000 + PROGRAMMATIC_GRACE_MS + 1),
      "reading",
    );
  });

  test("意图 TTL 边界：恰好到点即不再按意图处理", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    // 到点前 1ms：意图仍有效，贴底 → Latest
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), FOLLOW_INTENT_TTL_MS - 1), "latest");
    const next = createFollowTracker();
    noteFollowIntent(next, 0, "up");
    noteFollowScroll(next, snap(READING_POS), 10);
    // 到点：意图失效，贴底也不改态（Reading 只能由新的用户意图恢复）
    assert.equal(noteFollowScroll(next, snap(AT_BOTTOM), FOLLOW_INTENT_TTL_MS), "reading");
  });
});

describe("程序化回底（回底按钮 / 切会话）", () => {
  test("跳底窗口内锁住 Latest：动画途中的离底滚动不改态", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowScroll(tracker, snap(READING_POS), 10);
    assert.equal(tracker.state, "reading");

    noteFollowJump(tracker, 1000);
    assert.equal(tracker.state, "latest");
    // smooth 动画还在半路：离底不改态（否则到不了底就丢跟随）
    assert.equal(noteFollowScroll(tracker, snap(1200), 1200), "latest");
    assert.equal(mayPinToBottom(tracker, 1200), true);
    // 窗口结束且已在底部：正常
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), 1000 + JUMP_WINDOW_MS + 1), "latest");
    assert.equal(mayPinToBottom(tracker, 1000 + JUMP_WINDOW_MS + 1), true);
  });

  test("forceFollowLatest：切会话 / 发送即时恢复，不设窗口", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowScroll(tracker, snap(READING_POS), 10);
    forceFollowLatest(tracker);
    assert.equal(tracker.state, "latest");
    assert.equal(mayPinToBottom(tracker, 20), true);
  });
});

describe("键盘意图与滚动条判定", () => {
  const plain = { ctrl: false, meta: false, alt: false, shift: false };
  const text = { tagName: "DIV", isContentEditable: false };

  test("翻页 / Home / End / 方向键 / 空格给出方向", () => {
    assert.equal(scrollIntentDirection("PageUp", text, plain), "up");
    assert.equal(scrollIntentDirection("ArrowUp", text, plain), "up");
    assert.equal(scrollIntentDirection("Home", text, plain), "up");
    assert.equal(scrollIntentDirection("PageDown", text, plain), "down");
    assert.equal(scrollIntentDirection("ArrowDown", text, plain), "down");
    assert.equal(scrollIntentDirection("End", text, plain), "down");
    assert.equal(scrollIntentDirection(" ", text, plain), "down");
    assert.equal(scrollIntentDirection(" ", text, { ...plain, shift: true }), "up");
  });

  test("普通键 / 组合键 / 输入框里不接管", () => {
    assert.equal(scrollIntentDirection("a", text, plain), null);
    assert.equal(scrollIntentDirection("PageDown", text, { ...plain, ctrl: true }), null);
    assert.equal(scrollIntentDirection("PageDown", text, { ...plain, meta: true }), null);
    assert.equal(scrollIntentDirection("PageDown", text, { ...plain, alt: true }), null);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      assert.equal(scrollIntentDirection("PageDown", { tagName, isContentEditable: false }, plain), null);
    }
    assert.equal(scrollIntentDirection("PageDown", { tagName: "DIV", isContentEditable: true }, plain), null);
  });

  test("滚动条 pointerdown 判定：落在容器且偏移超出 client 区域", () => {
    assert.equal(isScrollbarPointer(true, 800, 100, 780, 600), true);
    assert.equal(isScrollbarPointer(true, 100, 700, 780, 600), true);
    assert.equal(isScrollbarPointer(true, 100, 100, 780, 600), false);
    // 点在内容里的子元素上：target 不是滚动容器，不算
    assert.equal(isScrollbarPointer(false, 900, 100, 780, 600), false);
  });

  test("窗口内到达底部即稳定 Latest", () => {
    const tracker = createFollowTracker();
    noteFollowJump(tracker, 0, 600);
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), 300), "latest");
    assert.equal(noteFollowScroll(tracker, snap(AT_BOTTOM), 900), "latest");
  });

  test("跳底的意图窗口被清掉：不会残留「暂停钉底」", () => {
    const tracker = createFollowTracker();
    noteFollowIntent(tracker, 0, "up");
    noteFollowJump(tracker, 100);
    assert.equal(mayPinToBottom(tracker, 100 + JUMP_WINDOW_MS + 1), true);
  });
});
