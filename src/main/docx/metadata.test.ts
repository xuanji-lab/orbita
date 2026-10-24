/**
 * 作者身份的账（issue #275）：新建 / 已有的作者取舍、app.xml 的工具名、修订与批注的
 * `w:author`、以及「只改被点名的条目」这条字节纪律。夹具用 jszip 现造，验证用 jszip
 * 与自带的读入口——真机的 `unzip -t` 与 Word 打开放在验收里做。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { stampDocxAuthor, systemUserName } from "./metadata.ts";
import { readZipEntryText } from "./zip.ts";

const NOW = Date.UTC(2026, 9, 24, 15, 32, 0);

const CORE = (creator: string, created = "2026-10-22T15:59:25Z"): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
  ` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"` +
  ` xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  `<dc:title>论文</dc:title><dc:creator>${creator}</dc:creator>` +
  `<cp:lastModifiedBy>${creator}</cp:lastModifiedBy>` +
  `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
  `<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-22T15:59:25Z</dcterms:modified>` +
  `</cp:coreProperties>`;

const APP =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"` +
  ` xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
  `<Words>83</Words><Application>stella</Application><Company>python-docx</Company>` +
  `<AppVersion>16.0000</AppVersion><Template>Normal.dotm</Template></Properties>`;

const DOCUMENT =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
  `<w:p><w:ins w:id="1" w:author="pandoc" w:date="2026-10-22T15:59:25Z"><w:r><w:t>改</w:t></w:r></w:ins></w:p>` +
  `<w:p><w:ins w:id="2" w:author="张三" w:date="2026-10-22T15:59:25Z"><w:r><w:t>别人写的</w:t></w:r></w:ins></w:p>` +
  `</w:body></w:document>`;

async function zipOf(parts: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

async function plainZipOf(parts: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "STORE" }));
}

function text(bytes: Uint8Array, name: string): string {
  const value = readZipEntryText(bytes, name);
  assert.ok(value !== null, `包内缺少 ${name}`);
  return value;
}

describe("stampDocxAuthor / core.xml", () => {
  test("新建文件（creator 空）：creator 与 lastModifiedBy 是用户名", async () => {
    const bytes = await zipOf({ "docProps/core.xml": CORE(""), "word/document.xml": DOCUMENT });
    const out = stampDocxAuthor(bytes, { name: "李四", now: NOW });
    const core = text(out, "docProps/core.xml");
    assert.match(core, /<dc:creator>李四<\/dc:creator>/);
    assert.match(core, /<cp:lastModifiedBy>李四<\/cp:lastModifiedBy>/);
    // created 是原文档的事实，保持；modified 是这次保存的时间
    assert.match(core, /<dcterms:created[^>]*>2026-10-22T15:59:25Z<\/dcterms:created>/);
    assert.match(core, /<dcterms:modified[^>]*>2026-10-24T15:32:00Z<\/dcterms:modified>/);
  });

  test("引擎写死 Stella：换成用户名", async () => {
    const bytes = await zipOf({ "docProps/core.xml": CORE("Stella"), "word/document.xml": DOCUMENT });
    const core = text(stampDocxAuthor(bytes, { name: "李四", now: NOW }), "docProps/core.xml");
    assert.match(core, /<dc:creator>李四<\/dc:creator>/);
    assert.doesNotMatch(core, /stella/i);
  });

  test("已有作者是别人：creator 保持原值，lastModifiedBy 是本次保存人", async () => {
    const bytes = await zipOf({ "docProps/core.xml": CORE("张三"), "word/document.xml": DOCUMENT });
    const core = text(stampDocxAuthor(bytes, { name: "李四", now: NOW }), "docProps/core.xml");
    assert.match(core, /<dc:creator>张三<\/dc:creator>/);
    assert.match(core, /<cp:lastModifiedBy>李四<\/cp:lastModifiedBy>/);
  });

  test("序列化丢了作者：从磁盘上一版的 core.xml 继承", async () => {
    const previous = await zipOf({ "docProps/core.xml": CORE("张三") });
    const bytes = await zipOf({ "docProps/core.xml": CORE(""), "word/document.xml": DOCUMENT });
    const core = text(stampDocxAuthor(bytes, { name: "李四", now: NOW, previous }), "docProps/core.xml");
    assert.match(core, /<dc:creator>张三<\/dc:creator>/);
  });

  test("序列化把作者写成了工具名、磁盘上是别人：仍以磁盘原作者为准", async () => {
    const previous = await zipOf({ "docProps/core.xml": CORE("张三") });
    const bytes = await zipOf({ "docProps/core.xml": CORE("pandoc") });
    const core = text(stampDocxAuthor(bytes, { name: "李四", now: NOW, previous }), "docProps/core.xml");
    assert.match(core, /<dc:creator>张三<\/dc:creator>/);
  });

  test("自闭合的 <dc:creator/> 也能写进去", async () => {
    const core = CORE("").replace("<dc:creator></dc:creator>", "<dc:creator/>");
    const out = stampDocxAuthor(await zipOf({ "docProps/core.xml": core }), { name: "李四", now: NOW });
    assert.match(text(out, "docProps/core.xml"), /<dc:creator>李四<\/dc:creator>/);
  });

  test("作者名带 & 与 < 时转义，XML 不被破坏", async () => {
    const out = stampDocxAuthor(await zipOf({ "docProps/core.xml": CORE("") }), {
      name: "A&B <研究组>",
      now: NOW,
    });
    assert.match(text(out, "docProps/core.xml"), /<dc:creator>A&amp;B &lt;研究组&gt;<\/dc:creator>/);
  });

  test("名字取不到（空串）：不编名字，作者字段保持原样", async () => {
    const out = stampDocxAuthor(await zipOf({ "docProps/core.xml": CORE("") }), { name: "", now: NOW });
    assert.match(text(out, "docProps/core.xml"), /<dc:creator><\/dc:creator>/);
  });

  test("同一时刻重复套用结果一致（幂等）", async () => {
    const bytes = await zipOf({ "docProps/core.xml": CORE(""), "docProps/app.xml": APP });
    const once = stampDocxAuthor(bytes, { name: "李四", now: NOW });
    const twice = stampDocxAuthor(once, { name: "李四", now: NOW });
    assert.deepEqual([...twice], [...once]);
  });
});

describe("stampDocxAuthor / app.xml 与 custom.xml", () => {
  test("app.xml 里的工具名去掉，其余字段保留", async () => {
    const out = stampDocxAuthor(await zipOf({ "docProps/app.xml": APP }), { name: "李四", now: NOW });
    const app = text(out, "docProps/app.xml");
    assert.doesNotMatch(app, /stella|python-docx/i);
    assert.match(app, /<Words>83<\/Words>/);
    assert.match(app, /<AppVersion>16.0000<\/AppVersion>/);
    assert.match(app, /<Template>Normal.dotm<\/Template>/);
  });

  test("app.xml 原本是 Word 写的：Application 留着（那不是我们的工具名）", async () => {
    const app = APP.replace("<Application>stella</Application>", "<Application>Microsoft Office Word</Application>");
    const out = stampDocxAuthor(await zipOf({ "docProps/app.xml": app }), { name: "李四", now: NOW });
    assert.match(text(out, "docProps/app.xml"), /<Application>Microsoft Office Word<\/Application>/);
  });

  test("custom.xml：写着生成器的自定义属性删掉，用户自己的属性留着", async () => {
    const custom =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties">` +
      `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Generator"><vt:lpwstr>python-docx 1.1</vt:lpwstr></property>` +
      `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="课题组"><vt:lpwstr>合同法</vt:lpwstr></property>` +
      `</Properties>`;
    const out = stampDocxAuthor(await zipOf({ "docProps/custom.xml": custom }), { name: "李四", now: NOW });
    const after = text(out, "docProps/custom.xml");
    assert.doesNotMatch(after, /Generator|python-docx/);
    assert.match(after, /课题组/);
  });
});

describe("stampDocxAuthor / 修订与批注的作者", () => {
  test("document.xml：工具名作者换成用户，别人写的修订保持署名", async () => {
    const out = stampDocxAuthor(await zipOf({ "word/document.xml": DOCUMENT }), { name: "李四", now: NOW });
    const doc = text(out, "word/document.xml");
    assert.match(doc, /w:author="李四"/);
    assert.match(doc, /w:author="张三"/);
    assert.doesNotMatch(doc, /pandoc/);
    assert.match(doc, /改/);
  });

  test("comments.xml：author 与 initials 一起改写", async () => {
    const comments =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:comment w:id="0" w:author="stella" w:initials="S" w:date="2026-10-22T15:59:25Z"><w:p><w:r><w:t>批注</w:t></w:r></w:p></w:comment>` +
      `</w:comments>`;
    const out = stampDocxAuthor(await zipOf({ "word/comments.xml": comments }), { name: "李四", now: NOW });
    const after = text(out, "word/comments.xml");
    assert.match(after, /w:author="李四"/);
    assert.match(after, /w:initials="李"/);
    assert.match(after, /批注/);
  });

  test("people.xml：空作者也补成用户", async () => {
    const people =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">` +
      `<w15:person w:author="" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" />` +
      `</w15:people>`;
    const out = stampDocxAuthor(await zipOf({ "word/people.xml": people }), { name: "李四", now: NOW });
    assert.match(text(out, "word/people.xml"), /w:author="李四"/);
  });
});

describe("stampDocxAuthor / 字节纪律", () => {
  test("没被点名的条目原样搬运（STORE 条目的字节完整出现在输出里）", async () => {
    const binary = new Uint8Array(64 * 1024);
    for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 7) % 251;
    const bytes = await plainZipOf({
      "docProps/core.xml": CORE(""),
      "word/media/image1.bin": binary,
    });
    const out = stampDocxAuthor(bytes, { name: "李四", now: NOW });
    assert.notDeepEqual([...out], [...bytes]);
    assert.ok(Buffer.from(out).includes(Buffer.from(binary)), "未改动的条目字节被重写了");
  });

  test("改过的条目仍是可读的 DEFLATE 流，其余条目内容不变", async () => {
    const bytes = await zipOf({ "docProps/core.xml": CORE("Stella"), "word/styles.xml": "<styles/>" });
    const out = stampDocxAuthor(bytes, { name: "李四", now: NOW });
    const zip = await JSZip.loadAsync(out);
    assert.equal(await zip.file("word/styles.xml")!.async("string"), "<styles/>");
    const raw = await zip.file("docProps/core.xml")!.async("nodebuffer");
    assert.match(raw.toString("utf8"), /<dc:creator>李四<\/dc:creator>/);
  });

  test("不是 zip（别处传进来的假数据）原样返回，不拦住保存", () => {
    const bytes = new TextEncoder().encode("v1");
    assert.deepEqual([...stampDocxAuthor(bytes, { name: "李四", now: NOW })], [...bytes]);
  });

  test("缺 core.xml 也能处理：app.xml 照样清洗", async () => {
    const out = stampDocxAuthor(await zipOf({ "docProps/app.xml": APP }), { name: "李四", now: NOW });
    assert.doesNotMatch(text(out, "docProps/app.xml"), /stella/i);
  });

  test("systemUserName 非空（真机账户名）", () => {
    assert.ok(systemUserName().length > 0);
  });
});
