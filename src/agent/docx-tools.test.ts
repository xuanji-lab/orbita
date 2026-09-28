import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import JSZip from "jszip";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDocxTools } from "./docx-tools.ts";

/**
 * read_docx 的守护。夹具用 jszip 在内存造最小合法 docx（真实结构：
 * document/styles/comments/footnotes/numbering/media/rels/[Content_Types]，
 * 缺 part 会让 mammoth 内部崩——footnoteReference 指向不存在的 footnotes.xml
 * 时它抛 null.type，那是夹具的坑不是工具的）。
 */

/** 1×1 PNG（图占位与提取链路的最小真图） */
const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/** 全量正文：覆盖 mammoth 会输出的全部标签形态（探针实测钉住） */
const BODY_FULL = `
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 方法</w:t></w:r></w:p>
<w:p><w:r><w:t>正文第一段，含</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:t>与</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r><w:r><w:t>。</w:t></w:r></w:p>
<w:p><w:r><w:br/></w:r><w:r><w:t>换行后的文字</w:t></w:r></w:p>
<w:p><w:r><w:t>脚注引用前</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t>脚注引用后</w:t></w:r></w:p>
<w:p><w:r><w:t>批注前</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>被批注的词</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
<w:p><w:r><w:t>图片段落：</w:t></w:r><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1000000" cy="1000000"/><wp:docPr id="1" name="figure1.png" descr="实验装置图"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="figure1.png" descr="实验装置图"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>表头1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表头2</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>跨两列的合并格</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项一</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>嵌套项</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rId8"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p>
<w:sectPr/>`;

/** 大文档：50 段 × ~700 字符，压过 30000 字符封顶 */
const BODY_LONG = Array.from(
  { length: 50 },
  (_, i) =>
    `<w:p><w:r><w:t>第${i + 1}段：${"内容文字".repeat(160)}（段尾 ${i + 1}）</w:t></w:r></w:p>`,
).join("\n");

interface DocxOpts {
  body: string;
  /** 是否带图片/批注/脚注相关的 part（省掉可测「引用了不存在 part」之外的瘦身形态） */
  withImage?: boolean;
  withComments?: boolean;
  withFootnotes?: boolean;
  title?: string;
}

async function buildDocx(opts: DocxOpts): Promise<Buffer> {
  const withImage = opts.withImage ?? true;
  const withComments = opts.withComments ?? true;
  const withFootnotes = opts.withFootnotes ?? true;
  const zip = new JSZip();
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
    opts.title !== undefined
      ? `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
      : "",
    withComments
      ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`
      : "",
    withFootnotes
      ? `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`
      : "",
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
${overrides}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
${opts.title !== undefined ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` : ""}
</Relationships>`,
  );
  const rels = [
    `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`,
    `<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    withComments
      ? `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`
      : "",
    withFootnotes
      ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>`
      : "",
    `<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
    `<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a" TargetMode="External"/>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${opts.body}
</w:body></w:document>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`,
  );
  if (withComments) {
    zip.file(
      "word/comments.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:comment w:id="0" w:author="张三" w:date="2026-09-28T10:00:00Z" w:initials="Z"><w:p><w:r><w:t>这里要改</w:t></w:r></w:p></w:comment>
</w:comments>`,
    );
  }
  if (withFootnotes) {
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
<w:footnote w:id="2"><w:p><w:r><w:t>这是脚注内容。</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    );
  }
  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`,
  );
  if (opts.title !== undefined) {
    zip.file(
      "docProps/core.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${opts.title}</dc:title>
</cp:coreProperties>`,
    );
  }
  if (withImage) zip.file("word/media/image1.png", PNG_1PX);
  return zip.generateAsync({ type: "nodebuffer" });
}

let dir = "";
let tool: ToolDefinition;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-docx-"));
  tool = createDocxTools(dir)[0]!;
  await writeFile(join(dir, "full.docx"), await buildDocx({ body: BODY_FULL, title: "测试文档标题" }));
  await writeFile(join(dir, "long.docx"), await buildDocx({ body: BODY_LONG, withImage: false, withComments: false, withFootnotes: false }));
  await writeFile(join(dir, "empty.docx"), await buildDocx({ body: "<w:sectPr/>", withImage: false, withComments: false, withFootnotes: false }));
  await writeFile(join(dir, "plain.txt"), Buffer.from("just text, not a zip"));
  await writeFile(join(dir, "fake.docx"), Buffer.from("PK\x03\x04 not really a zip body"));
  await writeFile(
    join(dir, "legacy.doc"),
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
  );
  await writeFile(
    join(dir, "locked.docx"),
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
  );
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (path: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = await tool.execute("call-1", { path, ...args }, undefined, undefined, undefined as never);
  return result.content[0]!.type === "text" ? result.content[0]!.text : "";
};

