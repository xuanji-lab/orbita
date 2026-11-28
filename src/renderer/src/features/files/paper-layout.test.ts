import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { clampRightPanelWidth } from "../../../../shared/settings.ts";
import {
  autoSplitPanelWidth,
  effectivePaperLayout,
  nextPaperLayout,
  PAPER_LAYOUT_DEFAULT,
  PAPER_MIN_WINDOW,
  PAPER_SPLIT_PANEL_MIN,
  recallPaperLayout,
  rememberPaperLayout,
  shouldSplitPaper,
} from "./paper-layout.ts";

/**
 * 两种布局的状态机（原型「13 寸屏的两种布局」）。这里只测**裁决**：哪个布局生效、
 * 要不要并排、面板该多宽。几何（胶囊坐标）在 shell/window-tools.test.ts，
 * 显示形态在 styles.css——不在这里重复。
 */

describe("默认与切换：新会话是对话为主，同一个键在两态之间切", () => {
  test("默认是对话为主（布局 A）", () => {
    strictEqual(PAPER_LAYOUT_DEFAULT, "chat");
    strictEqual(recallPaperLayout(new Map(), "s1"), "chat");
    strictEqual(
      effectivePaperLayout({ wanted: PAPER_LAYOUT_DEFAULT, windowWidth: 1440, workbenchOpen: true }),
      "chat",
    );
  });

  test("切换是往返的：A→B→A（连点两次回到原样）", () => {
    strictEqual(nextPaperLayout("chat"), "paper");
    strictEqual(nextPaperLayout("paper"), "chat");
    strictEqual(nextPaperLayout(nextPaperLayout("chat")), "chat");
  });
});

describe("每个会话记住自己的布局（只存内存）", () => {
  test("记过的会话取回自己的；没记过的会话回默认", () => {
    let memory = rememberPaperLayout(new Map(), "a", "paper");
    memory = rememberPaperLayout(memory, "b", "chat");
    strictEqual(recallPaperLayout(memory, "a"), "paper");
    strictEqual(recallPaperLayout(memory, "b"), "chat");
    strictEqual(recallPaperLayout(memory, "c"), "chat");
  });

  test("remember 返回新 Map，不改传入值", () => {
    const before = rememberPaperLayout(new Map(), "a", "chat");
    const after = rememberPaperLayout(before, "a", "paper");
    strictEqual(recallPaperLayout(before, "a"), "chat");
    strictEqual(recallPaperLayout(after, "a"), "paper");
  });
});

describe("生效布局：工作台没开 / 窗口太窄时退回对话为主", () => {
  test("想用 B、窗口够宽、工作台开着 → B", () => {
    strictEqual(
      effectivePaperLayout({ wanted: "paper", windowWidth: 1440, workbenchOpen: true }),
      "paper",
    );
  });

  test("窗口低于 1200 → 退回 A（960 也包含在内，不把三块一起挤坏）", () => {
    strictEqual(
      effectivePaperLayout({ wanted: "paper", windowWidth: PAPER_MIN_WINDOW - 1, workbenchOpen: true }),
      "chat",
    );
    strictEqual(effectivePaperLayout({ wanted: "paper", windowWidth: 960, workbenchOpen: true }), "chat");
    strictEqual(
      effectivePaperLayout({ wanted: "paper", windowWidth: PAPER_MIN_WINDOW, workbenchOpen: true }),
      "paper",
    );
  });

  test("文件面板没开 → 退回 A（B 的主位就是稿件工作台）", () => {
    strictEqual(
      effectivePaperLayout({ wanted: "paper", windowWidth: 2000, workbenchOpen: false }),
      "chat",
    );
  });
});

describe("并排：B 有 PDF 就并排；A 只在窗口 ≥ 1800 时自动并排", () => {
  const base = { workbenchOpen: true };
  test("布局 B：有 PDF 并排，没 PDF 不并排", () => {
    strictEqual(shouldSplitPaper({ ...base, layout: "paper", windowWidth: 1440, hasPdf: true }), true);
    strictEqual(shouldSplitPaper({ ...base, layout: "paper", windowWidth: 1440, hasPdf: false }), false);
  });

  test("布局 A 的边界：1799 单栏、1800 并排", () => {
    strictEqual(shouldSplitPaper({ ...base, layout: "chat", windowWidth: 1799, hasPdf: true }), false);
    strictEqual(shouldSplitPaper({ ...base, layout: "chat", windowWidth: 1800, hasPdf: true }), true);
  });

  test("窗口再宽也不在 A 里并排「空的一半」：没有 PDF 就不并排", () => {
    strictEqual(shouldSplitPaper({ ...base, layout: "chat", windowWidth: 2400, hasPdf: false }), false);
    // 工作台没开（右栏不是文件面板）也没有并排这回事
    strictEqual(
      shouldSplitPaper({ layout: "chat", windowWidth: 2400, hasPdf: true, workbenchOpen: false }),
      false,
    );
  });
});

describe("自动并排时右栏的下限宽", () => {
  test("只在 A 的自动并排触发时给 900，其余情况不干预（0）", () => {
    strictEqual(
      autoSplitPanelWidth({ layout: "chat", windowWidth: 1800, hasPdf: true, workbenchOpen: true }),
      PAPER_SPLIT_PANEL_MIN,
    );
    strictEqual(
      autoSplitPanelWidth({ layout: "chat", windowWidth: 1799, hasPdf: true, workbenchOpen: true }),
      0,
    );
    strictEqual(
      autoSplitPanelWidth({ layout: "paper", windowWidth: 2400, hasPdf: true, workbenchOpen: true }),
      0,
    );
  });

  test("900 在 1800 窗口、侧栏展开时仍落在既有的 2/3 上限内", () => {
    // P = 对话主区 + 右栏：窗口 − 两侧留白 − 侧栏 − 右图标条 − 留白
    const pane = 1800 - 12 - 288 - 12 - 32 - 12;
    deepStrictEqual(clampRightPanelWidth(PAPER_SPLIT_PANEL_MIN, pane), PAPER_SPLIT_PANEL_MIN);
    // 2/3 是上限：并排下限不会把它顶破
    strictEqual(PAPER_SPLIT_PANEL_MIN <= Math.floor((pane * 2) / 3), true);
  });
});
