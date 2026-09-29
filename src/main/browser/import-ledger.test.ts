import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseImportLedger, readImportLedger, recordImports, writeImportLedger } from "./import-ledger.ts";

const CHROME = { browserName: "Google Chrome", profileName: "Default" };

test("parseImportLedger：逐条校验，坏条目丢掉不连累别的；同一网站只留最新；按网站排序", () => {
  const parsed = parseImportLedger({
    version: 1,
    sites: [
      { site: "google.com", ...CHROME, importedAt: 2 },
      { site: "github.com", ...CHROME, importedAt: 1 },
      { site: "github.com", ...CHROME, importedAt: 5 },
      { site: "", ...CHROME, importedAt: 1 },
      { site: "bad.com", browserName: "Google Chrome", importedAt: 1 },
      { site: "nan.com", ...CHROME, importedAt: Number.NaN },
      null,
      "x",
    ],
  });
  assert.deepEqual(parsed, [
    { site: "github.com", ...CHROME, importedAt: 5 },
    { site: "google.com", ...CHROME, importedAt: 2 },
  ]);
});

test("parseImportLedger：整体形状不对回空", () => {
  assert.deepEqual(parseImportLedger(null), []);
  assert.deepEqual(parseImportLedger([]), []);
  assert.deepEqual(parseImportLedger({ sites: "github.com" }), []);
});

test("recordImports：本次的网站换成新来源与时刻，其余原样", () => {
  const before = [
    { site: "github.com", ...CHROME, importedAt: 1 },
    { site: "google.com", ...CHROME, importedAt: 1 },
  ];
  const after = recordImports(before, ["github.com", "arxiv.org"], { browserName: "Arc", profileName: "Work" }, 9);
  assert.deepEqual(after, [
    { site: "arxiv.org", browserName: "Arc", profileName: "Work", importedAt: 9 },
    { site: "github.com", browserName: "Arc", profileName: "Work", importedAt: 9 },
    { site: "google.com", ...CHROME, importedAt: 1 },
  ]);
});

test("readImportLedger：文件不在 / 坏 JSON 当空账本；写了再读原样回来", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-ledger-test-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, "browser-imports.json");
  assert.deepEqual(await readImportLedger(path), []);
  await writeFile(path, "{not json");
  assert.deepEqual(await readImportLedger(path), []);
  const entries = [{ site: "github.com", ...CHROME, importedAt: 3 }];
  await writeImportLedger(path, entries);
  assert.deepEqual(await readImportLedger(path), entries);
});