describe("read_docx", () => {
  test("整读：结构化 markdown——标题/粗斜体/表格/列表/链接/脚注/批注", async () => {
    const text = await run("full.docx");
    assert.ok(text.startsWith("[Word document: 测试文档标题. "), text.slice(0, 80));
    assert.ok(text.includes("# 第一章 方法"));
    assert.ok(text.includes("**加粗**"));
    assert.ok(text.includes("*斜体*"));
    assert.ok(text.includes("| 表头1 | 表头2 |"));
    assert.ok(text.includes("| --- | --- |"));
    assert.ok(text.includes("跨两列的合并格"));
    assert.ok(text.includes("- 列表项一"));
    assert.ok(text.includes("  - 嵌套项"));
    assert.ok(text.includes("[链接文字](https://example.com/a)"));
    // 脚注：正文锚点平铺 [1]，文末附内容
    assert.ok(text.includes("[1]"));
    assert.ok(text.includes("这是脚注内容。"));
    // 批注：正文锚点 [Z1]，文末附内容（styleMap 生效）
    assert.ok(text.includes("[Z1]"));
    assert.ok(text.includes("这里要改"));
    // 图片默认是文本占位，不是 image 块
    assert.ok(text.includes("[image 1: 实验装置图]"));
    assert.ok(!text.includes("base64"));
  });

  test("大纲：heading 标起始块号", async () => {
    const text = await run("full.docx");
    assert.ok(text.includes("Sections: 第一章 方法 (block 1)."), text.slice(0, 160));
  });

  test("分片：offset/limit 按块切，余块给续读提示", async () => {
    const text = await run("full.docx", { offset: 2, limit: 2 });
    assert.ok(text.includes("Showing blocks 2-3 of"), text.slice(0, 160));
    assert.ok(text.includes("Use offset=4 to continue."), text.slice(0, 200));
    assert.ok(!text.includes("# 第一章 方法"));
    assert.ok(text.includes("**加粗**"));
  });

  test("字符封顶：大文档截在块边界并给续读块号", async () => {
    const text = await run("long.docx");
    assert.ok(text.includes("Showing blocks 1-"), text.slice(0, 160));
    assert.ok(text.includes("Use offset="));
    // 50 段 × ~660 字符 ≈ 33000 字符 > 30000 封顶：必然截断，尾段不在
    assert.ok(!text.includes("（段尾 50）"), "封顶后不该带最后一段");
    const rest = await run("long.docx", { offset: 45 });
    assert.ok(rest.includes("（段尾 50）"), "从块 45 续读应含最后一段");
  });

  test("空文档：如实返回空体，不报错", async () => {
    const text = await run("empty.docx");
    assert.ok(text.includes("no readable content"), text);
  });

  test("offset 越界：报总块数", async () => {
    await assert.rejects(
      run("full.docx", { offset: 999 }),
      /offset 999 is beyond the last block \(\d+ blocks total\)/,
    );
  });

  test("拒非 zip：报 not a Word document", async () => {
    await assert.rejects(run("plain.txt"), /Not a Word document: plain\.txt/);
  });

  test(".doc 老格式：OLE2 魔数 + .doc 扩展名，报转存", async () => {
    await assert.rejects(run("legacy.doc"), /Legacy \.doc is not supported: legacy\.doc\. Save it as \.docx first\./);
  });

  test("加密 docx：OLE2 魔数 + .docx 扩展名，报去密码", async () => {
    await assert.rejects(run("locked.docx"), /password-protected Word document/);
  });

  test("坏 zip：解析失败包上文件名", async () => {
    await assert.rejects(run("fake.docx"), /Failed to parse Word document \(fake\.docx\)/);
  });

  test("ENOENT 穿透", async () => {
    await assert.rejects(run("nope.docx"), { code: "ENOENT" });
  });

  test("标题回退链：core.xml 无标题时回退首个 heading", async () => {
    await writeFile(
      join(dir, "no-title.docx"),
      await buildDocx({
        body: `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>回退标题</w:t></w:r></w:p><w:p><w:r><w:t>正文。</w:t></w:r></w:p>`,
        withImage: false,
        withComments: false,
        withFootnotes: false,
      }),
    );
    const text = await run("no-title.docx");
    assert.ok(text.startsWith("[Word document: 回退标题. "), text.slice(0, 80));
  });

  test("引用了缺失 part 的损坏文档：如实报错带文件名", async () => {
    // body 有 commentReference 但 comments.xml 不在包里（真实损坏形态：half-saved）
    await writeFile(
      join(dir, "broken-parts.docx"),
      await buildDocx({ body: BODY_FULL, withImage: false, withComments: false, withFootnotes: false }),
    );
    await assert.rejects(run("broken-parts.docx"), /Failed to parse Word document \(broken-parts\.docx\)/);
  });

  test("实体解码与换行：&amp; 等不裸露、br 落成换行", async () => {
    const body = `<w:p><w:r><w:t>A &amp; B &lt;tag&gt;</w:t></w:r></w:p><w:p><w:r><w:t>上</w:t></w:r><w:br/><w:r><w:t>下</w:t></w:r></w:p>`;
    await writeFile(
      join(dir, "entity.docx"),
      await buildDocx({ body, withImage: false, withComments: false, withFootnotes: false }),
    );
    const text = await run("entity.docx");
    assert.ok(text.includes("A & B <tag>"));
    assert.ok(!text.includes("&amp;"));
    assert.ok(text.includes("上\n下"));
  });
});
