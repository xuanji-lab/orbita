import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_COMMANDS, builtinCommand, fileLabel, pagesLabel, PINNED_CARD_COMMANDS } from "./builtin-commands.ts";
import { toolCallSummary, groupToolUnits, type ToolCallUnit } from "./tool-results.ts";

const call = (id: string, toolName: string): ToolCallUnit => ({
  kind: "toolCall",
  key: id,
  messageId: "m",
  toolCallId: id,
  toolName,
  input: {},
  timestamp: 0,
});

describe("内置命令注册表", () => {
  it("每个命令有中文名、图标与摘要函数", () => {
    for (const [id, command] of Object.entries(BUILTIN_COMMANDS)) {
      assert.match(command.label, /[\u4e00-\u9fff]/, `${id} 的名字应是中文`);
      assert.ok(command.icon.length > 0);
      assert.equal(typeof command.summary, "function");
    }
  });

  it("不认识的工具不在表里", () => {
    assert.equal(builtinCommand("bash"), null);
    assert.equal(builtinCommand("hasOwnProperty"), null);
  });

  it("页号标签：单页 / 连续 / 离散 / 非法", () => {
    assert.equal(pagesLabel([3]), "第 3 页");
    assert.equal(pagesLabel([1, 2, 3, 4, 5]), "第 1–5 页");
    assert.equal(pagesLabel([5, 1, 3]), "第 1、3、5 页");
    assert.equal(pagesLabel([0, -1, 1.5]), null);
    assert.equal(pagesLabel([]), null);
  });

  it("文件标签去掉 .slides.json / .md", () => {
    assert.equal(fileLabel("/a/b/花园城市.slides.json"), "花园城市");
    assert.equal(fileLabel("C:\\x\\周报.md"), "周报");
  });
});

describe("参数摘要", () => {
  it("slides_create：标题 · 比例", () => {
    assert.equal(toolCallSummary("slides_create", { title: "花园城市新加坡", aspect: "16:9" }), "花园城市新加坡 · 16:9");
    assert.equal(toolCallSummary("slides_create", { title: "x" }), "x");
    assert.equal(toolCallSummary("slides_create", {}), null);
    assert.equal(toolCallSummary("slides_create", null), null);
  });

  it("slides_write：页号 + 元素统计，箭头线单独叫箭头", () => {
    const summary = toolCallSummary("slides_write", {
      slides: [
        { at: 2, elements: [{ kind: "line", endArrow: "arrow" }, { kind: "text" }, { kind: "text" }] },
        { at: "append", elements: [{ kind: "table" }] },
      ],
    });
    assert.equal(summary, "第 2 页 · 追加 1 页 · 箭头 · 文字 ×2 · 表格");
    assert.equal(toolCallSummary("slides_write", { slides: [1, 2, 3, 4, 5].map((at) => ({ at })) }), "第 1–5 页");
  });

  it("slides_edit：页号 + 改动数", () => {
    assert.equal(toolCallSummary("slides_edit", { ops: [{ op: "patch", slide: 2, id: "a" }] }), "第 2 页 · 1 处改动");
    assert.equal(toolCallSummary("slides_edit", { ops: [] }), null);
  });

  it("slides_insert_image / slides_export", () => {
    assert.equal(toolCallSummary("slides_insert_image", { slide: 3, image_path: "/x/hawker.jpg" }), "第 3 页 · hawker.jpg");
    assert.equal(toolCallSummary("slides_export", { format: "pptx-basic" }), "PowerPoint · 通用字体");
    assert.equal(toolCallSummary("slides_export", { format: "png", page: 4 }), "当前页图片 · 第 4 页");
  });
});

describe("分组与钉卡", () => {
  it("相邻的内置命令不并组（每次调用各占一行）", () => {
    const entries = groupToolUnits([call("1", "slides_write"), call("2", "slides_write")]);
    assert.deepEqual(entries.map((entry) => entry.kind), ["toolCall", "toolCall"]);
  });

  it("slides_create 与 slides_export 钉卡，写 / 改不钉", () => {
    assert.ok(PINNED_CARD_COMMANDS.has("slides_create"));
    assert.ok(PINNED_CARD_COMMANDS.has("slides_export"));
    assert.ok(!PINNED_CARD_COMMANDS.has("slides_write"));
  });
});
