import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendImportLedger, readImportLedger, type ImportLedgerLine } from "./import-ledger.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-ledger-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const line = (sessionId: string, at: number | null): ImportLedgerLine => ({
  at,
  action: at === null ? "backfill" : "import",
  source: "proma",
  sourceId: at === null ? null : `p-${sessionId}`,
  sourceFile: `/proma/${sessionId}.jsonl`,
  sessionId,
  title: `标题 ${sessionId}`,
});

describe("导入清单", () => {
  test("文件不存在 = 从没导过；追加两次都读得回来，顺序不变", async () => {
    const path = join(dir, "nested", "imports.jsonl");
    assert.deepEqual(await readImportLedger(path), []);
    await appendImportLedger(path, [line("a", null)]);
    await appendImportLedger(path, [line("b", 5), line("c", 5)]);
    assert.deepEqual(await readImportLedger(path), [line("a", null), line("b", 5), line("c", 5)]);
  });

  test("坏行与形状不对的行跳过，不挡其余；空批次不写文件", async () => {
    const path = join(dir, "imports.jsonl");
    await writeFile(
      path,
      [JSON.stringify(line("a", 1)), "{半行", JSON.stringify({ ...line("b", 2), action: "rename" }), JSON.stringify(line("c", 3))].join("\n"),
    );
    assert.deepEqual(
      (await readImportLedger(path)).map((entry) => entry.sessionId),
      ["a", "c"],
    );
    const empty = join(dir, "empty.jsonl");
    await appendImportLedger(empty, []);
    await assert.rejects(readFile(empty, "utf8"));
  });
});
