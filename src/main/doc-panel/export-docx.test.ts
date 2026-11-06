import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import mammoth from "mammoth";
import { expectedParagraphCount, markdownToDocx, parseBlocks } from "./export-docx.ts";

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

async function paragraphsOf(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) =>
    [...(match[0] as string).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
  );
}

describe("markdown → docx", () => {
  it("D1：用 docx 解析读回，段落数与文字一致", async () => {
    const buffer = await markdownToDocx(SAMPLE);
    const paragraphs = await paragraphsOf(buffer);
    assert.equal(paragraphs.length, expectedParagraphCount(SAMPLE));
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
      "结尾段，含 链接 (https://example.com) 和 斜体。",
    ]);
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

  it("回车分段（\\n\\n）= 多个 Word 段落；Shift+回车的硬换行留在段内、行尾空格不进文字（M2）", async () => {
    const md = "# 标题\n\n第一段\n\n第二段第一行  \n第二段第二行";
    const paragraphs = await paragraphsOf(await markdownToDocx(md));
    assert.equal(paragraphs.length, expectedParagraphCount(md));
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

  it("块解析：围栏里的 # 不是标题；snake_case 不吃成斜体；没收尾的 ** 原样保留", async () => {
    assert.deepEqual(parseBlocks("```\n# 不是标题\n```").map((b) => b.type), ["code"]);
    const paragraphs = await paragraphsOf(await markdownToDocx("用 foo_bar_baz 和 **没收尾"));
    assert.deepEqual(paragraphs, ["用 foo_bar_baz 和 **没收尾"]);
  });

  it("5 万字的文档导出不卡（< 2 秒）", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `第 ${i} 段：${"这是一段用来量体量的中文。".repeat(2)}`).join("\n\n");
    const started = Date.now();
    const buffer = await markdownToDocx(big);
    assert.ok(Date.now() - started < 2000, `耗时 ${Date.now() - started}ms`);
    assert.equal((await paragraphsOf(buffer)).length, 2000);
  });
});
