/**
 * 专注计时纯函数的测试（focus-timer.ts）。时间全部注入，不碰真实时钟。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_MINUTES,
  FOCUS_MINUTES_DEFAULT,
  FOCUS_WHEEL_ROW,
  SUMMARY_LEAD_MS,
  extendFocusRun,
  focusProgress,
  formatFocusClock,
  formatStartClock,
  remainMs,
  resolvePickerWorkspace,
  shouldStartSummary,
  startFocusRun,
  summaryWindowOf,
  wheelIndex,
} from "./focus-timer.ts";

test("startFocusRun：endsAt = now + 分钟，总量一致", () => {
  const run = startFocusRun(1_000_000, "ws-1", 25);
  assert.equal(run.workspaceId, "ws-1");
  assert.equal(run.startedAt, 1_000_000);
  assert.equal(run.totalMs, 25 * 60_000);
  assert.equal(run.endsAt, 1_000_000 + 25 * 60_000);
});

test("extendFocusRun：+5 右移结束点、总量同加；原 run 不被改", () => {
  const run = startFocusRun(0, "ws-1", 20);
  const extended = extendFocusRun(run, 5);
  assert.equal(extended.endsAt, run.endsAt + 5 * 60_000);
  assert.equal(extended.totalMs, run.totalMs + 5 * 60_000);
  assert.equal(extended.startedAt, run.startedAt);
  // 不可变：原对象没被原地改
  assert.equal(run.totalMs, 20 * 60_000);
});

test("remainMs：正常递减；到点夹 0，不为负", () => {
  const run = startFocusRun(0, "ws-1", 1);
  assert.equal(remainMs(run, 30_000), 30_000);
  assert.equal(remainMs(run, 60_000), 0);
  assert.equal(remainMs(run, 120_000), 0);
});

test("focusProgress：0 起 1 封顶；延长后进度线回退（总量变大）", () => {
  const run = startFocusRun(0, "ws-1", 10);
  assert.equal(focusProgress(run, 0), 0);
  assert.equal(focusProgress(run, 5 * 60_000), 0.5);
  assert.equal(focusProgress(run, 999 * 60_000), 1);
  const extended = extendFocusRun(run, 10);
  assert.equal(focusProgress(extended, 5 * 60_000), 0.25);
});

test("formatFocusClock：mm:ss、前导零、秒向下取整", () => {
  assert.equal(formatFocusClock(25 * 60_000), "25:00");
  assert.equal(formatFocusClock(24 * 60_000 + 13_000), "24:13");
  assert.equal(formatFocusClock(5_000), "00:05");
  assert.equal(formatFocusClock(1_999), "00:01");
  assert.equal(formatFocusClock(0), "00:00");
  // 120 分钟档：三位数分钟，不换小时制
  assert.equal(formatFocusClock(120 * 60_000), "120:00");
});

test("formatStartClock：本地时区 HH:MM", () => {
  const date = new Date(2026, 9, 19, 14, 5, 0, 0);
  assert.equal(formatStartClock(date.getTime()), "14:05");
  const midnight = new Date(2026, 9, 19, 0, 0, 0, 0);
  assert.equal(formatStartClock(midnight.getTime()), "00:00");
});

test("wheelIndex：按行高取整；负值与超界夹回区间", () => {
  const count = FOCUS_MINUTES.length;
  assert.equal(wheelIndex(0, count), 0);
  assert.equal(wheelIndex(FOCUS_WHEEL_ROW, count), 1);
  assert.equal(wheelIndex(3 * FOCUS_WHEEL_ROW + 5, count), 3);
  // 橡皮筋滚过头：夹回
  assert.equal(wheelIndex(-100, count), 0);
  assert.equal(wheelIndex(999 * FOCUS_WHEEL_ROW, count), count - 1);
  assert.equal(wheelIndex(0, 0), 0);
});

test("档位表：默认 25 在表内，升序、无重复", () => {
  assert.ok(FOCUS_MINUTES.includes(FOCUS_MINUTES_DEFAULT));
  for (let i = 1; i < FOCUS_MINUTES.length; i++) {
    assert.ok(FOCUS_MINUTES[i - 1]! < FOCUS_MINUTES[i]!, "档位必须升序");
  }
  assert.equal(new Set(FOCUS_MINUTES).size, FOCUS_MINUTES.length);
});

test("shouldStartSummary：剩 5 分钟线（到点后仍真；延长把线推后）", () => {
  const run = startFocusRun(0, "ws-1", 25);
  assert.equal(shouldStartSummary(run, 0), false);
  assert.equal(shouldStartSummary(run, 20 * 60_000 - 1), false);
  assert.equal(shouldStartSummary(run, 20 * 60_000), true);
  assert.equal(shouldStartSummary(run, 25 * 60_000), true);
  const extended = extendFocusRun(run, 15);
  assert.equal(shouldStartSummary(extended, 20 * 60_000), false);
  assert.equal(shouldStartSummary(extended, 35 * 60_000), true);
  assert.equal(SUMMARY_LEAD_MS, 5 * 60_000);
});

describe("resolvePickerWorkspace：工作区晚到也要有有效选择", () => {
  const ids = ["ws-a", "ws-b"];
  test("挂载时空表初始化出的 null：列表到了回填（preset > 默认 > 第一个）", () => {
    // 空表阶段：null 进 null 出
    assert.equal(resolvePickerWorkspace(null, null, null, []), null);
    // 列表晚到：无 preset 无默认 → 第一个
    assert.equal(resolvePickerWorkspace(null, null, null, ids), "ws-a");
    // 默认（当前会话所在）在表里 → 它优先于第一个
    assert.equal(resolvePickerWorkspace(null, null, "ws-b", ids), "ws-b");
    // 上次的档位优先于默认
    assert.equal(resolvePickerWorkspace(null, "ws-a", "ws-b", ids), "ws-a");
  });
  test("已选的且还在：不动（用户手选不被覆盖）", () => {
    assert.equal(resolvePickerWorkspace("ws-b", "ws-a", "ws-a", ids), "ws-b");
  });
  test("选中项被移除：落回 preset，再落默认 / 第一个", () => {
    assert.equal(resolvePickerWorkspace("ws-gone", "ws-b", "ws-a", ids), "ws-b");
    assert.equal(resolvePickerWorkspace("ws-gone", "ws-gone", "ws-a", ids), "ws-a");
    assert.equal(resolvePickerWorkspace("ws-gone", "ws-gone", "ws-gone", ids), "ws-a");
    assert.equal(resolvePickerWorkspace("ws-gone", "ws-gone", "ws-gone", []), null);
  });
});

describe("summaryWindowOf：素材窗口在起跑时冻结", () => {
  test("正常路径：窗口 = [专注开始, 起跑那一刻]，带所选工作区", () => {
    const run = startFocusRun(1_000_000, "ws-1", 25);
    assert.deepEqual(summaryWindowOf(run, 20 * 60_000 + 1_000_000), {
      startedAt: 1_000_000,
      until: 20 * 60_000 + 1_000_000,
      workspaceId: "ws-1",
    });
  });

  test("边界：窗口只认起跑那一刻，重试沿用旧值（拿重试时刻重算就会拖长）", () => {
    const run = startFocusRun(0, "ws-1", 25);
    const fired = summaryWindowOf(run, 20 * 60_000);
    assert.equal(fired.until, 20 * 60_000);
    // 错误做法：拿之后某一刻重算，until 跟着变——重试读的就是另一段素材了
    assert.equal(summaryWindowOf(run, 40 * 60_000).until, 40 * 60_000);
  });
});
