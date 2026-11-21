/**
 * writeXlsxCells 的账：改值 / 改公式 / 清空 / 新行 / 字符串转义，以及**别的部件一个字节
 * 都没动**（样式、合并区、列宽、冻结窗格、条件格式、数据验证、图片、另一张表）、
 * 冲突拒绝、越界拒绝、太大拒绝、坏文件、共享公式组长、原子写失败。
 *
 * 样张现造（ExcelJS 写、我们补）：比往仓里塞二进制样张可控。保真那几条用两种证据：
 *   1. 目标表之外的 zip 条目逐字节相等（样式 / 媒体 / 另一张表都在这里）；
 *   2. 目标表的 XML 去掉被改的那一格后与改前**完全相同**——证明补丁只碰了那一格。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS, { type Buffer as ExcelJsBuffer } from "exceljs";
import JSZip from "jszip";
import { writeXlsxCells } from "./edit.ts";
import { readXlsxPreview } from "./read.ts";
import { XLSX_MAX_BYTES, XLSX_PREVIEW_COLS, XLSX_PREVIEW_ROWS } from "../../shared/xlsx.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-xlsx-edit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 1×1 的透明 PNG（够证明媒体条目原样带过去了） */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 样张：两张表 + 样式（粗体 / 红字 / 黄底 / 边框）+ 合并区 + 列宽 + 冻结 + 条件格式 +
 * 数据验证 + 图片。目标表里 C5 是空的（改值的落点），D2:D4 是一组共享公式。
 */
async function sampleWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("Data");
  data.getCell("A1").value = "name";
  data.getCell("B1").value = "qty";
  data.getCell("A1").font = { bold: true, color: { argb: "FFFF0000" } };
  data.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  data.getCell("B2").value = 5;
  data.getCell("B2").border = { top: { style: "thin" } };
  data.getCell("B2").numFmt = "0.00";
  data.mergeCells("A3:C3");
  data.getCell("A3").value = "merged";
  data.getColumn(2).width = 33;
  data.views = [{ state: "frozen", xSplit: 1, ySplit: 1, topLeftCell: "B2" }];
  data.addConditionalFormatting({
    ref: "B2:B10",
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        priority: 1,
        formulae: ["3"],
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } } },
      },
    ],
  });
  data.getCell("A2").dataValidation = { type: "list", allowBlank: true, formulae: ['"a,b,c"'] };
  // 共享公式：D2 是组长（ref 由 ExcelJS 写出来），D3 / D4 是成员
  data.getCell("C2").value = 2;
  data.getCell("D2").value = { formula: "C2*2", result: 4 };
  data.getCell("D3").value = { sharedFormula: "D2", result: 6 };
  data.getCell("D4").value = { sharedFormula: "D2", result: 8 };
  // ExcelJS 的 d.ts 自带一个假的 Buffer（extends ArrayBuffer），与 node 的 Buffer 不兼容
  const imageId = workbook.addImage({ buffer: PIXEL_PNG as unknown as ExcelJsBuffer, extension: "png" });
  data.addImage(imageId, "F2:F6");

  const other = workbook.addWorksheet("Other");
  other.getCell("A1").value = "keep me";
  other.getCell("A1").font = { italic: true };
  await workbook.xlsx.writeFile(path);
}

/** 目标工作表在 zip 里的键（ExcelJS 总是把第一张表写成 sheet1.xml） */
const SHEET_PART = "xl/worksheets/sheet1.xml";

const readZip = async (path: string): Promise<JSZip> => JSZip.loadAsync(await readFile(path));

/** zip 里每个条目的字节 */
async function zipEntries(zip: JSZip): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.file(name);
    if (entry === null) continue;
    entries.set(name, await entry.async("nodebuffer"));
  }
  return entries;
}

async function sheetXml(path: string): Promise<string> {
  const zip = await readZip(path);
  const part = zip.file(SHEET_PART);
  assert.ok(part !== null, `缺少 ${SHEET_PART}`);
  return part.async("string");
}

/** 一格在 XML 里的整段（`<c r="…"/>` 或 `<c r="…">…</c>`） */
function cellTag(xml: string, ref: string): string {
  const start = xml.indexOf(`<c r="${ref}"`);
  assert.ok(start >= 0, `XML 里找不到 ${ref}`);
  const openEnd = xml.indexOf(">", start);
  if (xml[openEnd - 1] === "/") return xml.slice(start, openEnd + 1);
  const close = xml.indexOf("</c>", openEnd);
  assert.ok(close >= 0, `${ref} 没有闭合`);
  return xml.slice(start, close + "</c>".length);
}

