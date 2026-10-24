import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clickToPdfPoint,
  fitScale,
  locateCitation,
  mergeLineRects,
  PDF_PAGE_GAP,
  syncRectStyle,
} from "./pdf-view.ts";
import { findQuote, indexPageText } from "../../../../shared/pdf-quote.ts";

describe("fitScale", () => {
  it("页宽撑满可用宽度（两侧各留间隙），并钳在上下限内", () => {
    assert.equal(fitScale(612 + PDF_PAGE_GAP * 2, 612), 1);
    assert.equal(fitScale(10, 612), 0.25);
    assert.equal(fitScale(100000, 612), 4);
    assert.equal(fitScale(0, 612), 1);
  });
});

describe("locateCitation", () => {
  const items = ["The renderer uses double buf-", "", "fering to avoid tearing."];
  const index = indexPageText(items.map((str) => ({ str })));
  const hit = findQuote([index], "double buffering to avoid tearing");
  if (hit.kind !== "exact") throw new Error("夹具应精确命中");
  const citation = { id: "c4k2", path: "/a.pdf", page: 1, start: hit.start, end: hit.end, text: "double buf-fering to avoid tearing" };

  it("偏移对得上：直接用记录里的区间（跨条目、跳过空条目）", () => {
    assert.deepEqual(locateCitation(items, citation), { startRun: 0, startOffset: 18, endRun: 2, endOffset: 23 });
  });

  it("偏移对不上（文件改过）：在本页按原文重搜", () => {
    const shifted = ["Preface added.", ...items];
    assert.deepEqual(locateCitation(shifted, citation), { startRun: 1, startOffset: 18, endRun: 3, endOffset: 23 });
  });

  it("本页没有这段：null", () => {
    assert.equal(locateCitation(["something else entirely"], citation), null);
  });
});

describe("mergeLineRects", () => {
  it("同一行相接的段合并，换行与远处的另一栏不合并", () => {
    const merged = mergeLineRects([
      { left: 10, top: 100, width: 50, height: 12 },
      { left: 60, top: 101, width: 40, height: 11 },
      { left: 10, top: 116, width: 80, height: 12 },
      { left: 400, top: 100, width: 50, height: 12 },
      { left: 0, top: 0, width: 0, height: 12 },
    ]);
    assert.deepEqual(merged, [
      { left: 10, top: 100, width: 90, height: 12 },
      { left: 400, top: 100, width: 50, height: 12 },
      { left: 10, top: 116, width: 80, height: 12 },
    ]);
  });
});

describe("syncRectStyle", () => {
  it("PDF 点 × 渲染缩放 = 覆盖层 CSS px（scale 1 时数值不变）", () => {
    const rect = { left: 100, top: 200, width: 300, height: 9 };
    assert.deepEqual(syncRectStyle(rect, 1), rect);
    assert.deepEqual(syncRectStyle(rect, 1.5), { left: 150, top: 300, width: 450, height: 13.5 });
  });
});

describe("clickToPdfPoint", () => {
  const page = { left: 40, top: 12, width: 595.28, height: 841.89 };

  it("页内点击：换回 PDF 点（左上原点）", () => {
    assert.deepEqual(clickToPdfPoint(page, 1, 40 + 100, 12 + 200), { x: 100, y: 200 });
  });

  it("缩放为 0.5 时尺寸也要放大回去", () => {
    // 渲染后页是 297.64×420.945，点在 (40+50, 12+100)
    const small = { left: 40, top: 12, width: 297.64, height: 420.945 };
    const point = clickToPdfPoint(small, 0.5, 90, 112);
    assert.deepEqual(point, { x: 100, y: 200 });
  });

  it("页外 / 缩放为 0：null（不拿最近的记录编一个答案）", () => {
    assert.equal(clickToPdfPoint(page, 1, 10, 20), null);
    assert.equal(clickToPdfPoint(page, 0, 40, 12), null);
  });
});
