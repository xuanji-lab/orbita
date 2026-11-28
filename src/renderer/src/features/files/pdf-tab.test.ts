/**
 * PDF 标签的账：产物 → 标签（多产物各一个）、开 / 关 / 刷新、只在有标签时并排、
 * 按会话记住关掉的意愿。夹具用回执 v2 的 LatexOutput 形状，不是自造的简写。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LatexOutput } from "../../../../shared/latex.ts";
import {
  closePdfTab,
  pdfPaneModeOf,
  pdfPanePathOf,
  pdfSplitOf,
  pdfTabFacts,
  reconcilePdfTabs,
  recallPdfCollapsed,
  rememberPdfCollapsed,
} from "./pdf-tab.ts";

const output = (path: string, patch: Partial<LatexOutput> = {}): LatexOutput => ({
  path,
  kind: "pdf",
  primary: false,
  fresh: true,
  pages: 12,
  bytes: 1024,
  modifiedAt: 1_000,
  fromLog: null,
  ...patch,
});

describe("pdfTabFacts", () => {
  test("项目 PDF 与本次产物去重，primary 在前，标题取末段", () => {
    const facts = pdfTabFacts({
      projectPdf: { path: "/p/build/main.pdf", modifiedAt: 900 },
      outputs: [output("/p/build/main.pdf", { primary: true, pages: 7, modifiedAt: 1000 })],
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.label, "main.pdf");
    // 页数来自 outputs（项目 PDF 那条自己不知道页数）
    assert.equal(facts[0]?.pages, 7);
    assert.equal(facts[0]?.modifiedAt, 900);
  });

  test("多产物 = 每个 PDF 一个标签；非 PDF 产物不成标签", () => {
    const facts = pdfTabFacts({
      projectPdf: { path: "C:\\paper\\build\\main.pdf", modifiedAt: 1000 },
      outputs: [
        output("C:\\paper\\build\\main.pdf", { primary: true }),
        output("C:\\paper\\build\\appendix.pdf", { pages: 3 }),
        output("C:\\paper\\build\\main.dvi", { kind: "other", pages: null }),
      ],
    });
    assert.deepEqual(
      facts.map((fact) => fact.label),
      ["main.pdf", "appendix.pdf"],
    );
  });

  test("没有项目 PDF、也没有产物 → 没有标签", () => {
    assert.deepEqual(pdfTabFacts({ projectPdf: null, outputs: null }), []);
  });

  test("Windows 反斜杠与正斜杠是同一个产物（不重复开标签）", () => {
    const facts = pdfTabFacts({
      projectPdf: { path: "C:/paper/build/main.pdf", modifiedAt: 1 },
      outputs: [output("C:\\paper\\build\\main.pdf")],
    });
    assert.equal(facts.length, 1);
  });
});

describe("reconcilePdfTabs —— 开 / 刷新 / 关", () => {
  const facts = pdfTabFacts({
    projectPdf: { path: "/p/main.pdf", modifiedAt: 1 },
    outputs: [output("/p/main.pdf", { primary: true })],
  });

  test("没开过、也没关过 → 自动打开全部产物", () => {
    assert.deepEqual(reconcilePdfTabs({ open: [], facts, collapsed: false }), ["/p/main.pdf"]);
  });

  test("用户关过 → 再编译也不自己重开（关掉是明确意愿）", () => {
    assert.deepEqual(reconcilePdfTabs({ open: [], facts, collapsed: true }), []);
  });

  test("有 PDF 就有标签：没表过态（新会话 / 窄窗）一律默认打开", () => {
    // 默认只看记忆：没记过 = false（没关过）——与窗口宽 / 布局无关
    const collapsed = recallPdfCollapsed(new Map(), "s-new");
    assert.deepEqual(reconcilePdfTabs({ open: [], facts, collapsed }), ["/p/main.pdf"]);
  });

  test("关掉后再编译（产物换了 mtime）→ 仍然关着", () => {
    const refreshed = pdfTabFacts({
      projectPdf: { path: "/p/main.pdf", modifiedAt: 2_000 },
      outputs: [output("/p/main.pdf", { primary: true, modifiedAt: 2_000 })],
    });
    assert.deepEqual(reconcilePdfTabs({ open: [], facts: refreshed, collapsed: true }), []);
  });

  test("重新编译：路径没变 → 还是同一个标签（不重开、不换位）", () => {
    assert.deepEqual(reconcilePdfTabs({ open: ["/p/main.pdf"], facts, collapsed: false }), ["/p/main.pdf"]);
  });

  test("产物换成另一个路径（改了 jobname / outDir）→ 旧标签退场，新产物按记忆决定", () => {
    const next = pdfTabFacts({ projectPdf: { path: "/p/build/thesis.pdf", modifiedAt: 2 }, outputs: null });
    assert.deepEqual(reconcilePdfTabs({ open: ["/p/main.pdf"], facts: next, collapsed: false }), [
      "/p/build/thesis.pdf",
    ]);
    assert.deepEqual(reconcilePdfTabs({ open: ["/p/main.pdf"], facts: next, collapsed: true }), []);
  });

  test("产物消失（清理 / 换项目）→ 标签收掉", () => {
    assert.deepEqual(reconcilePdfTabs({ open: ["/p/main.pdf"], facts: [], collapsed: false }), []);
  });
});

describe("closePdfTab / pdfPanePathOf", () => {
  const facts = pdfTabFacts({
    projectPdf: { path: "/p/main.pdf", modifiedAt: 1 },
    outputs: [
      output("/p/main.pdf", { primary: true }),
      output("/p/appendix.pdf"),
    ],
  });

  test("关一个只删它；关掉最后一个 = 右栏没有 PDF", () => {
    assert.deepEqual(closePdfTab(["/p/main.pdf", "/p/appendix.pdf"], "/p/appendix.pdf"), ["/p/main.pdf"]);
    assert.equal(pdfPanePathOf({ open: [], facts, activePdfPath: null }), null);
  });

  test("右栏优先显示激活的那个 PDF 标签，否则第一个", () => {
    assert.equal(pdfPanePathOf({ open: ["/p/main.pdf", "/p/appendix.pdf"], facts, activePdfPath: null }), "/p/main.pdf");
    assert.equal(
      pdfPanePathOf({ open: ["/p/main.pdf", "/p/appendix.pdf"], facts, activePdfPath: "/p/appendix.pdf" }),
      "/p/appendix.pdf",
    );
  });

  test("激活的标签已不在开着的那组里 → 退回第一个（不显示一个没人开着的文件）", () => {
    assert.equal(
      pdfPanePathOf({ open: ["/p/main.pdf"], facts, activePdfPath: "/p/appendix.pdf" }),
      "/p/main.pdf",
    );
  });
});

describe("pdfSplitOf —— 并排只由有没有 PDF 标签 + 面板容不容得下决定", () => {
  test("有 PDF 标签 + 左栏有文件 + 面板容得下 → 并排", () => {
    assert.equal(
      pdfSplitOf({ panePath: "/p/main.pdf", sourcePath: "/p/main.tex", splitAllowed: true }),
      true,
    );
  });

  test("没有 PDF 标签 → 不并排（Word / Excel / PPT 不再出现空白 PDF 栏）", () => {
    assert.equal(
      pdfSplitOf({ panePath: null, sourcePath: "/p/report.docx", splitAllowed: true }),
      false,
    );
  });

  test("面板窄到容不下 → 不硬挤成两栏", () => {
    assert.equal(
      pdfSplitOf({ panePath: "/p/main.pdf", sourcePath: "/p/main.tex", splitAllowed: false }),
      false,
    );
  });

  test("左栏就是那份 PDF → 不自己跟自己并排", () => {
    assert.equal(
      pdfSplitOf({ panePath: "C:/p/main.pdf", sourcePath: "C:\\p\\main.pdf", splitAllowed: true }),
      false,
    );
  });
});

describe("pdfPaneModeOf —— 容得下就并排，容不下就单栏显示 PDF", () => {
  const facts = pdfTabFacts({
    projectPdf: { path: "/p/main.pdf", modifiedAt: 1 },
    outputs: [output("/p/main.pdf", { primary: true })],
  });
  const base = { open: ["/p/main.pdf"], facts, activePdfPath: null, sourcePath: "/p/main.tex" };

  test("窄窗点了 PDF 标签 → 单栏占满，而不是「不显示」", () => {
    assert.deepEqual(pdfPaneModeOf({ ...base, splitAllowed: false, pdfFocused: true }), {
      kind: "solo",
      path: "/p/main.pdf",
    });
  });

  test("窄窗没点标签 → 只有源码那一栏（标签仍在标签条里）", () => {
    assert.deepEqual(pdfPaneModeOf({ ...base, splitAllowed: false, pdfFocused: false }), {
      kind: "none",
    });
  });

  test("宽到容得下、但焦点在 PDF → 也单独全幅（2026-11-27 用户裁决：点 PDF 就是聚焦 PDF）", () => {
    assert.deepEqual(pdfPaneModeOf({ ...base, splitAllowed: true, pdfFocused: true }), {
      kind: "solo",
      path: "/p/main.pdf",
    });
  });

  test("宽到容得下、焦点在源码 → 并排", () => {
    assert.deepEqual(pdfPaneModeOf({ ...base, splitAllowed: true, pdfFocused: false }), {
      kind: "split",
      path: "/p/main.pdf",
    });
  });

  test("关掉标签（open 空）→ 回到单栏源码", () => {
    assert.deepEqual(
      pdfPaneModeOf({ ...base, open: [], splitAllowed: true, pdfFocused: true }),
      { kind: "none" },
    );
  });

  test("左栏就是这份 PDF → 不再叠一块", () => {
    assert.deepEqual(
      pdfPaneModeOf({
        ...base,
        sourcePath: "/p/main.pdf",
        splitAllowed: false,
        pdfFocused: true,
      }),
      { kind: "none" },
    );
  });
});

describe("按会话记住关掉的意愿（只存内存）", () => {
  test("没记过 = 没关过；记过就按会话取回", () => {
    let memory = rememberPdfCollapsed(new Map(), "s1", true);
    memory = rememberPdfCollapsed(memory, "s2", false);
    assert.equal(recallPdfCollapsed(memory, "s1"), true);
    assert.equal(recallPdfCollapsed(memory, "s2"), false);
    assert.equal(recallPdfCollapsed(memory, "s3"), false);
  });

  test("返回新 Map，不改传入值", () => {
    const before = rememberPdfCollapsed(new Map(), "s1", false);
    const after = rememberPdfCollapsed(before, "s1", true);
    assert.equal(recallPdfCollapsed(before, "s1"), false);
    assert.equal(recallPdfCollapsed(after, "s1"), true);
  });
});