/** 目标表 XML 去掉指定几格之后剩下的部分（用来证明「别的字节没变」） */
function withoutCells(xml: string, refs: readonly string[]): string {
  let out = xml;
  for (const ref of refs) out = out.replace(cellTag(out, ref), "");
  return out;
}

const openWorkbook = async (path: string): Promise<{ workbook: ExcelJS.Workbook; data: ExcelJS.Worksheet }> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const data = workbook.getWorksheet("Data");
  assert.ok(data !== undefined);
  return { workbook, data };
};

/** `sheetData` 之前 / 之内 / 之后的三个切片（新格格会撑大 `<dimension>`，它在前面的切片里） */
function splitSheetData(xml: string): { head: string; body: string; tail: string } {
  const start = xml.indexOf("<sheetData");
  assert.ok(start >= 0);
  const openEnd = xml.indexOf(">", start) + 1;
  const close = xml.indexOf("</sheetData>");
  return { head: xml.slice(0, start), body: xml.slice(openEnd, close), tail: xml.slice(close) };
}

const DIMENSION = /<dimension ref="[^"]*"\/>/;

/** 目标表除 `sheetData` 内容与 `<dimension>` 之外一个字节没变（新建行的场合不能直接用整串相等） */
function assertOnlySheetDataGrew(beforeXml: string, afterXml: string, addedRow: string): void {
  const before = splitSheetData(beforeXml);
  const after = splitSheetData(afterXml);
  assert.equal(after.head.replace(DIMENSION, ""), before.head.replace(DIMENSION, ""));
  assert.equal(after.tail, before.tail);
  assert.equal(after.body.replace(addedRow, ""), before.body);
  assert.notEqual(after.head, before.head, "dimension 应该被撑大");
}

