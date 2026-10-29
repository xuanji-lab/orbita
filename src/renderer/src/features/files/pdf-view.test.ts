import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampPercent,
  currentPageOf,
  DEFAULT_PDF_PREFS,
  fitPageScale,
  fitScale,
  locateCitation,
  locateMatch,
  matchCounts,
  mergeLineRects,
  PDF_PAGE_GAP,
  PDF_ZOOM_UNIT,
  parsePdfPrefs,
  percentOfScale,
  scaleOfPercent,
  scrollTopForPage,
  searchPageItems,
  serializePdfPrefs,
  stepMatch,
  stepPercent,
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

describe("缩放：百分比与适页", () => {
  it("100% = 96dpi（scale 4/3），百分比与比例互相换算", () => {
    assert.equal(scaleOfPercent(100), PDF_ZOOM_UNIT);
    assert.equal(percentOfScale(PDF_ZOOM_UNIT), 100);
    assert.equal(percentOfScale(scaleOfPercent(175)), 175);
  });

  it("百分比夹在 50–400，步进到头就停（不回绕）", () => {
    assert.equal(clampPercent(10), 50);
    assert.equal(clampPercent(900), 400);
    assert.equal(clampPercent(Number.NaN), 100);
    assert.equal(stepPercent(100, 1), 110);
    assert.equal(stepPercent(100, -1), 90);
    assert.equal(stepPercent(395, 1), 400);
    assert.equal(stepPercent(55, -1), 50);
  });

  it("适页按最大页把宽高都塞进可用区域（留两侧间隙），并钳在 0.25–4", () => {
    // 可用 800×1000，页 612×792：宽 (800-24)/612≈1.27，高 (1000-24)/792≈1.23 → 取小
    assert.ok(Math.abs(fitPageScale(800, 1000, 612, 792) - 976 / 792) < 1e-9);
    assert.equal(fitPageScale(0, 0, 612, 792), 1, "没有尺寸时不动缩放");
    assert.equal(fitPageScale(100, 100, 612, 792), 0.25);
  });
});

describe("页几何：当前页 / 跳页（输入是 DOM 实测的页位置）", () => {
  // 第一页顶端为 0；页高 792、间隙 12 → 与 PDF 预览实际排版同构
  const boxes = [
    { top: 0, height: 792 },
    { top: 804, height: 792 },
    { top: 1608, height: 400 },
  ];

  it("当前页取「顶边已越过视口上沿」的那一页", () => {
    assert.equal(currentPageOf(boxes, 0), 1);
    assert.equal(currentPageOf(boxes, 100), 1);
    assert.equal(currentPageOf(boxes, 802), 1, "还差 2px 到第二页");
    assert.equal(currentPageOf(boxes, 804), 2);
    assert.equal(currentPageOf(boxes, 1000), 2);
    assert.equal(currentPageOf(boxes, 99999), 3);
  });

  it("1 像素容差吃掉亚像素滚动位置（触控板 / 高 DPI）", () => {
    assert.equal(currentPageOf(boxes, 803.2), 2);
    assert.equal(currentPageOf([], 10), 1, "没有页时不是 0 页");
  });

  it("参考线（视口 1/4）让「目标页顶端刚进视口一点」也算它当前", () => {
    // 滚到第 2 页页首上方 100px（命中在页首时的高亮滚动就是这样）：
    // 按视口上沿判是第 1 页，按视线落点判是第 2 页
    assert.equal(currentPageOf(boxes, 704), 1);
    assert.equal(currentPageOf(boxes, 704, 114), 2);
  });

  it("跳页 = 目标页顶端（可留 offset），越界夹到首尾", () => {
    assert.equal(scrollTopForPage(boxes, 1), 0);
    assert.equal(scrollTopForPage(boxes, 2), 804);
    assert.equal(scrollTopForPage(boxes, 2, 12), 792);
    assert.equal(scrollTopForPage(boxes, 99), 1608);
    assert.equal(scrollTopForPage(boxes, 0), 0);
  });
});

describe("页内搜索", () => {
  const items = ["The renderer uses double buf-", "", "fering to avoid tearing. DOUBLE buffering!"];

  it("大小写不敏感，跨条目（换行断词）也能命中", () => {
    const hits = searchPageItems(items, "double buffering");
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.end > hit.start));
  });

  it("空白与标点不敏感（归一化后按字母数字比）", () => {
    assert.deepEqual(searchPageItems(items, "  double-buffering ").length, 2);
    assert.deepEqual(searchPageItems(["图 1 结果"], "图1"), [{ start: 0, end: 2 }]);
  });

  it("归一化后为空的查询不匹配一切；没命中就是空数组", () => {
    assert.deepEqual(searchPageItems(items, "  ,.;; "), []);
    assert.deepEqual(searchPageItems(items, "zzz"), []);
  });

  it("命中数按页汇总，全局序号能还原成「第几页第几处」", () => {
    const counts = matchCounts([searchPageItems(items, "double buffering"), searchPageItems(["nothing"], "x")]);
    assert.deepEqual(counts, [2, 0]);
    assert.deepEqual(locateMatch(counts, 0), { page: 1, ordinal: 0 });
    assert.deepEqual(locateMatch(counts, 1), { page: 1, ordinal: 1 });
    assert.equal(locateMatch(counts, 2), null, "越界不猜一页");
  });

  it("n/m 导航：到头折回，未选中时向下取第一处、向上取最后一处", () => {
    assert.equal(stepMatch(-1, 3, 1), 0);
    assert.equal(stepMatch(-1, 3, -1), 2);
    assert.equal(stepMatch(2, 3, 1), 0);
    assert.equal(stepMatch(0, 3, -1), 2);
    assert.equal(stepMatch(0, 0, 1), -1);
  });
});

describe("预览偏好：缩放档与缩略图状态", () => {
  it("往返序列化保持三项", () => {
    const prefs = { zoom: "custom" as const, percent: 175, thumbnails: true };
    assert.deepEqual(parsePdfPrefs(serializePdfPrefs(prefs)), prefs);
  });

  it("缺省、坏 JSON、坏字段逐项退回默认（一个坏值不该让预览打不开）", () => {
    assert.deepEqual(parsePdfPrefs(null), DEFAULT_PDF_PREFS);
    assert.deepEqual(parsePdfPrefs("{not json"), DEFAULT_PDF_PREFS);
    assert.deepEqual(parsePdfPrefs(JSON.stringify({ zoom: "huge", percent: "x", thumbnails: 1 })), DEFAULT_PDF_PREFS);
    assert.deepEqual(parsePdfPrefs(JSON.stringify({ percent: 9999 })), {
      ...DEFAULT_PDF_PREFS,
      percent: 400,
    });
  });
});
