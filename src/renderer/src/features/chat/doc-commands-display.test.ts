import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { builtinCommand, docEditLabel, docEditPath, docEditSection, docEditSummary, fileLabel, PINNED_CARD_COMMANDS, toolWord } from "./builtin-commands.ts";
import { parseEditDiff, rollupToolKey, toolCallSummary } from "./tool-results.ts";

describe("文档内置命令的展示", () => {
  it("中文名与参数摘要", () => {
    assert.equal(builtinCommand("doc_open")?.label, "打开文档");
    assert.equal(builtinCommand("doc_insert_image")?.label, "插入图片");
    assert.equal(builtinCommand("doc_export")?.label, "导出文档");
    assert.equal(toolCallSummary("doc_open", { path: "周报/2026-W45.md" }), "2026-W45");
    assert.equal(toolCallSummary("doc_open", { path: "新笔记.md", create: true }), "新笔记 · 新建");
    assert.equal(toolCallSummary("doc_insert_image", { path: "a.md", image_path: "/x/y/pipeline.png", after_line: 12 }), "a · pipeline.png · 第 12 行后");
    assert.equal(toolCallSummary("doc_export", { path: "a.md", format: "docx" }), "Word · a");
    assert.equal(toolCallSummary("doc_export", { path: "a.md", format: "md-plain" }), "Markdown · 通用格式 · a");
    assert.equal(toolCallSummary("doc_open", {}), null);
  });

  it("打开与导出钉卡，插图不钉", () => {
    assert.ok(PINNED_CARD_COMMANDS.has("doc_open"));
    assert.ok(PINNED_CARD_COMMANDS.has("doc_export"));
    assert.ok(!PINNED_CARD_COMMANDS.has("doc_insert_image"));
  });

  it("文件标签去掉 .markdown / .txt", () => {
    assert.equal(fileLabel("/a/随手记.txt"), "随手记");
    assert.equal(fileLabel("/a/x.markdown"), "x");
  });

  it("edit / write 落在文档文件上药丸写「改文档 / 写文档」，其它不动", () => {
    assert.equal(docEditLabel("edit", { path: "/w/周报.md" }), "改文档");
    assert.equal(docEditLabel("write", { path: "/w/a.txt" }), "写文档");
    assert.equal(docEditLabel("edit", { path: "/w/main.ts" }), null);
    assert.equal(docEditLabel("read", { path: "/w/周报.md" }), null);
    assert.equal(docEditLabel("edit", {}), null);
  });

  it("统计 / 步骤行的工具词：内置命令中文名、文档 edit 写「改文档」，其它走词表", () => {
    const table = (key: string): string => (key === "edit" ? "编辑" : key === "read" ? "读取" : key);
    assert.equal(toolWord(table, "doc_export"), "导出文档");
    assert.equal(toolWord(table, "edit", { path: "/w/a.md" }), "改文档");
    assert.equal(toolWord(table, "edit", { path: "/w/a.ts" }), "编辑");
    assert.equal(toolWord(table, "edit"), "编辑");
    assert.equal(toolWord(table, "read", { path: "/w/a.md" }), "读取");
  });

  it("改文档的摘要：文件名 · 第几节（diff 上下文里的标题，退到开着的文档全文）", () => {
    const rows = parseEditDiff(" 10 ## 下周计划\n 11 \n+12 > [!tip] 提示\n+13 > 周五前提交\n 14 - 旧条目");
    assert.equal(docEditSection(rows, null), "下周计划");
    // diff 上下文够不到标题：回溯开着的文档全文
    const far = parseEditDiff(" 40 一段话\n+41 新加的一句\n 42 另一段");
    const text = "# 周报\n\n## **风险** 与 [[应对|对策]]\n\n一段话\n新加的一句\n另一段";
    assert.equal(docEditSection(far, text), "风险 与 对策");
    assert.equal(docEditSection(far, null), null);
    assert.equal(docEditSection(far, "没有标题\n新加的一句"), null);
    // 新增行本身是标题：就是这一节
    assert.equal(docEditSection(parseEditDiff("+5 ### 新小节\n+6 内容"), null), "新小节");
    assert.equal(docEditSummary("/w/周报/2026-W45.md", "下周计划"), "2026-W45 · 下周计划");
    assert.equal(docEditSummary("/w/周报/2026-W45.md", null), "2026-W45");
  });

  it("docEditPath 只认文档文件上的 edit / write", () => {
    assert.equal(docEditPath("edit", { path: "/w/a.md" }), "/w/a.md");
    assert.equal(docEditPath("write", { path: "/w/a.ts" }), null);
    assert.equal(docEditPath("read", { path: "/w/a.md" }), null);
  });

  it("统计 / 折叠摘要行：文档上的 edit / write 归成「改文档 / 写文档」，改代码的 edit 仍是词表里的「编辑」", () => {
    const table = (key: string): string => (key === "edit" ? "编辑" : key === "write" ? "写入" : key);
    const key = (name: string, path: string): string => rollupToolKey(name, { path });
    assert.equal(key("edit", "/w/周报.md"), "doc_edit");
    assert.equal(key("write", "/w/随手记.txt"), "doc_write");
    assert.equal(key("edit", "/w/main.ts"), "edit");
    assert.equal(toolWord(table, key("edit", "/w/周报.md")), "改文档");
    assert.equal(toolWord(table, key("write", "/w/a.markdown")), "写文档");
    assert.equal(toolWord(table, key("edit", "/w/main.ts")), "编辑");
    // 读文档仍是「读取」，不被归进文档类
    assert.equal(key("read", "/w/周报.md"), "read");
  });
});
