/**
 * 论文工作台几处拆分条的**限位纯函数**（拖动、键盘、双击复位共用一份数字）。
 *
 * 为什么单独一个模块：组件连着 React 与 IPC，`node --test` 加载不了；这里全是
 * 输入 → 输出，限位规则可以在单测里逐条钉住（`split-limits.test.ts`）。
 *
 * **存比例不存像素**（源码 ↔ PDF）：面板宽随布局与窗口变化，像素值换个窗口就不再
 * 是用户要的那个比例；每侧最小宽按当前面板宽现算。
 *
 * 相对 import 带 `.ts`、走相对路径（不是 `@shared` 别名）：`node --test` 直接加载
 * 源码，别名解析不到（同 paper-layout.ts / pdf-tab.ts 的纪律）。
 */
import {
  PAPER_CHAT_WIDTH_RANGE,
  PAPER_PDF_RATIO,
  PPTX_PAGES_WIDTH,
  PROBLEMS_HEIGHT,
} from "../../../shared/settings.ts";

/** 并排时源码（左块）的最小宽（px）：再窄编辑器就只剩几个字。 */
export const PAPER_SOURCE_MIN_WIDTH = 320;

/** 并排时 PDF（右块）的最小宽（px）：再窄一页的版心读不下来。 */
export const PAPER_PDF_MIN_WIDTH = 280;

/**
 * 布局 B 里「稿件区」至少要留的宽（px）：拆分条 7 + 源码 320 + PDF 280 + 1px 壳边。
 * 对话栏的上限除了「容器一半」，还得让出这一块——否则两块的 min-width 加起来
 * 比容器还宽，PDF 会被挤出去而不是被夹住。
 */
export const PAPER_SPLIT_MIN_TOTAL = PAPER_SOURCE_MIN_WIDTH + PAPER_PDF_MIN_WIDTH + 8;

/**
 * 布局 B 对话栏宽：**下限 280，上限是容器宽的一半（向下取整）**。
 *
 * 为什么上限不是固定像素（2026-11-25 用户裁决）：「模式 B 这里，会话区间太窄了。
 * 最宽应该是一半。」对话栏在右、稿件区在左，一半对一半是允许的形态。
 *
 * - `containerWidth` = 布局 B 里承载「稿件区 + 对话栏」的那一层（`.pane`），不是 window；
 * - `reserved` = 稿件区至少要让出的宽（见 PAPER_SPLIT_MIN_TOTAL / PAPER_SOURCE_MIN_WIDTH）。
 *   两个上限取小：一半可以，但不能把 tex / pdf 压到它们的下限以下；
 * - 容器量不到（0 / 非数）时退回固定上界（存储硬上界），不再猜用户想要多宽。
 */
export function clampPaperChatWidth(width: number, containerWidth = 0, reserved = 0): number {
  if (!Number.isFinite(width)) return PAPER_CHAT_WIDTH_RANGE.default;
  const measured = Number.isFinite(containerWidth) && containerWidth > 0;
  const half = measured ? Math.floor(containerWidth * 0.5) : PAPER_CHAT_WIDTH_RANGE.max;
  const leave = measured && reserved > 0 ? Math.floor(containerWidth - reserved) : PAPER_CHAT_WIDTH_RANGE.max;
  const ceiling = Math.max(PAPER_CHAT_WIDTH_RANGE.min, Math.min(half, leave));
  return Math.round(Math.min(ceiling, Math.max(PAPER_CHAT_WIDTH_RANGE.min, width)));
}

/** `.pptx` 大纲页列表宽：140–360。 */
export function clampPptxPagesWidth(width: number): number {
  if (!Number.isFinite(width)) return PPTX_PAGES_WIDTH.default;
  return Math.round(Math.min(PPTX_PAGES_WIDTH.max, Math.max(PPTX_PAGES_WIDTH.min, width)));
}

/** 问题抽屉高度的上限 = 视口高 × 70%；视口矮到 70% 还不到下界时保下界。 */
export function problemsHeightCeiling(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return PROBLEMS_HEIGHT.max;
  return Math.max(PROBLEMS_HEIGHT.min, Math.round(viewportHeight * 0.7));
}

/** 问题抽屉高：96 – min(70vh, 存储硬上界)。 */
export function clampProblemsHeight(height: number, viewportHeight: number): number {
  if (!Number.isFinite(height)) return PROBLEMS_HEIGHT.min;
  const ceiling = problemsHeightCeiling(viewportHeight);
  return Math.round(Math.min(ceiling, Math.max(PROBLEMS_HEIGHT.min, height)));
}

/**
 * 把「源码块的宽度比例」夹进合法区间：
 * - 存储区间 0.2–0.8；
 * - 源码 ≥ 320、PDF ≥ 280（按当前面板宽现算）。
 *
 * `paneWidth` 量不到（0 / 非数）时只夹存储区间；面板窄到两边最小值之和都放不下
 * （< 600）时回到 50/50——两侧都守不住，对半分至少不把其中一块挤成一条缝。
 */
export function clampPaperPdfRatio(ratio: number, paneWidth: number): number {
  if (!Number.isFinite(ratio)) return PAPER_PDF_RATIO.default;
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) {
    return Math.min(PAPER_PDF_RATIO.max, Math.max(PAPER_PDF_RATIO.min, ratio));
  }
  if (paneWidth < PAPER_SOURCE_MIN_WIDTH + PAPER_PDF_MIN_WIDTH) return PAPER_PDF_RATIO.default;
  const minLeft = Math.max(PAPER_PDF_RATIO.min * paneWidth, PAPER_SOURCE_MIN_WIDTH);
  const maxLeft = Math.min(PAPER_PDF_RATIO.max * paneWidth, paneWidth - PAPER_PDF_MIN_WIDTH);
  if (minLeft > maxLeft) return PAPER_PDF_RATIO.default;
  return Math.min(maxLeft, Math.max(minLeft, ratio * paneWidth)) / paneWidth;
}

/** 从「左块想要的像素宽」反算比例（拖动中与键盘共用），已夹过最小宽与比例区间。 */
export function paperPdfRatioFromLeftWidth(left: number, paneWidth: number): number {
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) return PAPER_PDF_RATIO.default;
  return clampPaperPdfRatio(left / paneWidth, paneWidth);
}
