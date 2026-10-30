/**
 * 专注 shell 的纯判定测试（focus-shell.ts）——#267 B1 把 App 里的接线搬走之后，
 * 这些「看哪一屏 / 气泡说什么 / 卡出不出」的判定不再住在 JSX 三元链里，而是这里
 * 的可测函数。用例按搬走前的行为逐条对齐（搬的是接线，不是功能）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { focusBubbleOf, focusCardMinutesOf, focusCardVisibleOf, focusFilesViewOf, focusSuspendActionOf, settledSayTextOf } from "./focus-shell.ts";
import type { FocusStatus, FocusSummary } from "../../shell/focus/use-focus.ts";
import type { FocusRun } from "../../shell/focus/focus-timer.ts";
import { zh } from "../../messages-zh.ts";

const run: FocusRun = { workspaceId: "ws-1", startedAt: 1_000, totalMs: 25 * 60_000, endsAt: 1_000 + 25 * 60_000 };
const status = (kind: FocusStatus["kind"]): FocusStatus => (kind === "off" ? { kind } : { kind, run });
const summary = (state: FocusSummary["state"]): FocusSummary =>
  state === "idle"
    ? { state }
    : state === "running"
      ? { state }
      : state === "ready"
        ? { state, bullets: ["a"], sessionsRead: 1, modelLabel: "p/m" }
        : state === "failed"
          ? { state, message: "boom" }
          : { state, reason: "no-activity" };

describe("focusFilesViewOf", () => {
  test("专注中（run / ending / done）都是所选工作区的文件视图", () => {
    for (const kind of ["run", "ending", "done"] as const) {
      assert.deepEqual(focusFilesViewOf(status(kind), null), { mode: "focus", workspaceId: "ws-1" });
    }
  });
  test("专注中压过浏览态：两个都有时看专注的那个工作区", () => {
    assert.deepEqual(focusFilesViewOf(status("run"), "ws-browse"), { mode: "focus", workspaceId: "ws-1" });
  });
  test("没专注时看浏览态；都没有 = 会话列表（null）", () => {
    assert.deepEqual(focusFilesViewOf(status("off"), "ws-browse"), { mode: "browse", workspaceId: "ws-browse" });
    assert.equal(focusFilesViewOf(status("off"), null), null);
  });
});

describe("focusBubbleOf", () => {
  test("run + running：转圈那句（带呼吸）", () => {
    assert.deepEqual(focusBubbleOf(status("run"), summary("running"), false), { kind: "working", breath: true });
  });
  test("run + 落定：四种退路各一句", () => {
    assert.deepEqual(focusBubbleOf(status("run"), summary("ready"), false), { kind: "settled", line: "ready" });
    assert.deepEqual(focusBubbleOf(status("run"), summary("failed"), false), { kind: "settled", line: "failed" });
    assert.deepEqual(focusBubbleOf(status("run"), { state: "none", reason: "no-model" }, false), {
      kind: "settled",
      line: "no-model",
    });
    assert.deepEqual(focusBubbleOf(status("run"), { state: "none", reason: "no-activity" }, false), {
      kind: "settled",
      line: "no-activity",
    });
  });
  test("run + idle：还没起跑，不说话", () => {
    assert.deepEqual(focusBubbleOf(status("run"), summary("idle"), false), { kind: "hidden" });
  });
  test("点过 x 之后（run 相位）常驻气泡也不出来", () => {
    assert.deepEqual(focusBubbleOf(status("run"), summary("ready"), true), { kind: "hidden" });
  });
  test("ending + idle：问要不要总结", () => {
    assert.deepEqual(focusBubbleOf(status("ending"), summary("idle"), false), { kind: "ask" });
  });
  test("ending + running：转圈，但没有呼吸那一下（两个相位 DOM 不同）", () => {
    assert.deepEqual(focusBubbleOf(status("ending"), summary("running"), false), { kind: "working", breath: false });
  });
  test("ending + 落定 / done / off：不出气泡（结束的落定交给卡）", () => {
    assert.deepEqual(focusBubbleOf(status("ending"), summary("ready"), false), { kind: "hidden" });
    assert.deepEqual(focusBubbleOf(status("done"), summary("ready"), false), { kind: "hidden" });
    assert.deepEqual(focusBubbleOf(status("off"), summary("ready"), false), { kind: "hidden" });
  });
});

describe("focusCardVisibleOf", () => {
  test("到点就出卡，总结还在跑也先出（卡里转圈）", () => {
    assert.equal(focusCardVisibleOf(status("done"), summary("idle"), false), true);
    assert.equal(focusCardVisibleOf(status("done"), summary("running"), false), true);
    assert.equal(focusCardVisibleOf(status("done"), summary("ready"), false), true);
  });
  test("提前结束：点了「要」并落定才出卡；还在问 / 还在跑都不出", () => {
    for (const state of ["ready", "failed", "none"] as const) {
      assert.equal(focusCardVisibleOf(status("ending"), summary(state), false), true);
    }
    assert.equal(focusCardVisibleOf(status("ending"), summary("idle"), false), false);
    assert.equal(focusCardVisibleOf(status("ending"), summary("running"), false), false);
  });
  test("计时的 run / 已复位 off 都不出卡", () => {
    assert.equal(focusCardVisibleOf(status("run"), summary("ready"), false), false);
    assert.equal(focusCardVisibleOf(status("off"), summary("ready"), false), false);
  });
  test("卡自己的关闭键压住一切（只藏卡，不结束专注）", () => {
    assert.equal(focusCardVisibleOf(status("done"), summary("ready"), true), false);
    assert.equal(focusCardVisibleOf(status("ending"), summary("ready"), true), false);
  });
});

describe("focusCardMinutesOf", () => {
  test("到点：这一轮的总时长（含延长），与墙钟无关", () => {
    assert.equal(focusCardMinutesOf(status("done"), run, run.startedAt + 99 * 60_000), 25);
  });
  test("提前结束：已经跑过的分钟数，至少 1 分钟", () => {
    assert.equal(focusCardMinutesOf(status("ending"), run, run.startedAt + 12 * 60_000), 12);
    assert.equal(focusCardMinutesOf(status("ending"), run, run.startedAt + 5_000), 1);
  });
});

describe("settledSayTextOf", () => {
  test("四句话取自文案表的 focus 段", () => {
    assert.equal(settledSayTextOf("ready", zh.focus), zh.focus.sayReady);
    assert.equal(settledSayTextOf("failed", zh.focus), zh.focus.summaryFailed);
    assert.equal(settledSayTextOf("no-model", zh.focus), zh.focus.summaryNoModel);
    assert.equal(settledSayTextOf("no-activity", zh.focus), zh.focus.summaryNoActivity);
  });
});

describe("focusSuspendActionOf（睡眠即结束专注）", () => {
  test("run 相位：直接收掉，落到同一工作区的浏览态", () => {
    assert.deepEqual(focusSuspendActionOf(status("run")), {
      kind: "end-to-browse",
      workspaceId: run.workspaceId,
    });
  });
  test("不在跑就什么都不做：ending 的问句、done 的卡是醒着时留下的界面，睡眠不清理", () => {
    assert.equal(focusSuspendActionOf(status("off")), null);
    assert.equal(focusSuspendActionOf(status("ending")), null);
    assert.equal(focusSuspendActionOf(status("done")), null);
  });
});
