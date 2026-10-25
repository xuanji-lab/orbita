/**
 * readPptx 的账：页序（sldIdLst / rels）、版式名、标题、正文层级与项目符号、表格、
 * 备注、缺槽位、文字与页数上限、坏包 / 加密 / 截断。
 *
 * 样张在本测试里现造（JSZip 写、我们读）：比往仓里塞二进制可控——页序、rels 指向、
 * 缺件都能按需要摆。夹具按真实 OOXML 的结构写（`ppt/presentation.xml` +
 * `ppt/_rels/presentation.xml.rels` + 每页的 rels），不是简化到只对我们的解析器有效
 * 的形状。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { readPptx } from "./read.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-pptx-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** 一个形状：可选占位符类型 + 一段 a:p 序列 */
function shape(id: number, ph: string, paragraphs: string): string {
  const placeholder = ph === "" ? "" : `<p:ph type="${ph}"/>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

/** 一个段落：lvl / 项目符号 / 文字（含 `<a:br/>` 与实体） */
function para(text: string, level = 0, bullet: "char" | "none" | "auto" | "default" = "default"): string {
  const bulletXml =
    bullet === "char"
      ? "<a:buChar char=\"•\"/>"
      : bullet === "auto"
        ? '<a:buAutoNum type="arabicPeriod"/>'
        : bullet === "none"
          ? "<a:buNone/>"
          : "";
  const pPr = level === 0 && bulletXml === "" ? "" : `<a:pPr${level === 0 ? "" : ` lvl="${level}"`}>${bulletXml}</a:pPr>`;
  return `<a:p>${pPr}<a:r><a:rPr lang="zh-CN"/><a:t>${text}</a:t></a:r></a:p>`;
}

/** 一张表：rows 的每个格子一段文字 */
function table(rows: string[][]): string {
  const cells = (row: string[]): string =>
    row
      .map(
        (text) =>
          `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`,
      )
      .join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid/>${rows
    .map((row) => `<a:tr h="370840">${cells(row)}</a:tr>`)
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slide(shapes: string): string {
  return `${XML}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
}

function notesSlide(text: string, slideNumber: string): string {
  return `${XML}<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shape(
    2,
    "sldNum",
    para(slideNumber),
  )}${shape(3, "body", para(text))}</p:spTree></p:cSld></p:notes>`;
}

function layout(name: string): string {
  return `${XML}<p:sldLayout ${NS} type="titleOnly" preserve="1"><p:cSld name="${name}"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`;
}

function presentation(ids: string[]): string {
  return `${XML}<p:presentation ${NS}><p:sldIdLst>${ids
    .map((relId, index) => `<p:sldId id="${256 + index}" r:id="${relId}"/>`)
    .join("")}</p:sldIdLst></p:presentation>`;
}

