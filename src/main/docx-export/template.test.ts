/**
 * 模板体检：好用 / 有告警 / 不可用三种结论，以及宏、缺页眉、缺样式这些分支。
 * 夹具是手工拼的最小 docx（jszip），不依赖真实 Word 文件。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { DOCX_TEMPLATE_MAX_BYTES, inspectDocxTemplate } from "./template.ts";

async function zipOf(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return zip.generateAsync({ type: "uint8array" });
}

const documentXml = `<w:document xmlns:w="w" xmlns:m="m"><w:body>
  <w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440"/></w:sectPr></w:pPr></w:p>
  <w:p><w:r><w:t>正文</w:t></w:r></w:p>
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440"/></w:sectPr>
</w:body></w:document>`;

const stylesXml = `<w:styles xmlns:w="w">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="宋体"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

function findingsOf(report: Awaited<ReturnType<typeof inspectDocxTemplate>>, label: RegExp): boolean {
  return report.findings.some((finding) => label.test(`${finding.label} ${finding.detail ?? ""}`));
}

describe("模板体检", () => {
  test("结构完整、页眉页脚与编号都在 → ok（无 warn）", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": documentXml,
      "word/styles.xml": stylesXml,
      "word/settings.xml": "<w:settings/>",
      "word/numbering.xml": "<w:numbering><w:abstractNum w:abstractNumId=\"0\"/></w:numbering>",
      "word/header1.xml": "<w:hdr/>",
      "word/footer1.xml": "<w:ftr/>",
    });
    const report = await inspectDocxTemplate(bytes, { requested: "custom", path: "C:\\x.docx" });
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "ok");
    assert.equal(report.path, "C:\\x.docx");
    assert.match(report.summary, /ready/);
    assert.ok(findingsOf(report, /3 paragraph/));
    assert.ok(findingsOf(report, /2 heading levels/));
    assert.ok(findingsOf(report, /1 header\(s\), 1 footer\(s\)/));
    assert.ok(findingsOf(report, /No VBA macros/));
  });

  test("有宏 → ok:true + warning（不硬失败）", async () => {
    const bytes = await zipOf({
      "word/document.xml": documentXml,
      "word/styles.xml": stylesXml,
      "word/header1.xml": "<w:hdr/>",
      "word/vbaProject.bin": new Uint8Array([1, 2, 3]),
    });
    const report = await inspectDocxTemplate(bytes, { requested: "custom", path: "C:\\x.docx" });
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "warning");
    assert.ok(findingsOf(report, /VBA macros/));
    assert.match(report.summary, /warning/);
  });

  test("缺 styles / 页眉页脚 → 各一条 warning，但仍然能当 reference-doc", async () => {
    const bytes = await zipOf({ "word/document.xml": documentXml });
    const report = await inspectDocxTemplate(bytes, { requested: "project", path: "p.docx" });
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "warning");
    assert.ok(findingsOf(report, /No word\/styles.xml/));
    assert.ok(findingsOf(report, /No headers or footers/));
    assert.ok(findingsOf(report, /No numbering.xml/));
  });

  test("没有标题样式 → 提示目录与公式编号会退", async () => {
    const bytes = await zipOf({
      "word/document.xml": documentXml,
      "word/styles.xml": `<w:styles><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>`,
      "word/header1.xml": "<w:hdr/>",
    });
    const report = await inspectDocxTemplate(bytes, { requested: "custom", path: "x.docx" });
    assert.ok(findingsOf(report, /No built-in heading styles/));
  });

  test("已有目录域 → 报告里认出来", async () => {
    const withToc = documentXml.replace(
      "<w:p><w:r><w:t>正文</w:t></w:r></w:p>",
      '<w:p><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h </w:instrText></w:r></w:p>',
    );
    const bytes = await zipOf({
      "word/document.xml": withToc,
      "word/styles.xml": stylesXml,
      "word/header1.xml": "<w:hdr/>",
    });
    const report = await inspectDocxTemplate(bytes, { requested: "custom", path: "x.docx" });
    assert.ok(findingsOf(report, /Existing table of contents/));
  });

  test("OLE2（加密包）→ unusable，给的是人话", async () => {
    const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]);
    const report = await inspectDocxTemplate(ole2, { requested: "custom", path: "x.docx" });
    assert.equal(report.ok, false);
    assert.equal(report.verdict, "unusable");
    assert.match(report.summary, /password-protected/);
    assert.equal(report.findings.length, 1);
  });

  test("不是 zip / 缺 document.xml / 空文件 → unusable", async () => {
    const notZip = await inspectDocxTemplate(new TextEncoder().encode("hello"), { requested: "custom" });
    assert.equal(notZip.verdict, "unusable");
    assert.match(notZip.summary, /not a \.docx package/);

    const empty = await inspectDocxTemplate(new Uint8Array(), { requested: "custom" });
    assert.equal(empty.verdict, "unusable");

    const noBody = await zipOf({ "word/styles.xml": stylesXml });
    const report = await inspectDocxTemplate(noBody, { requested: "custom" });
    assert.equal(report.verdict, "unusable");
    assert.match(report.summary, /no word\/document\.xml/);
  });

  test("超过体积上限 → unusable（不把论文本体当模板读进内存）", async () => {
    const huge = new Uint8Array(DOCX_TEMPLATE_MAX_BYTES + 1);
    huge[0] = 0x50;
    huge[1] = 0x4b;
    const report = await inspectDocxTemplate(huge, { requested: "custom" });
    assert.equal(report.verdict, "unusable");
    assert.match(report.summary, /larger than/);
  });

  test("requested/path 原样回显（设置页据此说「哪一份」）", async () => {
    const bytes = await zipOf({ "word/document.xml": documentXml });
    const report = await inspectDocxTemplate(bytes, { requested: "default", path: null });
    assert.equal(report.requested, "default");
    assert.equal(report.path, null);
  });
});
