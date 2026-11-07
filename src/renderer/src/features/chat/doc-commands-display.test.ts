import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { builtinCommand, docEditLabel, fileLabel, PINNED_CARD_COMMANDS, toolWord } from "./builtin-commands.ts";
import { toolCallSummary } from "./tool-results.ts";

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
});
