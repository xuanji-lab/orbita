import { describe, test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { estimateDocxPages, isDocxFile } from "./docx.ts";

describe("estimateDocxPages", () => {
  test("显式分页符与段落数取大者", () => {
    // 40 段 ≈ 1 页；分页符 3 个 → 至少 4 页
    strictEqual(estimateDocxPages({ paragraphs: 40, pageBreaks: 3 }), 4);
    // 24000 段 → 600 页（远超上限，这正是它要提前说出来的情形）
    strictEqual(estimateDocxPages({ paragraphs: 24000, pageBreaks: 0 }), 600);
    // 空文档也至少 1 页
    strictEqual(estimateDocxPages({ paragraphs: 0, pageBreaks: 0 }), 1);
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
