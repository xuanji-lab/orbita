import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import mammoth from "mammoth";
import { markdownToDocx, sniffImage } from "./export-docx.ts";

const SAMPLE = [
  "# Q4 计划",
  "",
  "## 目标",
  "",
  "把单 agent 立住：**性能优化收尾**、内核迁到 `pi-durable`。",
  "第二行是软换行",
  "",
  "- 一项",
  "  - 嵌套一项",
  "- 又一项",
  "",
  "1. 第一步",
  "2. 第二步",
  "",
  "> 引用一句",
  "",
  "---",
  "",
  "```ts",
  "const a = 1;",
  "",
  "  indented();",
  "```",
  "",
  "结尾段，含 [链接](https://example.com) 和 *斜体*。",
].join("\n");

/** 1×1 的红色 PNG */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return await zip.file("word/document.xml")!.async("string");
}

async function paragraphsOf(buffer: Buffer): Promise<string[]> {
  const xml = await documentXml(buffer);
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) =>
    [...(match[0] as string).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
  );
}

describe("markdown → docx", () => {
  it("段落数与文字与原文一致（链接是真超链接，文字不带网址）", async () => {
    const paragraphs = await paragraphsOf(await markdownToDocx(SAMPLE));
    assert.deepEqual(paragraphs, [
      "Q4 计划",
      "目标",
      "把单 agent 立住：性能优化收尾、内核迁到 pi-durable。第二行是软换行",
      "一项",
      "嵌套一项",
      "又一项",
      "第一步",
      "第二步",
      "引用一句",
      "",
      "const a = 1;",
      "",
      "  indented();",
      "结尾段，含 链接 和 斜体。",
    ]);
    assert.match(await documentXml(await markdownToDocx(SAMPLE)), /<w:hyperlink /);
  });

  it("用 mammoth（真实的 Word 读取器）读回：标题层级、加粗、列表、文字都在", async () => {
    const result = await mammoth.convertToHtml({ buffer: await markdownToDocx(SAMPLE) });
    assert.match(result.value, /<h1>Q4 计划<\/h1>/);
    assert.match(result.value, /<h2>目标<\/h2>/);
    assert.match(result.value, /<strong>性能优化收尾<\/strong>/);
    assert.match(result.value, /<ul><li>一项/);
    assert.match(result.value, /<ol><li>第一步/);
    assert.deepEqual(result.messages.filter((m) => m.type === "error"), []);
  });

  it("回车分段（\\n\\n）= 多个 Word 段落；Shift+回车的硬换行留在段内、行尾空格不进文字", async () => {
    const md = "# 标题\n\n第一段\n\n第二段第一行  \n第二段第二行";
    const paragraphs = await paragraphsOf(await markdownToDocx(md));
    assert.deepEqual(paragraphs, ["标题", "第一段", "第二段第一行第二段第二行"]);
    const html = (await mammoth.convertToHtml({ buffer: await markdownToDocx(md) })).value;
    assert.match(html, /<h1>标题<\/h1>/);
    assert.match(html, /<p>第二段第一行<br \/>第二段第二行<\/p>/);
  });

  it("空文档也能导出成合法的 docx（一个空段落）", async () => {
    const result = await mammoth.extractRawText({ buffer: await markdownToDocx("") });
    assert.equal(result.value.trim(), "");
    assert.deepEqual(result.messages, []);
  });

  it("围栏里的 # 不是标题；snake_case 不吃成斜体；没收尾的 ** 原样保留", async () => {
    assert.deepEqual(await paragraphsOf(await markdownToDocx("```\n# 不是标题\n```")), ["# 不是标题"]);
    assert.deepEqual(await paragraphsOf(await markdownToDocx("用 foo_bar_baz 和 **没收尾")), ["用 foo_bar_baz 和 **没收尾"]);
  });

  it("5 万字的文档导出不卡（< 2 秒）", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `第 ${i} 段：${"这是一段用来量体量的中文。".repeat(2)}`).join("\n\n");
    const started = Date.now();
    const buffer = await markdownToDocx(big);
    assert.ok(Date.now() - started < 2000, `耗时 ${Date.now() - started}ms`);
    assert.equal((await paragraphsOf(buffer)).length, 2000);
  });
});

