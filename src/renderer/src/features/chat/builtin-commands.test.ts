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
    // 没给画幅 = 默认的 16:9，摘要始终是「标题 · 画幅」，不带别的
    assert.equal(toolCallSummary("slides_create", { title: "x" }), "x · 16:9");
    assert.equal(toolCallSummary("slides_create", { title: "x", aspect: "4:3" }), "x · 4:3");
    assert.equal(toolCallSummary("slides_create", {}), null);
    assert.equal(toolCallSummary("slides_create", null), null);
  });

  it("slides_write：版式的图片槽位在摘要里写「插图 文件名」（取代单独的插入图片调用，用户一眼看到放了图）", () => {
    assert.equal(
      toolCallSummary("slides_write", { slides: [{ at: 3, layout: "image-right", slots: { title: "小贩中心", image: "素材/hawker.jpg" } }] }),
      "第 3 页 · 插图 hawker.jpg",
    );
    assert.equal(
      toolCallSummary("slides_write", { slides: [{ layout: "image-full", slots: { image: "/Users/x/图 库/滨海湾.png" } }] }),
      "追加 1 页 · 插图 滨海湾.png",
    );
    // 文件名完整不省略
    assert.match(toolCallSummary("slides_write", { slides: [{ at: 2, slots: { image: "a/一个很长很长的文件名-final-v3.jpeg" } }] }) ?? "", /插图 一个很长很长的文件名-final-v3\.jpeg$/);
    // 用户附在对话里的图：没有原文件名，写「附图」
    assert.equal(toolCallSummary("slides_write", { slides: [{ at: 3, slots: { image: "attached" } }] }), "第 3 页 · 插图 附图");
    assert.equal(toolCallSummary("slides_write", { slides: [{ at: 3, slots: { image: "attached:2" } }] }), "第 3 页 · 插图 附图 2");
    // 没有图片槽位的版式页不多出「插图」
    assert.equal(toolCallSummary("slides_write", { slides: [{ at: 1, layout: "cover", slots: { title: "T" } }] }), "第 1 页");
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

  it("展开体：内置命令给人看的几行，而不是写给模型的结果文本", () => {
    const card = { kind: "slides", path: "/w/东京.slides.json", title: "东京", subtitle: "演示文稿 · 5 页" };
    const rows = BUILTIN_COMMANDS["slides_create"]?.detail?.({ title: "东京" }, { card });
    assert.deepEqual(rows, [
      { label: "标题", value: "东京" },
      { label: "画幅", value: "16:9 · 画布 1280×720" },
      { label: "文件", value: "/w/东京.slides.json", mono: true },
    ]);
    const four = BUILTIN_COMMANDS["slides_create"]?.detail?.({ title: "东京", aspect: "4:3" }, undefined);
    assert.equal(four?.[1]?.value, "4:3 · 画布 960×720");
    // 没有卡（坏 details）：不编文件路径
    assert.equal(four?.some((row) => row.label === "文件"), false);

    const exported = BUILTIN_COMMANDS["slides_export"]?.detail?.(
      { format: "pptx-basic" },
      { card: { kind: "export", path: "/w/东京-basic.pptx", title: "东京-basic.pptx", subtitle: "PPTX 通用字体 · 7 页" } },
    );
    assert.deepEqual(exported, [
      { label: "格式", value: "PowerPoint · 通用字体" },
      { label: "文件", value: "/w/东京-basic.pptx", mono: true },
      { label: "说明", value: "PPTX 通用字体 · 7 页" },
    ]);
    // 入参和卡都拿不到：null → 展开体退回原样结果文本
    assert.equal(BUILTIN_COMMANDS["slides_export"]?.detail?.({}, undefined), null);
    // 写 / 改没有 detail：展开体仍是通用结果文本
    assert.equal(BUILTIN_COMMANDS["slides_write"]?.detail, undefined);
    assert.deepEqual(BUILTIN_COMMANDS["doc_open"]?.detail?.({ path: "/w/a.md", create: true }, undefined), [
      { label: "文件", value: "/w/a.md", mono: true },
      { label: "方式", value: "新建空文档并在文件面板打开" },
    ]);
  });
});
