/**
 * 批写后补公式缓存值（2026-11-14 验收 B9）。
 *
 * OfficeCLI 重算后只写 `<f>` 不写 `<v>`，网格用缓存值当显示值 → 被改的行与汇总行变空。
 * 这里钉住补写器本身（不跑 officecli）：扫「有 f 没 v」、只补这些格、数值之外不写、
 * 没有缺缓存就不碰文件、带前缀与不带前缀两种文档都能写对。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { readXlsxPreview } from "../xlsx/read.ts";
import { fillMissingFormulaCaches, formulaCellKey, isNumericValue, MAX_CACHED_CELLS } from "./xlsx-cache.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "xlsx", "fixtures");

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-xlsx-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `<c …>…</c>`（允许前缀） */
const cellRe = (ref: string): RegExp =>
  new RegExp(`<((?:[A-Za-z0-9_.-]+:)?)c([^>]*\\br="${ref}"[^>]*)>([\\s\\S]*?)<\\/\\1c>`);

/** `<prefix:v>…</prefix:v>` */
const valueRe = /<(?:[A-Za-z0-9_.-]+:)?v>[^<]*<\/(?:[A-Za-z0-9_.-]+:)?v>/;

/** 复制样张并去掉指定格的缓存值（模拟 officecli 重算后的形态） */
async function withoutCaches(source: string, sheetXml: string, cells: readonly string[]): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(source));
  const xml = await zip.file(sheetXml)?.async("string");
  assert.ok(xml !== undefined);
  let next = xml;
  for (const ref of cells) {
    const cell = cellRe(ref);
    assert.ok(cell.test(next), `${ref} 应在样张里`);
    next = next.replace(cell, (_whole: string, prefix: string, attrs: string, inner: string) => {
      return `<${prefix}c${attrs}>${inner.replace(valueRe, "")}</${prefix}c>`;
    });
  }
  zip.file(sheetXml, next);
  const path = join(dir, `cached-${source.split(/[\\/]/).pop() as string}`);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

describe("isNumericValue", () => {
  test("数值文本才算；日期 / 字符串 / 空串不算", () => {
    for (const value of ["660", "-12", "0.5", ".25", "1e3", "2.5E-4"]) assert.equal(isNumericValue(value), true, value);
    for (const value of ["", "2026-01-02", "abc", "1,000", "55%"]) assert.equal(isNumericValue(value), false, value);
  });
});

describe("fillMissingFormulaCaches", () => {
  test("带前缀（x:）的工作表：只补缺缓存的格，不动其它格", async () => {
    const path = await withoutCaches(join(FIXTURES, "grid-edited.xlsx"), "xl/worksheets/sheet1.xml", ["E4", "E7"]);
    const before = await readXlsxPreview(path);
    assert.ok(before.kind === "workbook");
    assert.ok(before.normalized === true);
    assert.equal(before.sheet.rows[3]?.[4]?.text, ""); // E4 空
    assert.equal(before.sheet.rows[6]?.[4]?.text, ""); // E7 空
    assert.equal(before.sheet.rows[1]?.[4]?.text, "597"); // E2 仍然有缓存

    const asked: { sheet: string; cell: string }[] = [];
    const result = await fillMissingFormulaCaches(path, async (cells) => {
      asked.push(...cells);
      return new Map([
        [formulaCellKey("销售数据", "E4"), "660"],
        [formulaCellKey("销售数据", "E7"), "2378"],
      ]);
    });
    // 样张里缺缓存的三格：E4 / E7 / 汇总!B2（后者是跨表公式，本来就没缓存）
    assert.equal(result.missing, 3);
    assert.equal(result.patched, 2);
    assert.deepEqual(
      asked.map((entry) => `${entry.sheet}!${entry.cell}`).sort(),
      ["汇总!B2", "销售数据!E4", "销售数据!E7"],
    );

    const after = await readXlsxPreview(path);
    assert.ok(after.kind === "workbook");
    assert.equal(after.sheet.rows[3]?.[4]?.text, "660");
    assert.equal(after.sheet.rows[6]?.[4]?.text, "2378");
    assert.equal(after.sheet.rows[3]?.[4]?.formula, "C4*D4");
    // 没动过的格保持原样
    assert.equal(after.sheet.rows[1]?.[4]?.text, "597");
    assert.equal(after.sheet.rows[2]?.[4]?.text, "2598");
  });

  test("没有缺缓存：不调用取值、不写盘（mtime 不变）", async () => {
    const path = join(dir, "full.xlsx");
    // pristine 的每个公式格都有缓存值
    await copyFile(join(FIXTURES, "grid-pristine.xlsx"), path);
    const before = await stat(path);
    let called = false;
    const result = await fillMissingFormulaCaches(path, async () => {
      called = true;
      return new Map();
    });
    assert.deepEqual(result, { patched: 0, missing: 0 });
    assert.equal(called, false);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  });

  test("非数值结果（日期 / 字符串）不写 <v>，也不改文件", async () => {
    const path = await withoutCaches(join(FIXTURES, "grid-edited.xlsx"), "xl/worksheets/sheet1.xml", ["E4"]);
    const before = await readFile(path);
    const result = await fillMissingFormulaCaches(path, async () => new Map([[formulaCellKey("销售数据", "E4"), "2026-01-02"]]));
    assert.equal(result.patched, 0);
    assert.equal(result.missing, 3);
    assert.deepEqual(await readFile(path), before);
  });

  test("不带前缀（默认命名空间）的工作表同样能补", async () => {
    const path = await withoutCaches(join(FIXTURES, "grid-pristine.xlsx"), "xl/worksheets/sheet1.xml", ["E7"]);
    const result = await fillMissingFormulaCaches(path, async () => new Map([[formulaCellKey("销售数据", "E7"), "9999"]]));
    assert.equal(result.patched, 1);
    const after = await readXlsxPreview(path);
    assert.ok(after.kind === "workbook");
    assert.equal(after.sheet.rows[6]?.[4]?.text, "9999");
  });

  test("不是 zip / 读不了：回 0，不抛", async () => {
    const path = join(dir, "not-a-zip.xlsx");
    await writeFile(path, "nope");
    assert.deepEqual(await fillMissingFormulaCaches(path, async () => new Map()), { patched: 0, missing: 0 });
  });

  test("超过上限只补前 N 格（missing 照实报总数）", async () => {
    assert.ok(MAX_CACHED_CELLS > 0);
    const path = await withoutCaches(join(FIXTURES, "grid-edited.xlsx"), "xl/worksheets/sheet1.xml", ["E4", "E7"]);
    const asked: string[] = [];
    const result = await fillMissingFormulaCaches(
      path,
      async (cells) => {
        asked.push(...cells.map((entry) => entry.cell));
        return new Map([
          [formulaCellKey("销售数据", "E4"), "660"],
          [formulaCellKey("销售数据", "E7"), "2378"],
        ]);
      },
      { maxCells: 1 },
    );
    assert.equal(asked.length, 1);
    assert.equal(result.patched, 1);
    assert.equal(result.missing, 3);
  });
});
