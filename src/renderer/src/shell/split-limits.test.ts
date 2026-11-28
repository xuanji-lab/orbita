import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampPaperChatWidth,
  clampPaperPdfRatio,
  clampProblemsHeight,
  clampPptxPagesWidth,
  paperPdfRatioFromLeftWidth,
  PAPER_PDF_MIN_WIDTH,
  PAPER_SOURCE_MIN_WIDTH,
  problemsHeightCeiling,
} from "./split-limits.ts";
import { PAPER_CHAT_WIDTH_RANGE, PAPER_PDF_RATIO, PPTX_PAGES_WIDTH } from "../../../shared/settings.ts";

describe("clampPaperChatWidth（布局 B 对话栏）", () => {
  it("区间内原样、取整", () => {
    strictEqual(clampPaperChatWidth(340, 1440), 340);
    strictEqual(clampPaperChatWidth(399.6, 1440), 400);
  });

  it("上限是容器宽的一半（向下取整）", () => {
    strictEqual(clampPaperChatWidth(2000, 1440), 720);
    strictEqual(clampPaperChatWidth(2000, 600), 300);
    // 用户给的第三条：1600 窗口（容器 900）上存的 700，缩到 900 时被夹到 450
    strictEqual(clampPaperChatWidth(700, 900), 450);
    strictEqual(clampPaperChatWidth(2000, 1441), 720);
  });

  it("下限 280 压过「一半」：容器 600 时一半是 300，再窄也保 280", () => {
    strictEqual(clampPaperChatWidth(100, 600), 280);
    strictEqual(clampPaperChatWidth(2000, 500), 280);
  });

  it("reserved（稿件区最小宽）再压一次上限——不把 tex / pdf 挤坏", () => {
    // 1440 - 608 = 832 > 720：一半仍然是上限
    strictEqual(clampPaperChatWidth(2000, 1440, 608), 720);
    // 1100 - 608 = 492 < 550：稿件区的下限赢
    strictEqual(clampPaperChatWidth(2000, 1100, 608), 492);
    // 连着两个上限都不够时，下限 280 仍然兜底
    strictEqual(clampPaperChatWidth(2000, 800, 608), 280);
  });

  it("容器量不到（0 / 非数）时退回存储硬上界，不下不可能的值", () => {
    strictEqual(clampPaperChatWidth(9999), 4096);
    strictEqual(clampPaperChatWidth(700, 0), 700);
    strictEqual(clampPaperChatWidth(700, Number.NaN), 700);
  });

  it("非数回默认 340", () => {
    strictEqual(clampPaperChatWidth(Number.NaN, 1440), 340);
    strictEqual(clampPaperChatWidth(Number.POSITIVE_INFINITY, 1440), 340);
  });
});

describe("clampPptxPagesWidth（.pptx 页列表）", () => {
  it("区间内原样、取整", () => {
    strictEqual(clampPptxPagesWidth(184), 184);
    strictEqual(clampPptxPagesWidth(200.4), 200);
  });

  it("两端夹住：140 / 360", () => {
    strictEqual(clampPptxPagesWidth(10), PPTX_PAGES_WIDTH.min);
    strictEqual(clampPptxPagesWidth(1000), PPTX_PAGES_WIDTH.max);
  });

  it("非数回默认 184", () => {
    strictEqual(clampPptxPagesWidth(Number.NaN), PPTX_PAGES_WIDTH.default);
  });
});

describe("clampProblemsHeight（问题抽屉）", () => {
  it("上限是视口的 70%", () => {
    strictEqual(problemsHeightCeiling(1000), 700);
    strictEqual(clampProblemsHeight(900, 1000), 700);
    strictEqual(clampProblemsHeight(700, 1000), 700);
  });

  it("下界 96", () => {
    strictEqual(clampProblemsHeight(10, 1000), 96);
    strictEqual(clampProblemsHeight(96, 1000), 96);
  });

  it("视口矮到 70% 不足 96 时保下界（不产生一个比下界还小的值）", () => {
    strictEqual(problemsHeightCeiling(100), 96);
    strictEqual(clampProblemsHeight(500, 100), 96);
  });

  it("非数回下界；高度取整", () => {
    strictEqual(clampProblemsHeight(Number.NaN, 1000), 96);
    strictEqual(clampProblemsHeight(200.6, 1000), 201);
  });
});

describe("clampPaperPdfRatio / paperPdfRatioFromLeftWidth（源码 ↔ PDF）", () => {
  it("宽面板：0.2–0.8 就是比例区间", () => {
    // 1600 宽：0.2 = 320、0.8 = 1280，两侧最小宽都满足
    strictEqual(clampPaperPdfRatio(0.2, 1600), 0.2);
    strictEqual(clampPaperPdfRatio(0.8, 1600), 0.8);
    strictEqual(clampPaperPdfRatio(0.9, 1600), 0.8);
    strictEqual(clampPaperPdfRatio(0.1, 1600), 0.2);
  });

  it("中等面板：每侧最小宽压过比例区间", () => {
    // 800 宽：源码 ≥320 → 比例 ≥0.4；PDF ≥280 → 比例 ≤0.65
    strictEqual(clampPaperPdfRatio(0.2, 800), PAPER_SOURCE_MIN_WIDTH / 800);
    strictEqual(clampPaperPdfRatio(0.8, 800), (800 - PAPER_PDF_MIN_WIDTH) / 800);
    // 区间内不动
    strictEqual(clampPaperPdfRatio(0.5, 800), 0.5);
  });

  it("下限恰好 320、上限恰好剩 280", () => {
    const left = PAPER_SOURCE_MIN_WIDTH;
    strictEqual(paperPdfRatioFromLeftWidth(left, 900) * 900, PAPER_SOURCE_MIN_WIDTH);
    strictEqual(paperPdfRatioFromLeftWidth(900 - PAPER_PDF_MIN_WIDTH, 900) * 900, 900 - PAPER_PDF_MIN_WIDTH);
  });

  it("量不到面板宽时只夹存储区间", () => {
    strictEqual(clampPaperPdfRatio(0.1, 0), 0.2);
    strictEqual(clampPaperPdfRatio(0.9, Number.NaN), 0.8);
    strictEqual(clampPaperPdfRatio(0.5, 0), 0.5);
  });

  it("面板窄到两侧最小宽之和都放不下（<600）时回 50/50", () => {
    strictEqual(clampPaperPdfRatio(0.8, 500), PAPER_PDF_RATIO.default);
    strictEqual(paperPdfRatioFromLeftWidth(450, 500), PAPER_PDF_RATIO.default);
  });

  it("夹到下限后不再越界（往返稳定）", () => {
    const once = clampPaperPdfRatio(0.2, 800);
    strictEqual(clampPaperPdfRatio(once, 800), once);
  });

  it("坏比例回默认", () => {
    deepStrictEqual(clampPaperPdfRatio(Number.NaN, 800), PAPER_PDF_RATIO.default);
  });
});
