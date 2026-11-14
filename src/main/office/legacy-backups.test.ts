/**
 * 旧版 `workbench/office-backups/` 的启动清理：空目录删掉，非空的（旧备份）一律不动。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeEmptyLegacyOfficeBackupDirs } from "./legacy-backups.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-office-legacy-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("removeEmptyLegacyOfficeBackupDirs", () => {
  test("清掉空目录；有文件的保留；没有该目录的会话不受影响", async () => {
    await mkdir(join(dir, "s1", "office-backups"), { recursive: true });
    await mkdir(join(dir, "s2", "office-backups"), { recursive: true });
    await writeFile(join(dir, "s2", "office-backups", "old.xlsx"), "x");
    await mkdir(join(dir, "s3"), { recursive: true });
    await writeFile(join(dir, "stray.txt"), "not a dir");

    const removed = await removeEmptyLegacyOfficeBackupDirs(dir);
    assert.equal(removed, 1);
    assert.deepEqual((await readdir(join(dir, "s1"))).includes("office-backups"), false);
    assert.deepEqual(await readdir(join(dir, "s2", "office-backups")), ["old.xlsx"]);
    assert.deepEqual(await readdir(join(dir, "s3")), []);
  });

  test("根目录不存在：回 0，不抛（新装机器）", async () => {
    assert.equal(await removeEmptyLegacyOfficeBackupDirs(join(dir, "nope")), 0);
  });
});
