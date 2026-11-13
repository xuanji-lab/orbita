import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardCardSnapshot } from "../../../../shared/plugin-board.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { skippedText } from "./board-text.ts";
import { canRefreshFrame, FRAME_REFRESH_MAX, snapshotCardView } from "./snapshot-card.ts";

const HASH = "b".repeat(64);
function card(over: Partial<BoardCardSnapshot> = {}): BoardCardSnapshot {
  return { id: "today", title: "今日一篇", size: "2x1", index: 0, template: HASH, data: { n: 1 }, state: "ready", usingSample: false, updatedAt: 500, ...over };
}

describe("snapshotCardView：快照卡 → BoardGrid 的卡视图", () => {
  it("拿到地址：frameUrl / frameKey 带上；数据是快照里的那一份，时间用数据文件的 mtime", () => {
    const view = snapshotCardView("k", card(), { kind: "ready", frameUrl: "orbita-panel://doc/t1", frameKey: 3 }, 9_000);
    strictEqual(view.frameUrl, "orbita-panel://doc/t1");
    strictEqual(view.frameKey, 3);
    strictEqual(view.brokenProblems, null);
    deepStrictEqual(view.shown, { kind: "ready", value: { n: 1 }, updatedAt: 500 });
    strictEqual(view.size, "2x1");
    strictEqual(view.usingSample, false);
  });
  it("样例卡没有文件时间：用快照时刻兜底，并带「样例」标", () => {
    const view = snapshotCardView("k", card({ usingSample: true, updatedAt: null }), { kind: "pending" }, 9_000);
    deepStrictEqual(view.shown, { kind: "ready", value: { n: 1 }, updatedAt: 9_000 });
    strictEqual(view.usingSample, true);
  });
  it("还在等地址：frameUrl 为 null（BoardGrid 画「载入中」），不算坏", () => {
    const view = snapshotCardView("k", card(), { kind: "pending" }, 0);
    strictEqual(view.frameUrl, null);
    strictEqual(view.brokenProblems, null);
  });
  it("仓库里没有这份模板：画成「这张卡画不出来」，原因带哈希前缀", () => {
    const view = snapshotCardView("k", card(), { kind: "missing" }, 0);
    strictEqual(view.frameUrl, null);
    deepStrictEqual(view.brokenProblems, [{ kind: "template-missing", detail: "bbbbbbbbbbbb" }]);
  });
  it("空态卡：发给模板的是 empty", () => {
    const view = snapshotCardView("k", card({ state: "empty", data: null, updatedAt: null }), { kind: "pending" }, 0);
    deepStrictEqual(view.shown, { kind: "empty" });
  });
});

describe("skippedText：被跳过的卡在卡下面一行灰字", () => {
  it("没有被跳过的：null", () => {
    strictEqual(skippedText(zh.board, []), null);
  });
  it("每张卡一句原因，中英文都有", () => {
    const skipped = [
      { id: "today", reason: "too-large" as const, detail: "300000" },
      { id: "items", reason: "template" as const, detail: "x" },
    ];
    strictEqual(skippedText(zh.board, skipped), "没有显示：today: 数据太大; items: 模板读不出来");
    strictEqual(skippedText(en.board, skipped), "Not shown: today: data too large; items: template unreadable");
  });
});

it("卡片地址作废后最多重换 FRAME_REFRESH_MAX 次（被搬动一次只用一次；防模板反复自跳转无限换）", () => {
  strictEqual(FRAME_REFRESH_MAX, 3);
  strictEqual(canRefreshFrame(0), true);
  strictEqual(canRefreshFrame(FRAME_REFRESH_MAX - 1), true);
  strictEqual(canRefreshFrame(FRAME_REFRESH_MAX), false);
});