describe("writeXlsxCells —— 只动指定的格", () => {
  test("改一个已有的格：值对了，目标表之外的 zip 条目逐字节相同，目标表只有那一格变了", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    const beforeXml = await sheetXml(path);
    const beforeEntries = await zipEntries(await readZip(path));

    // B2 是带边框 + numFmt 的格：改它的值，样式必须跟着留在同一格里
    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 2, col: 2, value: 42 }]);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.cells, 1);

    const afterXml = await sheetXml(path);
    assert.equal(cellTag(afterXml, "B2").includes("<v>42</v>"), true);
    // 去掉被改的那一格，整张表 XML 与改前完全相同（dimension 不用撑：B2 本来就在范围内）
    assert.equal(withoutCells(afterXml, ["B2"]), withoutCells(beforeXml, ["B2"]));

    // 其它 zip 条目（styles / media / 另一张表 / content-types …）一个字节都没动
    const afterEntries = await zipEntries(await readZip(path));
    assert.deepEqual([...afterEntries.keys()].sort(), [...beforeEntries.keys()].sort());
    for (const [name, bytes] of beforeEntries) {
      if (name === SHEET_PART) continue;
      assert.equal(Buffer.compare(bytes, afterEntries.get(name) as Buffer), 0, `${name} 被改动了`);
    }
    assert.notEqual(Buffer.compare(before, await readFile(path)), 0, "文件应当真的被写过");

    // 读回来：值、样式、合并、列宽、冻结、条件格式、数据验证、图片、另一张表全都在
    const original = await openWorkbook(path);
    const cell = original.data.getCell("B2");
    assert.equal(cell.value, 42);
    assert.equal(cell.numFmt, "0.00", "改值不该顺手把数字格式抹掉");
    assert.equal(cell.border?.top?.style, "thin");
    const header = original.data.getCell("A1");
    assert.equal(header.font?.bold, true);
    assert.equal(header.fill?.type, "pattern");
    assert.equal(original.data.getCell("B2").border?.top?.style, "thin");
    assert.equal(original.data.getCell("B2").numFmt, "0.00");
    assert.equal(original.data.getColumn(2).width, 33);
    assert.deepEqual(original.data.model.merges, ["A3:C3"]);
    // 条件格式不在 ExcelJS 的公开类型里（运行时在 worksheet 上），按模型读
    assert.equal((original.data as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings.length, 1);
    assert.equal(original.data.getCell("A2").dataValidation?.type, "list");
    assert.equal(original.data.getImages().length, 1);
    assert.equal(original.workbook.getWorksheet("Other")?.getCell("A1").value, "keep me");
    assert.deepEqual(original.data.views, [
      {
        workbookViewId: 0,
        rightToLeft: false,
        state: "frozen",
        xSplit: 1,
        ySplit: 1,
        topLeftCell: "B2",
        showRuler: true,
        showRowColHeaders: true,
        showGridLines: true,
        zoomScale: 100,
        zoomScaleNormal: 100,
      },
    ]);
  });

  test("写一个空格子（新行）：值对了，表里只有新插入的那行变了，dimension 撑大", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const beforeXml = await sheetXml(path);
    assert.equal(beforeXml.includes('<c r="C5"'), false, "C5 本来必须是空格");

    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 5, col: 3, value: 42 }]);
    assert.equal(result.kind, "ok");
    const afterXml = await sheetXml(path);
    const tag = cellTag(afterXml, "C5");
    assert.equal(tag, '<c r="C5"><v>42</v></c>');
    assertOnlySheetDataGrew(beforeXml, afterXml, `<row r="5">${tag}</row>`);
    assert.equal((await openWorkbook(path)).data.getCell("C5").value, 42);
  });

  test("改一个字符串：尖括号 / 引号 / 中文原样进去，预览读到同一条文本", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const text = `a<b>&"c" 中文`;
    const result = await writeXlsxCells(path, [
      { sheet: "Data", row: 5, col: 1, value: text },
      { sheet: "Data", row: 6, col: 1, value: "线段的长度" },
    ]);
    assert.equal(result.kind, "ok");
    const { data } = await openWorkbook(path);
    assert.equal(data.getCell("A5").value, text);
    assert.equal(data.getCell("A6").value, "线段的长度");

    const preview = await readXlsxPreview(path);
    assert.equal(preview.kind, "workbook");
    if (preview.kind !== "workbook") return;
    assert.equal(preview.sheet.rows[4]?.[0]?.text, text);
  });

  test("写公式：只有 <f> 没有 <v>（不假装算过），读回来 formula 原文在、缓存值空缺", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const beforeXml = await sheetXml(path);
    const result = await writeXlsxCells(path, [
      { sheet: "Data", row: 5, col: 2, formula: "=SUM(B2:B4)" },
    ]);
    assert.equal(result.kind, "ok");
    const xml = await sheetXml(path);
    const tag = cellTag(xml, "B5");
    assert.equal(tag.includes("<f>SUM(B2:B4)</f>"), true);
    assert.equal(tag.includes("<v>"), false, "没有重算，就不能写缓存值");
    assert.equal(beforeXml.includes('<c r="B5"'), false);
    assertOnlySheetDataGrew(beforeXml, xml, `<row r="5">${tag}</row>`);

    const { data } = await openWorkbook(path);
    assert.equal(data.getCell("B5").formula, "SUM(B2:B4)");
    const preview = await readXlsxPreview(path);
    assert.equal(preview.kind, "workbook");
    if (preview.kind !== "workbook") return;
    const cell = preview.sheet.rows[4]?.[1];
    assert.equal(cell?.formula, "SUM(B2:B4)");
    assert.equal(cell?.text, "");
  });

  test("清空一格：值没了、样式还在（粗体 / 底色 / numFmt 不被顺手抹掉）", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 1, col: 1, value: null }]);
    assert.equal(result.kind, "ok");
    const { data } = await openWorkbook(path);
    const cell = data.getCell("A1");
    assert.equal(cell.value, null);
    assert.equal(cell.font?.bold, true);
    assert.equal(cell.fill?.type, "pattern");
    const xml = await sheetXml(path);
    assert.equal(/<c r="A1"[^>]*\/>/.test(xml), true, "清空后留一个带样式的空 <c/>");
  });

  test("一行里改两格 + 写到一个还不存在的行：新行按行号插进去，dimension 撑大", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await writeXlsxCells(path, [
      { sheet: "Data", row: 2, col: 1, value: "apple" },
      { sheet: "Data", row: 2, col: 3, value: 7 },
      { sheet: "Data", row: 9, col: 2, value: "добавлено" },
    ]);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.cells, 3);
    const { data } = await openWorkbook(path);
    assert.equal(data.getCell("A2").value, "apple");
    assert.equal(data.getCell("C2").value, 7);
    assert.equal(data.getCell("B9").value, "добавлено");
    // 同一行的其它格与样式还在
    assert.equal(data.getCell("B2").value, 5);
    assert.equal(data.getCell("B2").numFmt, "0.00");
    const xml = await sheetXml(path);
    // 行序仍然是升序（Excel 认这个）
    const rowNumbers = [...xml.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]));
    assert.deepEqual(rowNumbers, [...rowNumbers].sort((a, b) => a - b));
    assert.equal(/<dimension ref="A1:[A-Z]+9"\/>/.test(xml), true, `dimension 要撑到第 9 行：${xml.slice(0, 400)}`);
  });

  test("同一格给了两次：后给的覆盖先给的（一次保存里不该写两遍）", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await writeXlsxCells(path, [
      { sheet: "Data", row: 5, col: 3, value: 1 },
      { sheet: "Data", row: 5, col: 3, value: 2 },
    ]);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.cells, 1);
    const { data } = await openWorkbook(path);
    assert.equal(data.getCell("C5").value, 2);
  });

  test("写回之后指纹变了：回执带回新的 size / modifiedAt", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 5, col: 3, value: 42 }]);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    const bytes = await readFile(path);
    assert.equal(result.size, bytes.byteLength);
    assert.notEqual(result.size, before.byteLength);
    assert.equal(Number.isFinite(result.modifiedAt), true);
  });
});

