/**
 * 带 `x:` 前缀的 OOXML 兜底（2026-11-14 验收 B7）。
 *
 * 背景：OfficeCLI 重写工作簿时把 spreadsheetml 的元素写成 `<x:workbook>` / `<x:sheet>`
 * （workbook / styles / worksheets 都是，sharedStrings 不是），ExcelJS 4.4.0 不认带前缀
 * 的元素，报 `Cannot set properties of undefined (setting 'sheetNo')`——任何被 `edit_office`
 * 写过的 xlsx，数据网格就永久打不开。
 *
 * 样张是验收时留下的两份真实文件（不是现造的）：`grid-pristine.xlsx`（原样）与
 * `grid-edited.xlsx`（同一份被 officecli 改过一次）。这里钉四件事：
 *   1. 前缀清理只动元素名 / 属性名上的 `x:`，`r:` / `x14ac:` / `xmlns:x` / 属性值不动；
 *   2. 原样文件走原路（零开销、不带 normalized）；
 *   3. 带前缀的文件兜底后能读，日期 / 公式缓存值 / 合并区 / 隐藏表语义不变；
 *   4. **原文件 sha256 与 mtime 不变**；非前缀类损坏仍按原错误报，不被兜底吞掉。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { normalizePrefixedWorkbook, readXlsxPreview, stripXPrefix } from "./read.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const PRISTINE = join(FIXTURES, "grid-pristine.xlsx");
const EDITED = join(FIXTURES, "grid-edited.xlsx");
const CREATED = join(FIXTURES, "created-by-cli.xlsx");

const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

describe("stripXPrefix", () => {
  test("ap:（docProps）也去掉；cp:/dc:/dcterms: 这些标准前缀不动", () => {
    const xml =
      '<ap:Properties xmlns:ap="http://ap">' +
      '<ap:Application>OfficeCLI/1.0.158</ap:Application>' +
      '<ap:AppVersion>16.0300</ap:AppVersion></ap:Properties>';
    assert.equal(
      stripXPrefix(xml),
      '<Properties xmlns:ap="http://ap"><Application>OfficeCLI/1.0.158</Application>' +
        "<AppVersion>16.0300</AppVersion></Properties>",
    );
    const core = '<cp:coreProperties xmlns:cp="http://cp"><dc:title>x</dc:title></cp:coreProperties>';
    assert.equal(stripXPrefix(core), core);
  });

  test("元素名与属性名上的 x: 去掉；其它前缀 / xmlns 声明 / 属性值不动", () => {
    const xml =
      '<x:workbook xmlns:x="http://x" xmlns:r="http://r" mc:Ignorable="x15">' +
      '<x:sheet name="A" r:id="rId1" x:num="3" x14ac:dyDescent="55" note=" x:keep"/>' +
      "<x:t>正文里的 x: 不动</x:t></x:workbook>";
    const out = stripXPrefix(xml);
    assert.equal(
      out,
      '<workbook xmlns:x="http://x" xmlns:r="http://r" mc:Ignorable="x15">' +
        '<sheet name="A" r:id="rId1" num="3" x14ac:dyDescent="55" note=" x:keep"/>' +
        "<t>正文里的 x: 不动</t></workbook>",
    );
  });
});

describe("带前缀的工作簿（真实样张）", () => {
  test("原样文件：正常读、不带 normalized、不碰原文件", async () => {
    const before = await readFile(PRISTINE);
    const beforeStat = await stat(PRISTINE);
    const result = await readXlsxPreview(PRISTINE);
    assert.equal(result.kind, "workbook");
    assert.ok(result.kind === "workbook");
    assert.equal(result.normalized, undefined);
    assert.deepEqual(result.sheets.map((sheet) => sheet.name), ["销售数据", "汇总"]);
    assert.equal(sha256(await readFile(PRISTINE)), sha256(before));
    assert.equal((await stat(PRISTINE)).mtimeMs, beforeStat.mtimeMs);
  });

  test("officecli 改过的文件：兜底后能读，日期 / 公式 / 合并区 / 隐藏表语义不变", async () => {
    const before = await readFile(EDITED);
    const beforeStat = await stat(EDITED);
    // 原路径解析不了才走兜底——normalized:true 就是「直接解析失败」的证明
    const result = await readXlsxPreview(EDITED);
    assert.equal(result.kind, "workbook");
    assert.ok(result.kind === "workbook");
    assert.equal(result.normalized, true);
    // 隐藏表「备注」不出现在标签里（与既有语义一致）
    assert.deepEqual(result.sheets.map((sheet) => sheet.name), ["销售数据", "汇总"]);
    assert.equal(result.sheet.name, "销售数据");
    const rows = result.sheet.rows;
    // 表头 + 第一行数据：日期（本地时区）/ 文本 / 数值 / 公式与缓存值
    assert.equal(rows[0]?.[0]?.text, "日期");
    assert.match(rows[1]?.[0]?.text ?? "", /^2026-01-0[12]/);
    assert.equal(rows[1]?.[1]?.text, "键盘");
    assert.equal(rows[1]?.[2]?.numeric, true);
    assert.equal(rows[1]?.[2]?.text, "199");
    assert.equal(rows[1]?.[4]?.formula, "C2*D2");
    assert.equal(rows[1]?.[4]?.text, "597");
    // 第 4 行公式没有缓存值：文字留空、formula 仍在（既有语义）
    assert.equal(rows[3]?.[4]?.formula, "C4*D4");
    assert.equal(rows[3]?.[4]?.text, "");

    // 第二张表：合并区 A4:B5 + 公式
    const summary = await readXlsxPreview(EDITED, { sheet: 1 });
    assert.ok(summary.kind === "workbook");
    assert.equal(summary.sheet.name, "汇总");
    assert.deepEqual(summary.sheet.merges, [{ top: 3, left: 0, bottom: 4, right: 1 }]);
    assert.equal(summary.sheet.rows[1]?.[1]?.formula, "'销售数据'!E7");

    // 原文件一个字节没动
    assert.equal(sha256(await readFile(EDITED)), sha256(before));
    assert.equal((await stat(EDITED)).mtimeMs, beforeStat.mtimeMs);
  });

  test("officecli create 的文件（x: + ap: 前缀）：兜底后能读", async () => {
    const before = await readFile(CREATED);
    const result = await readXlsxPreview(CREATED);
    assert.equal(result.kind, "workbook");
    assert.ok(result.kind === "workbook");
    assert.equal(result.normalized, true);
    assert.equal(result.sheet.name, "Sheet1");
    assert.equal(result.sheet.rows[0]?.[0]?.text, "由 officecli 生成");
    assert.equal(result.sheet.rows[1]?.[1]?.text, "7");
    assert.equal(sha256(await readFile(CREATED)), sha256(before));
  });

  test("normalizePrefixedWorkbook：原样文件没有可归一化的部分 → null", async () => {
    assert.equal(await normalizePrefixedWorkbook(PRISTINE), null);
    assert.ok((await normalizePrefixedWorkbook(EDITED)) !== null);
  });

  test("非前缀类损坏不被兜底吞掉：坏 zip 仍报原错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-xlsx-prefix-"));
    const brokenZip = join(dir, "broken.xlsx");
    await writeFile(brokenZip, Buffer.from("PK\u0003\u0004not a real zip"));
    try {
      const result = await readXlsxPreview(brokenZip);
      assert.equal(result.kind, "unreadable");
      assert.ok(result.kind === "unreadable");
      assert.equal(result.reason, "corrupt");
      assert.match(result.detail, /zip|End of central directory|Corrupted/i);
      assert.equal(await normalizePrefixedWorkbook(brokenZip), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("带前缀但结构坏的文件：兜底尝试后仍回原始错误，不假装成功", async () => {
    // 只有 workbook.xml（带 x: 前缀）与 Content_Types，没有 _rels / 工作表
    const zip = new JSZip();
    zip.file("xl/workbook.xml", '<x:workbook xmlns:x="http://x"><x:sheets/></x:workbook>');
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://x"/>');
    const dir = await mkdtemp(join(tmpdir(), "orbita-xlsx-prefix-"));
    const path = join(dir, "prefixed-broken.xlsx");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    try {
      const result = await readXlsxPreview(path);
      assert.equal(result.kind, "unreadable");
      assert.ok(result.kind === "unreadable");
      assert.equal(result.reason, "corrupt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