describe("OFM → docx", () => {
  const OFM = [
    "---",
    "tags: [周报, orbita]",
    "date: 2026-11-07",
    "---",
    "",
    "# 周报",
    "",
    "详见 [[设计系统迭代记录]] 与 [[页|别名]]，==900== 个 #标签。",
    "",
    "![[pipeline.png|300]]",
    "",
    "![alt](rel/a.png)",
    "",
    "![[找不到.png]]",
    "",
    "> [!warning] 风险",
    "> Windows 端没验收",
    "",
    "> [!tip]-",
    "> 折叠的内容",
    "",
    "| 列 A | 列 B |",
    "| --- | ---: |",
    "| 1 | 2 |",
    "",
    "- [x] 做完",
    "- [ ] 没做",
    "",
    "```",
    "[[不转]] ==不转==",
    "```",
  ].join("\n");

  it("双链→纯文字、高亮→底色、提醒框→带标题的色条引用块、表格、属性表、任务列表", async () => {
    const buffer = await markdownToDocx(OFM, {
      loadImage: async (target) => (target === "pipeline.png" || target === "rel/a.png" ? PNG_1x1 : null),
    });
    const xml = await documentXml(buffer);
    const paragraphs = await paragraphsOf(buffer);
    assert.ok(paragraphs.includes("详见 设计系统迭代记录 与 别名，900 个 #标签。"), paragraphs.join("|"));
    // 代码块里的 [[不转]] 留着，正文里的双链与提醒框标记都不见了
    assert.equal(xml.includes("[[设计") || xml.includes("[[页"), false);
    assert.equal(xml.includes("[!"), false);
    // 高亮底色（只有「900」一处）
    assert.equal((xml.match(/w:fill="FFF3A3"/g) ?? []).length, 1);
    // 提醒框：粗体标题 + 内容，色条（左边框）与底色
    assert.ok(paragraphs.includes("风险") && paragraphs.includes("Windows 端没验收"));
    assert.ok(paragraphs.includes("Tip") && paragraphs.includes("折叠的内容"));
    assert.match(xml, /w:fill="FCF1E3"/);
    // 两张图（嵌入 + 标准语法）进了文件；找不到的写方括号图名
    assert.equal((xml.match(/<w:drawing>/g) ?? []).length, 2);
    assert.ok(paragraphs.includes("[找不到.png]"));
    // 表格：属性表 + 数据表
    assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 2);
    assert.ok(paragraphs.includes("#周报") || paragraphs.some((p) => p.includes("#周报")));
    assert.ok(paragraphs.includes("列 A") && paragraphs.includes("2"));
    assert.ok(xml.includes('w:jc w:val="right"'));
    // 任务列表与围栏代码
    assert.ok(paragraphs.includes("☑ 做完") && paragraphs.includes("☐ 没做"));
    assert.ok(paragraphs.includes("[[不转]] ==不转=="));
    // mammoth 读得动（图片、表格、没有错误）
    const html = await mammoth.convertToHtml({ buffer });
    assert.match(html.value, /<table>/);
    assert.match(html.value, /<img /);
    assert.deepEqual(html.messages.filter((m) => m.type === "error"), []);
  });

  it("有序列表各自从 1 重新编号（两个列表两个 numbering 实例）", async () => {
    const xml = await documentXml(await markdownToDocx("1. 甲\n2. 乙\n\n中间\n\n1. 丙\n2. 丁"));
    const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, 2);
  });

  it("没给 loadImage / 读图抛错：不整份失败，写方括号图名", async () => {
    const none = await paragraphsOf(await markdownToDocx("![[a.png]]"));
    assert.deepEqual(none, ["[a.png]"]);
    const boom = await paragraphsOf(
      await markdownToDocx("![x](a.png)", {
        loadImage: async () => {
          throw new Error("读不了");
        },
      }),
    );
    assert.deepEqual(boom, ["[x]"]);
  });
});

describe("图片文件头", () => {
  it("PNG / GIF / JPEG 读出格式与尺寸；webp / 垃圾认不出", () => {
    assert.deepEqual(sniffImage(PNG_1x1), { type: "png", width: 1, height: 1 });
    const gif = Buffer.from("474946383961" + "0300" + "0200" + "00000000", "hex");
    assert.deepEqual(sniffImage(gif), { type: "gif", width: 3, height: 2 });
    // SOI + APP0(16 字节) + SOF0：高 20、宽 30
    const jpg = Buffer.from("ffd8" + "ffe0" + "0010" + "4a46494600010100000100010000" + "ffc0" + "0011" + "08" + "0014" + "001e" + "03" + "0000000000", "hex");
    assert.deepEqual(sniffImage(jpg), { type: "jpg", width: 30, height: 20 });
    assert.equal(sniffImage(Buffer.from("RIFFxxxxWEBPVP8 ")), null);
    assert.equal(sniffImage(Buffer.alloc(3)), null);
  });
});
