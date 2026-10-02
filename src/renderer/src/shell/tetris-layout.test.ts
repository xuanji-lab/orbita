import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  columnsForWidth,
  fileSpan,
  imageSpan,
  packedRows,
  pastedSpan,
  quoteSpan,
  TETRIS_MAX_ROWS,
  TETRIS_PASTED_TALL_LINES,
  TETRIS_STEP_PX,
  textWidthPx,
} from "./tetris-layout.ts";

describe("textWidthPx：字符估宽", () => {
  it("全宽字符 13px、半宽 7.2px，混合相加", () => {
    deepStrictEqual(textWidthPx("汉"), 13);
    deepStrictEqual(textWidthPx("a"), 7.2);
    deepStrictEqual(textWidthPx("汉a"), 20.2);
  });

  it("空串是 0，不炸", () => {
    deepStrictEqual(textWidthPx(""), 0);
  });
});

describe("四种材料的形状", () => {
  it("截图恒 2×2 正方形", () => {
    deepStrictEqual(imageSpan(), { col: 2, row: 2 });
  });

  it("文件宽度跟名字走，夹在 3–10 列", () => {
    // 短名（a.ts ≈ 21.6px + 60 chrome）也至少 3 列
    deepStrictEqual(fileSpan("a.ts"), { col: 3, row: 1 });
    // 长名到顶就停（10 列），名字再长也是这个宽度、内部省略
    const long = "very-long-file-name-that-keeps-going.tsx";
    const longer = `${long}${long}`;
    deepStrictEqual(fileSpan(long).col, 10);
    deepStrictEqual(fileSpan(longer), { col: 10, row: 1 });
  });

  it("粘贴按行数分两档：≤100 行 1 行高，>100 行 2 行高", () => {
    deepStrictEqual(pastedSpan(TETRIS_PASTED_TALL_LINES), { col: 5, row: 1 });
    deepStrictEqual(pastedSpan(TETRIS_PASTED_TALL_LINES + 1), { col: 6, row: 2 });
  });

  it("引用是长条：短引也有 7 列，长引最多 14 列", () => {
    deepStrictEqual(quoteSpan("好"), { col: 7, row: 1 });
    // 一句 60 个汉字的引用要宽得多，但封顶 14 列
    const longQuote = "这".repeat(60);
    deepStrictEqual(quoteSpan(longQuote).col, 14);
    deepStrictEqual(quoteSpan(`${longQuote}${longQuote}`), { col: 14, row: 1 });
  });
});

describe("columnsForWidth：容器宽 → 列数", () => {
  it("按步进取整，至少 1 列", () => {
    // 680px 的 composer：680 + 4 = 684 / 34 = 20 列
    deepStrictEqual(columnsForWidth(680), 20);
    deepStrictEqual(columnsForWidth(0), 1);
    deepStrictEqual(columnsForWidth(-5), 1);
  });
});

describe("packedRows：dense 排布的行数模拟", () => {
  it("一排装得下就是 1 行", () => {
    // 20 列的容器，三个 1 行高的小块
    deepStrictEqual(packedRows([{ col: 3, row: 1 }, { col: 5, row: 1 }, { col: 2, row: 1 }], 20), 1);
  });

  it("装不下换行：总宽超过列数就折到第 2 行", () => {
    deepStrictEqual(packedRows([{ col: 12, row: 1 }, { col: 12, row: 1 }], 20), 2);
  });

  it("2×2 截图留下的洞被 dense 回填：后续 1 行高的块补进第 1 行", () => {
    // 4 列容器：2×2 截图占掉第 1–2 行的 1–2 列，右边 1×1 排进第 1 行，
    // 1×2 排进 4 列（从第 1 行起），总行数 2 而不是 3
    deepStrictEqual(
      packedRows([{ col: 2, row: 2 }, { col: 1, row: 1 }, { col: 1, row: 2 }], 4),
      2,
    );
  });

  it("块比容器宽（列跨度被夹到列数）也能放下，不炸不悬死", () => {
    deepStrictEqual(packedRows([{ col: 30, row: 1 }], 6), 1);
    deepStrictEqual(packedRows([{ col: 30, row: 2 }], 6), 2);
  });

  it("空材料 0 行", () => {
    deepStrictEqual(packedRows([], 12), 0);
  });

  it("大量材料折出多行——折叠阈值（4 行）由它判定", () => {
    // 12 列容器塞 30 个 3×1 的文件块：dense 也排不下 4 行
    const spans = Array.from({ length: 30 }, () => ({ col: 3, row: 1 }));
    deepStrictEqual(packedRows(spans, 12) > TETRIS_MAX_ROWS, true);
  });
});

describe("常量自洽", () => {
  it("步进 = 格边长 + 间距（估宽换列数与 CSS 同源）", () => {
    deepStrictEqual(TETRIS_STEP_PX, 34);
  });
});