function rels(entries: { id: string; type: string; target: string }[]): string {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${entry.type}" Target="${entry.target}"/>`,
    )
    .join("")}</Relationships>`;
}

const SLIDE_TYPE = "slide";
const LAYOUT_TYPE = "slideLayout";
const NOTES_TYPE = "notesSlide";

async function writeZip(path: string, files: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  zip.file("_rels/.rels", rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]));
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

/**
 * 三页样张：
 *  - 第 1 页实际是 `slide2.xml`（页序与文件名故意相反），标题 + 多级要点 + 表格 + 备注 + 图片；
 *  - 第 2 页是 `slide1.xml`，只有 ctrTitle（没有正文）；
 *  - 第 3 页 `slide3.xml`，纯文本框（没有标题占位符）。
 */
async function sampleDeck(path: string): Promise<void> {
  const first = slide(
    [
      shape(2, "title", para("季度 &amp; 回顾")),
      shape(
        3,
        "body",
        [
          para("营收增长", 0, "char"),
          para("亚太区", 1, "char"),
          para("日本市场", 2, "default"),
          para("成本持平", 0, "none"),
          `<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>第一行</a:t></a:r><a:br/><a:r><a:t>第二行</a:t></a:r></a:p>`,
        ].join(""),
      ),
      table([
        ["区域", "Q1"],
        ["华东", "120"],
      ]),
      '<p:pic><p:nvPicPr><p:cNvPr id="7" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr/></p:pic>',
    ].join(""),
  );
  const second = slide(shape(2, "ctrTitle", para("封面")));
  const third = slide(shape(2, "", para("纯文本框里的字")));

  await writeZip(path, {
    "ppt/presentation.xml": presentation(["rId2", "rId3", "rId4"]),
    "ppt/_rels/presentation.xml.rels": rels([
      { id: "rId2", type: SLIDE_TYPE, target: "slides/slide2.xml" },
      { id: "rId3", type: SLIDE_TYPE, target: "slides/slide1.xml" },
      { id: "rId4", type: SLIDE_TYPE, target: "slides/slide3.xml" },
    ]),
    "ppt/slides/slide2.xml": first,
    "ppt/slides/_rels/slide2.xml.rels": rels([
      { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: NOTES_TYPE, target: "../notesSlides/notesSlide1.xml" },
    ]),
    "ppt/slideLayouts/slideLayout1.xml": layout("标题和内容"),
    "ppt/notesSlides/notesSlide1.xml": notesSlide("讲给听众听的话", "1"),
    "ppt/slides/slide1.xml": second,
    "ppt/slides/_rels/slide1.xml.rels": rels([
      { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/slideLayout1.xml" },
    ]),
    "ppt/slides/slide3.xml": third,
  });
}

describe("readPptx", () => {
  test("页序：按 sldIdLst 而不是文件名，版式名经 rels 找到", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path);
    assert.equal(result.kind, "deck");
    assert.ok(result.kind === "deck");
    assert.equal(result.slideCount, 3);
    assert.equal(result.truncated, false);
    // slide2.xml 是第 1 页——按文件名排会得到「封面」在前，那是错的
    assert.equal(result.slides[0]?.title, "季度 & 回顾");
    assert.equal(result.slides[1]?.title, "封面");
    assert.equal(result.slides[0]?.number, 1);
    assert.equal(result.slides[0]?.layoutName, "标题和内容");
    assert.equal(result.size > 0, true);
    assert.equal(typeof result.modifiedAt, "number");
  });

  test("正文：层级 / 显式符号 / a:buNone / 换行", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    const body = result.slides[0]?.body ?? [];
    assert.deepEqual(
      body.map((paragraph) => [paragraph.level, paragraph.text, paragraph.bullet]),
      [
        [0, "营收增长", true],
        [1, "亚太区", true],
        [2, "日本市场", true], // 正文占位符的缺省符号
        [0, "成本持平", false], // 显式 a:buNone
        [0, "第一行\n第二行", true], // a:br 落成换行
      ],
    );
  });

  test("表格：行列与单元格文字", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    assert.deepEqual(result.slides[0]?.tables, [
      {
        rows: [
          ["区域", "Q1"],
          ["华东", "120"],
        ],
      },
    ]);
  });

  test("备注：读 notesSlide 的正文，页码占位符不算", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    assert.equal(result.slides[0]?.notes, "讲给听众听的话");
    // 第 2 页没有 notesSlide 关系：备注为空，不当作故障
    assert.equal(result.slides[1]?.notes, "");
  });

  test("图片页：只报数量", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    assert.equal(result.slides[0]?.pictureCount, 1);
    assert.equal(result.slides[1]?.pictureCount, 0);
  });

  test("缺槽位：没有标题占位符时标题为空；纯文本框仍是正文", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    const third = result.slides[2];
    assert.equal(third?.title, "");
    assert.equal(third?.layoutName, ""); // 没有 slide rels
    assert.deepEqual(
      third?.body.map((paragraph) => paragraph.text),
      ["纯文本框里的字"],
    );
    // 纯文本框缺省不带点
    assert.equal(third?.body[0]?.bullet, false);
  });

  test("单页文字上限：超出部分截断并标记", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path, { textLimit: 6 });
    assert.ok(result.kind === "deck");
    const first = result.slides[0];
    assert.equal(first?.truncated, true);
    // 标题「季度 & 回顾」先花掉 6 个字
    assert.equal(first?.title, "季度 & 回");
    assert.deepEqual(first?.body, []);
    assert.equal(first?.notes, "");
  });

  test("页数上限：只解析前 N 页，slideCount 仍是真实页数", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path, { maxSlides: 2 });
    assert.ok(result.kind === "deck");
    assert.equal(result.slides.length, 2);
    assert.equal(result.slideCount, 3);
    assert.equal(result.truncated, true);
  });

  test("空演示文稿：sldIdLst 为空是合法状态，回 0 页", async () => {
    const path = join(dir, "empty.pptx");
    await writeZip(path, {
      "ppt/presentation.xml": presentation([]),
      "ppt/_rels/presentation.xml.rels": rels([]),
    });
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    assert.deepEqual(result.slides, []);
    assert.equal(result.slideCount, 0);
  });

  test("缺 rels：presentation.xml.rels 不在 → unreadable / corrupt，说清缺哪个部件", async () => {
    const path = join(dir, "no-rels.pptx");
    await writeZip(path, { "ppt/presentation.xml": presentation(["rId2"]) });
    const result = await readPptx(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "corrupt");
    assert.match(result.detail, /presentation\.xml\.rels/);
  });

  test("缺页部件：rels 指向的 slide 不在包里 → unreadable / corrupt", async () => {
    const path = join(dir, "no-slide.pptx");
    await writeZip(path, {
      "ppt/presentation.xml": presentation(["rId2"]),
      "ppt/_rels/presentation.xml.rels": rels([
        { id: "rId2", type: SLIDE_TYPE, target: "slides/slide1.xml" },
      ]),
    });
    const result = await readPptx(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "corrupt");
    assert.match(result.detail, /slide1\.xml/);
  });

  test("正文占位符省略 type（继承版式）：仍按正文默认带符号", async () => {
    const path = join(dir, "idx.pptx");
    // 真实幻灯片里 python-pptx / PowerPoint 常写 `<p:ph idx="1"/>`，type 由版式继承
    const body =
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>继承来的正文</a:t></a:r></a:p></p:txBody></p:sp>';
    await writeZip(path, {
      "ppt/presentation.xml": presentation(["rId2"]),
      "ppt/_rels/presentation.xml.rels": rels([
        { id: "rId2", type: SLIDE_TYPE, target: "slides/slide1.xml" },
      ]),
      "ppt/slides/slide1.xml": slide(shape(2, "title", para("T")) + body),
    });
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    assert.deepEqual(
      result.slides[0]?.body.map((paragraph) => [paragraph.text, paragraph.bullet]),
      [["继承来的正文", true]],
    );
  });

  test("占位符 type 从版式继承：subTitle 不带默认点，obj 带", async () => {
    const path = join(dir, "inherit.pptx");
    const subtitle =
      '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Subtitle 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>副标题</a:t></a:r></a:p></p:txBody></p:sp>';
    const content =
      '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Content 3"/><p:cNvSpPr/><p:nvPr><p:ph idx="2"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>正文</a:t></a:r></a:p></p:txBody></p:sp>';
    const layoutWithSlots = `${XML}<p:sldLayout ${NS} type="title"><p:cSld name="Title Slide"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shape(
      2,
      "title",
      "",
    )}<p:sp><p:nvSpPr><p:cNvPr id="9" name="Sub"/><p:cNvSpPr/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="10" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph type="obj" idx="2"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`;
    await writeZip(path, {
      "ppt/presentation.xml": presentation(["rId2"]),
      "ppt/_rels/presentation.xml.rels": rels([
        { id: "rId2", type: SLIDE_TYPE, target: "slides/slide1.xml" },
      ]),
      "ppt/slides/slide1.xml": slide(shape(2, "title", para("T")) + subtitle + content),
      "ppt/slides/_rels/slide1.xml.rels": rels([
        { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/slideLayout1.xml" },
      ]),
      "ppt/slideLayouts/slideLayout1.xml": layoutWithSlots,
    });
    const result = await readPptx(path);
    assert.ok(result.kind === "deck");
    assert.deepEqual(
      result.slides[0]?.body.map((paragraph) => [paragraph.text, paragraph.bullet]),
      [
        ["副标题", false],
        ["正文", true],
      ],
    );
    assert.equal(result.slides[0]?.layoutName, "Title Slide");
  });

  test("太大：不读内容，回 too-large 与上限", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const result = await readPptx(path, { limit: 8 });
    assert.equal(result.kind, "too-large");
    assert.ok(result.kind === "too-large");
    assert.equal(result.limit, 8);
    assert.equal(result.size > 8, true);
  });

  test("截断字节：zip 头对但内容不完整 → unreadable / corrupt", async () => {
    const path = join(dir, "deck.pptx");
    await sampleDeck(path);
    const full = await readFile(path);
    const truncated = join(dir, "truncated.pptx");
    await writeFile(truncated, full.subarray(0, 120));
    const result = await readPptx(truncated);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "corrupt");
    assert.equal(result.detail.length > 0, true);
  });

  test("不是 zip：纯文本改名成 .pptx → unreadable / corrupt", async () => {
    const path = join(dir, "text.pptx");
    await writeFile(path, "this is not a presentation", "utf8");
    const result = await readPptx(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "corrupt");
  });

  test("加密 / 旧格式：OLE2 容器 → unreadable / password", async () => {
    const path = join(dir, "locked.pptx");
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const result = await readPptx(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "password");
  });

  test("目录不是文件：抛错（调用方的错，不是文件的错）", async () => {
    await assert.rejects(readPptx(dir), /Not a file/);
  });
});
