import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_COMMANDS, builtinCommand, builtinLabel, fileLabel, toolWord, pagesLabel, PINNED_CARD_COMMANDS } from "./builtin-commands.ts";
import { toolCallSummary, groupToolUnits, type ToolCallUnit } from "./tool-results.ts";
import { zh } from "../../messages-zh.ts";
import { en } from "../../messages-en.ts";

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

describe("Zotero 三条内置命令", () => {
  const searchDetails = {
    zotero: {
      op: "search",
      total: 57,
      offset: 0,
      collection: "博士论文 / 第二章",
      items: [
        { key: "ATTN2345", title: "Attention Is All You Need", creators: "Vaswani et al.", year: "2017" },
        { key: "BKJJ2222", title: "The Death and Life of Great American Cities", creators: "Jacobs", year: null },
      ],
    },
  };

  it("中文名 + 英文名 + 同一枚功能图标；不出完成卡", () => {
    assert.deepEqual(
      ["zotero_search", "zotero_item", "zotero_fulltext"].map((id) => [builtinCommand(id)?.label, builtinCommand(id)?.labelEn, builtinCommand(id)?.icon]),
      [
        ["查文献", "Search library", "library-big"],
        ["读文献条目", "Read library item", "library-big"],
        ["读文献全文", "Read full text", "library-big"],
      ],
    );
    for (const id of ["zotero_search", "zotero_item", "zotero_fulltext"]) assert.equal(PINNED_CARD_COMMANDS.has(id), false);
    const item = builtinCommand("zotero_item");
    assert.ok(item !== null);
    assert.equal(builtinLabel(item, "en"), "Read library item");
    assert.equal(builtinLabel(item, "zh"), "读文献条目");
    // 没给英文名的老命令：英文界面照旧显示中文名
    const doc = builtinCommand("doc_open");
    assert.ok(doc !== null);
    assert.equal(builtinLabel(doc, "en"), "打开文档");
  });

  it("参数摘要：查询词 · 分类 · 类型 · 标签；读条目是 key；续读带起始字符", () => {
    assert.equal(toolCallSummary("zotero_search", { query: "attention", collection: "第二章", item_type: "book" }), "attention · 第二章 · book");
    assert.equal(toolCallSummary("zotero_search", {}), null);
    assert.equal(toolCallSummary("zotero_item", { key: "ATTN2345" }), "ATTN2345");
    assert.equal(toolCallSummary("zotero_fulltext", { key: "ATTN2345" }), "ATTN2345");
    assert.equal(toolCallSummary("zotero_fulltext", { key: "ATTN2345", start: 20000 }), "ATTN2345 · @20,000");
  });

  it("查文献展开体：结果总数与范围、每条 key → 标题 · 作者 · 年份（中 / 英）", () => {
    const detail = builtinCommand("zotero_search")?.detail;
    assert.ok(detail !== undefined);
    assert.deepEqual(detail({ query: "attention" }, searchDetails, "zh"), [
      { label: "查询", value: "attention" },
      { label: "分类", value: "博士论文 / 第二章" },
      { label: "结果", value: "共 57 条，显示第 1–2 条" },
      {
        label: "ATTN2345",
        value: "Attention Is All You Need · Vaswani et al. · 2017",
        item: { title: "Attention Is All You Need", meta: "Vaswani et al. · 2017", key: "ATTN2345" },
      },
      {
        label: "BKJJ2222",
        value: "The Death and Life of Great American Cities · Jacobs",
        item: { title: "The Death and Life of Great American Cities", meta: "Jacobs", key: "BKJJ2222" },
      },
    ]);
    assert.deepEqual(detail({ query: "attention" }, searchDetails, "en")?.slice(0, 3), [
      { label: "Query", value: "attention" },
      { label: "Collection", value: "博士论文 / 第二章" },
      { label: "Results", value: "57 total, showing 1–2" },
    ]);
    assert.equal(detail({}, { zotero: { op: "search" } }, "zh"), null);
  });

  it("读条目 / 读全文展开体：附件路径（不在本机标出来）、批注范围、全文区间或「没有全文索引」", () => {
    const item = builtinCommand("zotero_item")?.detail;
    assert.ok(item !== undefined);
    const details = {
      zotero: {
        op: "item",
        key: "ATTN2345",
        title: "Attention Is All You Need",
        attachments: [
          { name: "a.pdf", path: "/z/storage/PDFA2222/a.pdf", onDisk: true },
          { name: "b.pdf", path: "/z/b.pdf", onDisk: false },
        ],
        annotationTotal: 35,
        annotationOffset: 30,
        annotationShown: 5,
      },
    };
    assert.deepEqual(item({}, details, "zh"), [
      { label: "条目", value: "Attention Is All You Need · ATTN2345" },
      { label: "附件", value: "/z/storage/PDFA2222/a.pdf", mono: true },
      { label: "附件 2", value: "/z/b.pdf（不在本机）", mono: true },
      { label: "批注", value: "第 31–35 条，共 35 条" },
    ]);
    assert.equal(item({}, details, "en")?.at(-1)?.value, "31–35 of 35");
    const fulltext = builtinCommand("zotero_fulltext")?.detail;
    assert.ok(fulltext !== undefined);
    assert.deepEqual(fulltext({}, { zotero: { op: "fulltext", title: "T", range: { start: 0, end: 20000, total: 123456 }, path: "/z/a.pdf" } }, "zh"), [
      { label: "条目", value: "T" },
      { label: "范围", value: "第 0–20,000 字，共 123,456 字" },
      { label: "PDF", value: "/z/a.pdf", mono: true },
    ]);
    assert.equal(fulltext({}, { zotero: { op: "fulltext", title: "T", range: null, path: null } }, "en")?.[1]?.value, "Zotero has no full-text index for this item");
  });
});

describe("统计行 / 章节小标签的工具词（toolWord）随界面语言", () => {
  it("Zotero 三条：中文表给中文名、英文表给英文名；没有英文名的老命令照旧中文；普通工具走表", () => {
    assert.equal(toolWord(zh.chat.rollupTool, "zotero_item"), "读文献条目");
    assert.equal(toolWord(en.chat.rollupTool, "zotero_item"), "Read library item");
    assert.equal(toolWord(en.chat.rollupTool, "zotero_search"), "Search library");
    assert.equal(toolWord(en.chat.rollupTool, "doc_open"), "打开文档");
    assert.equal(toolWord(en.chat.rollupTool, "bash"), "bash");
    assert.equal(toolWord(zh.chat.rollupTool, "read"), "读取");
  });
});
