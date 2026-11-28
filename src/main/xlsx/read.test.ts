/**
 * readXlsxPreview 的账：多表 / 选中表 / 合并区 / 冻结 / 公式缓存值 / 百分比 / 空表 /
 * 裁剪 / 太大 / 坏文件 / 加密容器。
 *
 * 样张在本测试里现造（ExcelJS 写、我们读）：比往仓里塞二进制样张可控——合并区、
 * 公式缓存值、冻结窗格都在几行里写清楚，边界也能按需造。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { readXlsxPreview } from "./read.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-xlsx-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 造一份样张：三张表 + 合并区 + 公式缓存值 + 冻结窗格 + 百分比 / 错误值 */
async function sampleWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("报表");
  first.addRow(["区域报表"]);
  first.mergeCells("A1:D1");
  first.addRow(["区域", "Q1", "Q2", "合计"]);
  first.mergeCells("A2:A3");
  first.getCell("A2").value = "华东";
  first.getCell("B2").value = 120;
  first.getCell("C2").value = 140;
  first.getCell("D2").value = { formula: "B2+C2", result: 260 };
  first.getCell("B3").value = 100;
  first.getCell("C3").value = 90;
  first.getCell("D3").value = { formula: "B3+C3", result: 190 };
  first.addRow(["华南", 220, 210, { formula: "B4+C4", result: 430 }]);
  first.getCell("F2").value = 0.1234;
  first.getCell("F2").numFmt = "0.00%";
  first.getCell("G2").value = { error: "#DIV/0!" };
  first.getCell("H2").value = { formula: "SUM(B2:B4)" }; // 没有缓存值（Excel 没算过就存盘）
  // 日期：ExcelJS 把墙钟时间塞在 UTC 字段里（见 dateText 注释）
  first.getCell("I2").value = new Date("2024-03-05T00:00:00Z");
  first.getCell("I2").numFmt = "yyyy-mm-dd";
  first.getCell("J2").value = new Date("2024-03-05T14:30:00Z");
  first.getCell("J2").numFmt = "yyyy-mm-dd hh:mm";
  first.getCell("K2").value = 45000; // 序列号，带日期格式 → 2023-03-15
  first.getCell("K2").numFmt = "yyyy-mm-dd";
  first.getCell("L2").value = true;
  first.getCell("M2").value = { text: "链接文字", hyperlink: "https://example.com" };
  first.getCell("N2").value = { formula: "B2*2", result: 240 };
  first.getCell("O2").value = { sharedFormula: "N2", result: 240 };
  first.views = [{ state: "frozen", xSplit: 1, ySplit: 2, topLeftCell: "B3" }];

  const second = workbook.addWorksheet("明细");
  second.addRow(["a", "b"]);
  second.addRow([1, 2]);
  workbook.addWorksheet("空表");
  await workbook.xlsx.writeFile(path);
}

