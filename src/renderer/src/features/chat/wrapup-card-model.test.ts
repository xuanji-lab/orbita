import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { WrapupDraft } from "../../../../shared/wrapup.ts";
import { addEntry, confirmCounts, editTitle, entryTotals, moveEntry, removeEntry } from "./wrapup-card-model.ts";

const draft: WrapupDraft = {
  done: [
    { title: "找代码", detail: "", turns: [1, 2], change: "merged" },
    { title: "核对口径", detail: "", turns: [3, 3] },
  ],
  left: [{ title: "查分数", detail: "没查", turns: null }],
};

describe("收尾卡的本地编辑", () => {
  test("改标题：空串与原样不改", () => {
    assert.equal(editTitle(draft, "done", 1, " 核对两条线 ").done[1]?.title, "核对两条线");
    assert.equal(editTitle(draft, "done", 1, "  "), draft);
    assert.equal(editTitle(draft, "done", 1, "核对口径"), draft);
  });

  test("删、加：加的没有轮次", () => {
    assert.deepEqual(removeEntry(draft, "done", 0).done.map((e) => e.title), ["核对口径"]);
    assert.deepEqual(addEntry(draft, "left", " 写文档 ").left.at(-1), { title: "写文档", detail: "", turns: null });
    assert.equal(addEntry(draft, "left", " "), draft);
  });

  test("挪到另一组末尾：轮次跟着走，反馈标签去掉；再挪回来轮次还在", () => {
    const moved = moveEntry(draft, "done", 0);
    assert.deepEqual(moved.done.map((e) => e.title), ["核对口径"]);
    assert.deepEqual(moved.left.at(-1), { title: "找代码", detail: "", turns: [1, 2] });
    assert.deepEqual(moveEntry(moved, "left", 1).done.at(-1)?.turns, [1, 2]);
  });

  test("确认键上的数", () => {
    assert.deepEqual(confirmCounts(draft), { done: 2, left: 1 });
  });

  test("显示的账：没有轮次或那几轮没用量就不显示", () => {
    const turns = [
      {
        n: 1,
        userId: "u1",
        preview: "",
        usage: [
          {
            providerId: "p",
            modelId: "opus",
            level: "high" as const,
            tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
            recordedCost: 0.1,
            unpricedTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            officialCost: 0.1,
          },
        ],
      },
    ];
    assert.equal(entryTotals(turns, { title: "x", detail: "", turns: [1, 1] })?.modelId, "opus");
    assert.equal(entryTotals(turns, { title: "x", detail: "", turns: null }), null);
    assert.equal(entryTotals(turns, { title: "x", detail: "", turns: [2, 2] }), null);
  });
});