describe("writeXlsxCells —— 拒绝的时候一个字节都不写", () => {
  test("冲突：指纹对不上就回 conflict，文件原样", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const stale = { mtimeMs: 1, size: 999 };
    const before = await readFile(path);
    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 5, col: 3, value: 42 }], stale);
    assert.equal(result.kind, "conflict");
    if (result.kind !== "conflict") return;
    assert.equal(result.size, before.byteLength);
    assert.equal(Buffer.compare(before, await readFile(path)), 0);
  });

  test("指纹一致就正常写（mtime + size 都从预览回执原样带回来）", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const preview = await readXlsxPreview(path);
    assert.equal(preview.kind, "workbook");
    if (preview.kind !== "workbook") return;
    const result = await writeXlsxCells(
      path,
      [{ sheet: "Data", row: 5, col: 3, value: 42 }],
      { mtimeMs: preview.modifiedAt, size: preview.size },
    );
    assert.equal(result.kind, "ok");
  });

  test("越界：行 / 列超过可编辑窗口 → out-of-window，附上被拒的那几条", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    const result = await writeXlsxCells(path, [
      { sheet: "Data", row: XLSX_PREVIEW_ROWS + 1, col: 1, value: "x" },
      { sheet: "Data", row: 1, col: XLSX_PREVIEW_COLS + 1, value: "y" },
      { sheet: "Data", row: 2, col: 2, value: 1 },
    ]);
    assert.equal(result.kind, "out-of-window");
    if (result.kind !== "out-of-window") return;
    assert.equal(result.rows, XLSX_PREVIEW_ROWS);
    assert.equal(result.cols, XLSX_PREVIEW_COLS);
    assert.deepEqual(
      result.edits.map((edit) => `${edit.row}:${edit.col}`),
      [`${XLSX_PREVIEW_ROWS + 1}:1`, `1:${XLSX_PREVIEW_COLS + 1}`],
    );
    assert.equal(Buffer.compare(before, await readFile(path)), 0, "越界时连合法的那条也不写");
  });

  test("越界：小于 1 的行列（0-based 混进来）同样拒绝", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 0, col: 0, value: "x" }]);
    assert.equal(result.kind, "out-of-window");
  });

  test("太大：超过上限直接拒绝，不读内容", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const size = (await readFile(path)).byteLength;
    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 2, col: 2, value: 1 }], undefined, {
      limit: size - 1,
    });
    assert.equal(result.kind, "too-large");
    if (result.kind !== "too-large") return;
    assert.equal(result.limit, size - 1);
    assert.equal(result.size, size);
    assert.equal(XLSX_MAX_BYTES > size, true);
  });

  test("不是 zip → corrupt；OLE2 头（加密 / 旧版 .xls）→ password", async () => {
    const text = join(dir, "note.xlsx");
    await writeFile(text, "这不是工作簿");
    assert.equal((await writeXlsxCells(text, [{ sheet: "S", row: 1, col: 1, value: 1 }])).kind, "unreadable");
    const encrypted = join(dir, "locked.xlsx");
    await writeFile(encrypted, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
    const result = await writeXlsxCells(encrypted, [{ sheet: "S", row: 1, col: 1, value: 1 }]);
    assert.equal(result.kind, "unreadable");
    if (result.kind !== "unreadable") return;
    assert.equal(result.reason, "password");
  });

  test("表名不存在 → sheet-missing，并把现在的表名带回去", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await writeXlsxCells(path, [{ sheet: "Nope", row: 1, col: 1, value: 1 }]);
    assert.equal(result.kind, "unreadable");
    if (result.kind !== "unreadable") return;
    assert.equal(result.reason, "sheet-missing");
    assert.deepEqual(result.sheets, ["Data", "Other"]);
  });

  test("形状不对的改动 → failed（行列必须是整数、值只能是字符串 / 数字 / null）", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    assert.equal(
      (await writeXlsxCells(path, [{ sheet: "Data", row: 1.5, col: 1, value: 1 }])).kind,
      "failed",
    );
    assert.equal(
      (await writeXlsxCells(path, [{ sheet: "", row: 1, col: 1, value: 1 }])).kind,
      "failed",
    );
    assert.equal(
      (
        await writeXlsxCells(path, [
          { sheet: "Data", row: 1, col: 1, value: Number.POSITIVE_INFINITY },
        ])
      ).kind,
      "failed",
    );
    assert.equal(Buffer.compare(before, await readFile(path)), 0);
  });

  test("共享公式组长：写值被拒（会让整组失去定义），写公式则保留组的属性", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    const refused = await writeXlsxCells(path, [{ sheet: "Data", row: 2, col: 4, value: 1 }]);
    assert.equal(refused.kind, "shared-formula");
    if (refused.kind !== "shared-formula") return;
    assert.deepEqual([refused.sheet, refused.row, refused.col], ["Data", 2, 4]);
    assert.equal(Buffer.compare(before, await readFile(path)), 0);

    const written = await writeXlsxCells(path, [{ sheet: "Data", row: 2, col: 4, formula: "C2*3" }]);
    assert.equal(written.kind, "ok");
    const xml = await sheetXml(path);
    const tag = cellTag(xml, "D2");
    assert.equal(/<f t="shared" ref="D2:D4" si="0">C2\*3<\/f>/.test(tag), true, "组的属性要留着");
    assert.equal(tag.includes("<v>"), false);

    // 成员格随便改（它不是任何格子的来源）
    const member = await writeXlsxCells(path, [{ sheet: "Data", row: 3, col: 4, value: 100 }]);
    assert.equal(member.kind, "ok");
    assert.equal((await openWorkbook(path)).data.getCell("D3").value, 100);
  });

  test("原子写失败：原文件一个字节不动，临时文件不残留", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    const result = await writeXlsxCells(
      path,
      [{ sheet: "Data", row: 5, col: 3, value: 42 }],
      undefined,
      {
        commit: async () => {
          throw new Error("disk full");
        },
      },
    );
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.error, /disk full/);
    assert.equal(Buffer.compare(before, await readFile(path)), 0);
    const leftovers = (await readdir(dir)).filter((name) => name !== "book.xlsx");
    assert.deepEqual(leftovers, []);
  });

  test("空改动：不写盘、回 ok(0)", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const before = await readFile(path);
    const result = await writeXlsxCells(path, []);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.cells, 0);
    assert.equal(Buffer.compare(before, await readFile(path)), 0);
  });
});