describe("readXlsxPreview", () => {
  test("多表：按工作簿顺序给标签，默认打开第一张", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.equal(result.kind, "workbook");
    assert.ok(result.kind === "workbook");
    assert.deepEqual(
      result.sheets.map((sheet) => sheet.name),
      ["报表", "明细", "空表"],
    );
    assert.equal(result.active, 0);
    assert.equal(result.sheet.name, "报表");
    assert.equal(result.size > 0, true);
    assert.equal(typeof result.modifiedAt, "number");
  });

  test("选中表：sheet 下标切表，越界夹到范围内", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const second = await readXlsxPreview(path, { sheet: 1 });
    assert.ok(second.kind === "workbook");
    assert.equal(second.active, 1);
    assert.equal(second.sheet.name, "明细");
    const beyond = await readXlsxPreview(path, { sheet: 99 });
    assert.ok(beyond.kind === "workbook");
    assert.equal(beyond.active, 2);
    const negative = await readXlsxPreview(path, { sheet: -5 });
    assert.ok(negative.kind === "workbook");
    assert.equal(negative.active, 0);
  });

  test("值：数值 / 文本 / 公式缓存值 / 百分比 / 错误值 / 无缓存值的公式", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    const rows = result.sheet.rows;
    // A1 是合并区锚点："区域报表"
    assert.equal(rows[0]?.[0]?.text, "区域报表");
    const q1 = rows[1]?.[1];
    assert.equal(q1?.text, "120");
    assert.equal(q1?.numeric, true);
    const total = rows[1]?.[3];
    assert.equal(total?.text, "260");
    assert.equal(total?.formula, "B2+C2");
    assert.equal(total?.numeric, true);
    assert.equal(rows[1]?.[5]?.text, "12.34%");
    const error = rows[1]?.[6];
    assert.equal(error?.text, "#DIV/0!");
    assert.equal(error?.error, true);
    const uncached = rows[1]?.[7];
    assert.equal(uncached?.text, "");
    assert.equal(uncached?.formula, "SUM(B2:B4)");
  });

  test("合并区：0-based、含端点，覆盖的格子是 null", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.deepEqual(result.sheet.merges, [
      { top: 0, left: 0, bottom: 0, right: 3 },
      { top: 1, left: 0, bottom: 2, right: 0 },
    ]);
    // 合并区里被盖住的格子（B1 / A3）不重复带值
    assert.equal(result.sheet.rows[0]?.[1], null);
    assert.equal(result.sheet.rows[2]?.[0], null);
  });

  test("冻结窗格：xSplit / ySplit 变成前几列 / 前几行", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.deepEqual(result.sheet.frozen, { rows: 2, cols: 1 });
  });

  test("裁剪：整表计数照实，数据只给前 maxRows × maxCols，合并区跟着裁", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    // 报表是 4 行 × 15 列，这里只给 2 行 × 2 列
    const result = await readXlsxPreview(path, { maxRows: 2, maxCols: 2 });
    assert.ok(result.kind === "workbook");
    const sheet = result.sheet;
    assert.equal(sheet.rowCount, 4);
    assert.equal(sheet.colCount, 15);
    assert.equal(sheet.rows.length, 2);
    assert.equal(sheet.rows[0]?.length, 2);
    // A1:D1 裁成 A1:B1；A2:A3 裁完只剩一格（1×1 的合并区没有意义，丢掉）
    assert.deepEqual(sheet.merges, [{ top: 0, left: 0, bottom: 0, right: 1 }]);
    assert.equal(sheet.frozen.rows, 2);
    assert.equal(sheet.frozen.cols, 1);
  });

  test("空表：计数是 0、没有数据行", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path, { sheet: 2 });
    assert.ok(result.kind === "workbook");
    assert.equal(result.sheet.name, "空表");
    assert.equal(result.sheet.rowCount, 0);
    assert.equal(result.sheet.colCount, 0);
    assert.deepEqual(result.sheet.rows, []);
    assert.deepEqual(result.sheet.merges, []);
  });

  test("太大：不读内容，回 too-large 与上限", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path, { limit: 8 });
    assert.equal(result.kind, "too-large");
    assert.ok(result.kind === "too-large");
    assert.equal(result.limit, 8);
    assert.equal(result.size > 8, true);
  });

  test("坏文件：zip 头对但内容坏了 → unreadable / corrupt，带异常原文", async () => {
    const path = join(dir, "broken.xlsx");
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]));
    const result = await readXlsxPreview(path);
    assert.equal(result.kind, "unreadable");
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "corrupt");
    assert.equal(result.detail.length > 0, true);
  });

  test("不是 zip：纯文本改名成 .xlsx → unreadable / corrupt", async () => {
    const path = join(dir, "text.xlsx");
    await writeFile(path, "this is not a workbook", "utf8");
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "corrupt");
  });

  test("加密 / 旧格式：OLE2 容器 → unreadable / password", async () => {
    const path = join(dir, "locked.xlsx");
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "password");
  });

  test("目录不是文件：抛错（调用方的错，不是文件的错）", async () => {
    await assert.rejects(readXlsxPreview(dir), /Not a file/);
  });
});

