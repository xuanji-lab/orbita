import { describe, it, test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { estimateDocxPages, isDocxFile, sameDocxPath } from "./docx.ts";

describe("estimateDocxPages", () => {
  test("显式分页符与段落数取大者", () => {
    // 40 段 ≈ 1 页；分页符 3 个 → 至少 4 页
    strictEqual(estimateDocxPages({ paragraphs: 40, pageBreaks: 3, paraIds: 40 }), 4);
    // 24000 段 → 600 页（远超上限，这正是它要提前说出来的情形）
    strictEqual(estimateDocxPages({ paragraphs: 24000, pageBreaks: 0, paraIds: 0 }), 600);
    // 空文档也至少 1 页
    strictEqual(estimateDocxPages({ paragraphs: 0, pageBreaks: 0, paraIds: 0 }), 1);
  });
});

describe("isDocxFile", () => {
  test("只认 .docx（大小写不敏感）", () => {
    strictEqual(isDocxFile("/a/b/paper.docx"), true);
    strictEqual(isDocxFile("C:/x/PAPER.DOCX"), true);
    strictEqual(isDocxFile("/a/b/paper.doc"), false);
    strictEqual(isDocxFile("/a/b/docx"), false);
  });
});

describe("sameDocxPath", () => {
  test("分隔符与 Windows 盘符大小写不敏感（renderer 的 path 与消息里的 path 可能不同形）", () => {
    strictEqual(sameDocxPath("C:\\论文\\第三章.docx", "C:/论文/第三章.docx"), true);
    strictEqual(sameDocxPath("C:\\Papers\\A.DOCX", "c:/papers/a.docx"), true);
    strictEqual(sameDocxPath("/Users/me/a.docx", "/Users/me/a.docx"), true);
  });

  test("不同文件（大小写敏感平台上同名不同大小写算两份）与尾斜杠", () => {
    strictEqual(sameDocxPath("/Users/me/A.docx", "/Users/me/a.docx"), false);
    strictEqual(sameDocxPath("/Users/me/a.docx/", "/Users/me/a.docx"), true);
    strictEqual(sameDocxPath("/Users/me/a.docx", "/Users/me/b.docx"), false);
  });
});