describe("writeXlsxCells —— 带前缀的 OOXML（OfficeCLI 重写过的文件）", () => {
  test("沿用文件自己的前缀，不把整份改写成另一种风格", async () => {
    const path = join(dir, "prefixed.xlsx");
    await sampleWorkbook(path);
    // 模拟 OfficeCLI 的重写：元素名与属性名都加上 `x:`（`xmlns` 不动，它是标准写法）
    const zip = await readZip(path);
    const part = zip.file(SHEET_PART);
    assert.ok(part !== null);
    const xml = await part.async("string");
    const prefixed = xml.replace(/<[^>]*>/g, (tag) => {
      const named = tag.replace(/^<(\/?)([A-Za-z_][\w.-]*)/, (_whole, slash: string, name: string) => `<${slash}x:${name}`);
      return named.replace(/(\s)([A-Za-z_][\w.-]*)(=)/g, (_whole, space: string, name: string, eq: string) =>
        name === "xmlns" ? _whole : `${space}x:${name}${eq}`,
      );
    });
    assert.match(prefixed, /<x:worksheet/);
    zip.file(SHEET_PART, prefixed);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await writeXlsxCells(path, [{ sheet: "Data", row: 5, col: 3, value: 42 }]);
    assert.equal(result.kind, "ok");
    const after = await sheetXml(path);
    assert.match(after, /<x:c (?:x:)?r="C5"><x:v>42<\/x:v><\/x:c>/);
    // 原来带前缀的元素没被换回无前缀的写法
    assert.match(after, /<x:sheetData/);
  });
});
