/**
 * OOXML 后处理：三线表 / 表头下线 / 公式编号三栏表 / 封面分节 / updateFields /
 * `$...$` 守门 / 统计。全部是纯字符串 → 字符串，夹具是手写的最小 XML。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  applyCoverSection,
  applyThreeLineTables,
  bodyInner,
  countDocumentStats,
  findMathResidue,
  ensureTocStyles,
  fillTocEntries,
  insertCaptionBookmarks,
  numberEquations,
  postProcessDocx,
  pruneEmptyLists,
  setUpdateFields,
  topLevelSlices,
} from "./postprocess.ts";

const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="w" xmlns:m="m"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>论文标题</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Author"/></w:pPr><w:r><w:t>张三</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>引言</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><m:oMathPara><m:oMath><m:r><m:t>E</m:t></m:r></m:oMath></m:oMathPara></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="Table"/></w:tblPr><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>
<w:tr><w:tc><w:tcPr><w:tcW w:w="100"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>方法</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>方法</w:t></w:r></w:p>
<w:p><m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440"/></w:sectPr>
</w:body></w:document>`;

describe("顶层切片", () => {
  test("只切顶层，嵌套元素跟随父元素", () => {
    const inner = "<w:p>A</w:p><w:tbl><w:tr><w:tc><w:p>B</w:p></w:tc></w:tr></w:tbl>";
    const slices = topLevelSlices(inner);
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.text, "<w:p>A</w:p>");
    assert.match(slices[1]?.text ?? "", /^<w:tbl>/);
  });
});

describe("三线表", () => {
  test("换掉 tblBorders：顶 / 底单线，其余 none；表头行加 0.75pt 下线", () => {
    const result = applyThreeLineTables(document);
    assert.equal(result.count, 1);
    assert.match(result.xml, /<w:tblBorders><w:top w:val="single" w:sz="12"/);
    assert.match(result.xml, /<w:bottom w:val="single" w:sz="12"/);
    assert.match(result.xml, /<w:insideH w:val="none"/);
    assert.match(result.xml, /<w:tcBorders><w:bottom w:val="single" w:sz="6"/);
    // 第二行不该有表头线
    assert.equal((result.xml.match(/<w:tcBorders>/g) ?? []).length, 1);
  });

  test("幂等：再跑一次不会叠第二条线", () => {
    const once = applyThreeLineTables(document).xml;
    const twice = applyThreeLineTables(once).xml;
    assert.equal((twice.match(/<w:tblBorders>/g) ?? []).length, 1);
    assert.equal((twice.match(/<w:tcBorders>/g) ?? []).length, 1);
  });

  test("没有表格时原样返回", () => {
    const noTable = document.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, "");
    assert.deepEqual(applyThreeLineTables(noTable), { xml: noTable, count: 0 });
  });
});

describe("公式编号", () => {
  test("每条 display equation 变三栏表：空 / 公式 / 编号，章节号按 Heading1 重置", () => {
    const result = numberEquations(document);
    assert.equal(result.count, 2);
    // 两条都各有一张表，且公式段落进入中间单元格并被居中
    assert.equal((result.xml.match(/<w:tbl>/g) ?? []).length, 3); // 原表 + 两张公式表
    assert.match(result.xml, /<w:jc w:val="center"\/><\/w:pPr><m:oMathPara>/);
    assert.match(result.xml, /STYLEREF 1 \\n \\t/);
    // 每章一个独立 SEQ 名（folio 不认 \s 1）
    assert.match(result.xml, /SEQ Equation1/);
    assert.match(result.xml, /SEQ Equation2/);
    // 章号缓存：第一章的公式填 1、第二章的填 2；序号在每章重来
    const cached = [...result.xml.matchAll(/<w:r><w:t>(\d+)<\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="end"\/><\/w:r><w:r><w:t>-/g)];
    assert.deepEqual(
      cached.map((match) => match[1]),
      ["1", "2"],
    );
  });

  test("没有 Heading1 时不出 STYLEREF，只出序号（避免「错误！未找到引用源」）", () => {
    const noHeading = document.replace(/<w:pStyle w:val="Heading1"\/>/g, '<w:pStyle w:val="Heading2"/>');
    const result = numberEquations(noHeading);
    assert.equal(result.count, 2);
    assert.equal(result.xml.includes("STYLEREF"), false);
    assert.match(result.xml, /SEQ Equation/);
  });

  test("行内公式（没有 oMathPara）不动", () => {
    const inline = document.replace("<m:oMathPara><m:oMath><m:r><m:t>E</m:t></m:r></m:oMath></m:oMathPara>", "<m:oMath><m:r><m:t>E</m:t></m:r></m:oMath>");
    const result = numberEquations(inline);
    assert.equal(result.count, 1);
  });
});

describe("封面分节", () => {
  test("title block 的最后一段插 nextPage 分节，几何照抄 body sectPr，不带页眉页脚", () => {
    const result = applyCoverSection(document);
    assert.equal(result.applied, true);
    const titleParagraph = /<w:p><w:pPr><w:pStyle w:val="Author"\/>(.*?)<\/w:pPr>/s.exec(result.xml);
    assert.ok(titleParagraph !== null);
    const sect = titleParagraph[1] ?? "";
    assert.match(sect, /<w:sectPr><w:type w:val="nextPage"\/>/);
    assert.match(sect, /<w:pgSz w:w="11906" w:h="16838"\/>/);
    assert.match(sect, /<w:pgMar w:top="1440"\/>/);
    assert.doesNotMatch(sect, /headerReference/);
  });

  test("没有 title block 就不插", () => {
    const noTitle = document.replace(/<w:pStyle w:val="Title"\/>/, '<w:pStyle w:val="BodyText"/>').replace(
      /<w:pStyle w:val="Author"\/>/,
      '<w:pStyle w:val="BodyText"/>',
    );
    assert.equal(applyCoverSection(noTitle).applied, false);
  });
});

describe("updateFields", () => {
  test("缺就插在 </w:settings> 前", () => {
    const settings = '<?xml version="1.0"?><w:settings xmlns:w="w"><w:zoom w:percent="100"/></w:settings>';
    const result = setUpdateFields(settings);
    assert.equal(result.applied, true);
    assert.match(result.xml, /<w:updateFields w:val="true"\/><\/w:settings>/);
  });

  test("已有 false 改成 true；幂等", () => {
    const settings = '<w:settings><w:updateFields w:val="false"/></w:settings>';
    const once = setUpdateFields(settings);
    assert.match(once.xml, /w:val="true"/);
    const twice = setUpdateFields(once.xml);
    assert.equal(twice.xml, once.xml);
  });

  test("settings.xml 结构坏了就如实说没打开", () => {
    assert.equal(setUpdateFields("not xml").applied, false);
  });
});

describe("公式守门", () => {
  test("认出字面 $...$ 与 m:t 里的残留，去重", () => {
    const xml = "<w:p><w:r><w:t>$\\foo{bar} + x$</w:t></w:r><w:r><w:t>$\\foo{bar} + x$</w:t></w:r></w:p><m:t>$a$</m:t>";
    assert.deepEqual(findMathResidue(xml), ["$\\foo{bar} + x$", "$a$"]);
  });

  test("正常公式与普通美元符号不误报", () => {
    const ok = "<m:t>E=mc</m:t><w:t>价格是 5 美元</w:t>";
    assert.deepEqual(findMathResidue(ok), []);
  });
});

describe("统计", () => {
  test("段落 / 标题 / 表格 / 域", () => {
    const stats = countDocumentStats(document);
    assert.equal(stats.headings, 2);
    assert.equal(stats.tables, 1);
    assert.equal(stats.paragraphs > 0, true);
    assert.equal(stats.fields, 0);
  });
});

describe("整包后处理", () => {
  async function fixture(settingsXml?: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("word/document.xml", document);
    if (settingsXml !== undefined) zip.file("word/settings.xml", settingsXml);
    for (const [name, value] of Object.entries(extra)) zip.file(name, value);
    return zip.generateAsync({ type: "uint8array" });
  }

  test("只替换 document.xml / settings.xml，其它条目字节原样", async () => {
    const bytes = await fixture("<w:settings></w:settings>", { "word/header1.xml": "<w:hdr>keep me</w:hdr>" });
    const result = await postProcessDocx(bytes);
    assert.equal(result.stats.threeLineTables, 1);
    assert.equal(result.stats.numberedEquations, 2);
    assert.equal(result.stats.coverSection, true);
    assert.deepEqual(result.mathResidue, []);
    assert.deepEqual(result.warnings, []);

    const out = await JSZip.loadAsync(result.bytes);
    assert.equal(await out.file("word/header1.xml")?.async("string"), "<w:hdr>keep me</w:hdr>");
    const settings = await out.file("word/settings.xml")?.async("string");
    assert.match(settings ?? "", /updateFields/);
  });

  test("缺 settings.xml → 产物仍然正确，附一条 warning", async () => {
    const result = await postProcessDocx(await fixture(undefined));
    assert.equal(result.stats.numberedEquations, 2);
    assert.ok(result.warnings.some((warning) => /field update/.test(warning)));
  });

  test("没有 word/document.xml → 抛错（不是静默产出坏包）", async () => {
    const zip = new JSZip();
    zip.file("word/styles.xml", "<w:styles/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await assert.rejects(() => postProcessDocx(bytes), /no word\/document\.xml/);
  });
});

describe("body 解析", () => {
  test("取 body 内层", () => {
    assert.match(bodyInner(document) ?? "", /^[\s\S]*<w:sectPr>/);
  });
});

describe("目录缓存条目", () => {
  const withToc = `<w:document xmlns:w="w" xmlns:m="m"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>题目</w:t></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/><w:instrText xml:space="preserve">TOC \\o &quot;1-3&quot; \\h \\z \\u</w:instrText><w:fldChar w:fldCharType="separate"/><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/><w:instrText xml:space="preserve">TOC \\h \\z \\t &quot;Table Caption&quot; \\c</w:instrText><w:fldChar w:fldCharType="separate"/><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_引言"/><w:r><w:t>引言</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:bookmarkStart w:id="2" w:name="_背景"/><w:r><w:t>背景</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>
<w:p><w:pPr><w:pStyle w:val="TableCaption"/></w:pPr><w:r><w:t>表 1 数据</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`;

  test("空 TOC 域展开成 TOC1/TOC2 条目 + PAGEREF（缓存页码 1）", () => {
    const result = fillTocEntries(withToc);
    assert.equal(result.fields, 2);
    // 标题 2 条 + 表题注（此时还没盖书签）0 条
    assert.equal(result.entries, 2);
    assert.equal((result.xml.match(/<w:pStyle w:val="TOC1"\/>/g) ?? []).length, 1);
    assert.equal((result.xml.match(/<w:pStyle w:val="TOC2"\/>/g) ?? []).length, 1);
    assert.match(result.xml, /PAGEREF _引言 \\h/);
    assert.match(result.xml, /<w:r><w:t>1<\/w:t><\/w:r>/);
  });

  test("题注先盖书签，表目录才有条目", () => {
    const bookmarked = insertCaptionBookmarks(withToc);
    assert.equal(bookmarked.changed, 1);
    assert.match(bookmarked.xml, /<w:bookmarkStart w:id="3" w:name="_OrbitaTable1"\/>/);
    const result = fillTocEntries(bookmarked.xml);
    assert.equal(result.fields, 2);
    assert.equal(result.entries, 3);
    assert.match(result.xml, /PAGEREF _OrbitaTable1 \\h/);
    assert.match(result.xml, /表 1 数据/);
  });

  test("没有标题 / 题注时条目为空，域仍然闭合", () => {
    const bare = withToc.replace(/<w:p><w:pPr><w:pStyle w:val="Heading\d"\/>[\s\S]*?<\/w:p>/g, "");
    const result = fillTocEntries(bare);
    assert.equal(result.entries, 0);
    assert.match(result.xml, /fldCharType="end"/);
  });

  test("TOC 1–3 样式缺就补，已有的不重复", () => {
    const styles = "<w:styles></w:styles>";
    const once = ensureTocStyles(styles);
    assert.equal((once.match(/w:styleId="TOC1"/g) ?? []).length, 1);
    assert.match(once, /w:styleId="TOC3"/);
    assert.equal(ensureTocStyles(once), once);
  });
});

describe("按产物裁掉空目录", () => {
  const lists = `<w:document xmlns:w="w"><w:body>
<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Table of Contents</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="List of Tables"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>List of Tables</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="List of Figures"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>List of Figures</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>引言</w:t></w:r></w:p>
BODY
<w:sectPr/></w:body></w:document>`;

  test("没有表格 / 图片 / 题注：只留 TOC，两个 List 整节消失", () => {
    const input = lists.replace("BODY", "<w:tbl><w:tblPr/></w:tbl>");
    const result = pruneEmptyLists(input);
    assert.deepEqual(result.lists, { toc: true, figures: false, tables: false });
    assert.match(result.xml, /Table of Contents/);
    assert.doesNotMatch(result.xml, /List of Tables/);
    assert.doesNotMatch(result.xml, /List of Figures/);
    // 表本身不能跟着被删
    assert.match(result.xml, /<w:tbl>/);
  });

  test("有表 + 题注：List of Tables 留下；没有图片仍删 List of Figures", () => {
    const input = lists.replace(
      "BODY",
      "<w:tbl><w:tblPr/></w:tbl><w:p><w:pPr><w:pStyle w:val=\"TableCaption\"/></w:pPr><w:r><w:t>表 1 数据</w:t></w:r></w:p>",
    );
    const result = pruneEmptyLists(input);
    assert.deepEqual(result.lists, { toc: true, figures: false, tables: true });
    assert.match(result.xml, /List of Tables/);
    assert.doesNotMatch(result.xml, /List of Figures/);
  });

  test("有图 + ImageCaption：List of Figures 留下", () => {
    const input = lists.replace(
      "BODY",
      '<w:p><w:r><w:drawing/></w:r></w:p><w:p><w:pPr><w:pStyle w:val="ImageCaption"/></w:pPr><w:r><w:t>图 1</w:t></w:r></w:p>',
    );
    const result = pruneEmptyLists(input);
    assert.equal(result.lists.figures, true);
    assert.match(result.xml, /List of Figures/);
  });

  test("没有标题：连 TOC 一起删（--toc 总是传，内容由产物决定）", () => {
    const input = lists.replace(/<w:p><w:pPr><w:pStyle w:val="Heading1"\/>[\s\S]*?<\/w:p>/, "");
    const result = pruneEmptyLists(input);
    assert.equal(result.lists.toc, false);
    assert.doesNotMatch(result.xml, /Table of Contents/);
  });
});