describe("readXlsxPreview —— 日期", () => {
  test("整天：按墙钟显示，不按时区平移（UTC+8 上曾显示成 08:00）", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.equal(result.sheet.rows[1]?.[8]?.text, "2024-03-05");
  });

  test("带时间：14:30 就是 14:30（曾显示成 22:30）", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.equal(result.sheet.rows[1]?.[9]?.text, "2024-03-05 14:30");
  });

  test("日期序列号：45000 带日期格式 → 2023-03-15", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.equal(result.sheet.rows[1]?.[10]?.text, "2023-03-15");
  });
});

describe("readXlsxPreview —— 其它值形态", () => {
  test("布尔显示 TRUE / FALSE（Excel 的写法），不是 true / false", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.equal(result.sheet.rows[1]?.[11]?.text, "TRUE");
  });

  test("超链接：显示链接文字，不是 URL 也不是对象", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.equal(result.sheet.rows[1]?.[12]?.text, "链接文字");
  });

  test("共享公式：从格也带出翻译后的公式文本与缓存值", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    const master = result.sheet.rows[1]?.[13];
    assert.equal(master?.text, "240");
    assert.equal(master?.formula, "B2*2");
    const clone = result.sheet.rows[1]?.[14];
    assert.equal(clone?.text, "240");
    assert.equal(typeof clone?.formula, "string");
  });
});

describe("readXlsxPreview —— 隐藏表", () => {
  /** 三张表：可见 / 隐藏 / 非常隐藏，最后再一张可见 */
  async function hiddenWorkbook(path: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("可见一").addRow(["one"]);
    const hidden = workbook.addWorksheet("隐藏的");
    hidden.addRow(["secret"]);
    hidden.state = "hidden";
    const veryHidden = workbook.addWorksheet("也隐藏");
    veryHidden.addRow(["deeper secret"]);
    veryHidden.state = "veryHidden";
    workbook.addWorksheet("可见二").addRow(["two"]);
    await workbook.xlsx.writeFile(path);
  }

  test("隐藏表不出标签、也不能被切到：下标只数可见的表", async () => {
    const path = join(dir, "hidden.xlsx");
    await hiddenWorkbook(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "workbook");
    assert.deepEqual(
      result.sheets.map((sheet) => sheet.name),
      ["可见一", "可见二"],
    );
    // 表号 1 落在第二张**可见**表上（不是被隐藏的那张）
    const second = await readXlsxPreview(path, { sheet: 1 });
    assert.ok(second.kind === "workbook");
    assert.equal(second.sheet.name, "可见二");
    assert.equal(second.sheet.rows[0]?.[0]?.text, "two");
  });

  test("全部隐藏：给可读结论，不摊开隐藏内容", async () => {
    const path = join(dir, "all-hidden.xlsx");
    const workbook = new ExcelJS.Workbook();
    const hidden = workbook.addWorksheet("秘密");
    hidden.addRow(["secret"]);
    hidden.state = "hidden";
    await workbook.xlsx.writeFile(path);
    const result = await readXlsxPreview(path);
    assert.ok(result.kind === "unreadable");
    assert.equal(result.reason, "hidden");
  });
});

describe("readXlsxPreview —— 表号容错", () => {
  test("NaN / 小数 / 负数都夹成范围内的整数", async () => {
    const path = join(dir, "book.xlsx");
    await sampleWorkbook(path);
    const nan = await readXlsxPreview(path, { sheet: Number.NaN });
    assert.ok(nan.kind === "workbook");
    assert.equal(nan.active, 0);
    const fraction = await readXlsxPreview(path, { sheet: 1.7 });
    assert.ok(fraction.kind === "workbook");
    assert.equal(fraction.active, 1);
    const negative = await readXlsxPreview(path, { sheet: -3 });
    assert.ok(negative.kind === "workbook");
    assert.equal(negative.active, 0);
  });
});
