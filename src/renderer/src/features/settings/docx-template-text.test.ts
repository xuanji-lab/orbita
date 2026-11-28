/**
 * 模板体检的句子（2026-11-15 验收 P1-3）：主进程只回 kind + 数字，句子在渲染层拼。
 * 这里钉住「中英各一套」「不可用原因有人话」「摘要不用英文」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { findingLine, problemText, reportFindings, reportText } from "./docx-template-text.ts";
import type { DocxTemplateReport } from "../../../../shared/docx-export.ts";

const okReport: DocxTemplateReport = {
  requested: "custom",
  path: "C:\\x.docx",
  ok: true,
  verdict: "warning",
  problem: null,
  summary: { styles: 49, headerFooter: 0, macros: false, warnings: 1 },
  note: null,
  findings: [
    { level: "ok", kind: "styles", styles: 49, headings: 6 },
    { level: "warn", kind: "header-footer-missing" },
    { level: "info", kind: "east-asian", language: "宋体" },
    { level: "ok", kind: "sections", count: 1, body: true, width: 11906, height: 16838 },
  ],
};

describe("模板体检文案", () => {
  it("摘要用人话：数字 + 页眉页脚 + 宏 + 提示数（中文里没有英文块）", () => {
    const text = reportText(okReport, zh);
    assert.ok(text.includes("49 个样式"), text);
    assert.ok(text.includes("0 个页眉页脚"), text);
    assert.ok(text.includes("1 条提示"), text);
    assert.equal(/[A-Za-z]{3,}/.test(text), false, `中文摘要里不该有英文：${text}`);
  });

  it("英文表同一份事实给英文句子", () => {
    const text = reportText(okReport, en);
    assert.ok(text.includes("49 styles"), text);
    assert.ok(text.includes("1 warning"), text);
  });

  it("结论行按 kind 取句子：样式数、缺页眉、东亚语言", () => {
    const lines = reportFindings(okReport, zh);
    assert.deepEqual(
      lines.map((line) => line.label),
      ["49 个段落 / 字符样式 · 定义了 6 级标题", "没有页眉页脚", "东亚语言：宋体", "1 节 · 11906×16838 twip"],
    );
    assert.equal(lines[1]?.detail, "产物里会缺页码与学校的页眉。");
    assert.equal(lines[0]?.detail, null);
  });

  it("不可用原因走 problem，不是一句英文", () => {
    assert.equal(problemText({ kind: "encrypted" }, zh), "这是一份有密码保护的 Word 文件（OLE2 容器），不是能读的 .docx。");
    assert.ok(problemText({ kind: "too-large", mb: 80 }, zh).includes("80 MB"));
    const report: DocxTemplateReport = {
      requested: "custom",
      path: "x.docx",
      ok: false,
      verdict: "unusable",
      problem: { kind: "no-document" },
      summary: null,
      note: null,
      findings: [{ level: "warn", kind: "problem", problem: { kind: "no-document" } }],
    };
    assert.equal(reportText(report, zh), "包里没有 word/document.xml——不是 Word 文档。");
    // 与摘要重复的那条 problem 不进展开列表
    assert.deepEqual(reportFindings(report, zh), []);
  });

  it("项目内模板是一个说明，不是体检结论", () => {
    const report: DocxTemplateReport = {
      requested: "project",
      path: null,
      ok: true,
      verdict: "ok",
      problem: null,
      summary: null,
      note: "project",
      findings: [],
    };
    assert.equal(reportText(report, zh), zh.settings.docxTemplateProjectHint);
  });

  it("每条结论都有中英两版（缺一条就是页面里混一句外语）", () => {
    for (const finding of okReport.findings) {
      const cn = findingLine(finding, zh).label;
      const us = findingLine(finding, en).label;
      assert.ok(cn.length > 0 && us.length > 0);
      assert.notEqual(cn, us);
    }
  });
});
