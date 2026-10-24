/**
 * `docx:save` 的账：hash 冲突不覆盖、缺失文件不重建、原子写、备份（含保留份数）、
 * 同路径串行。这些是「用户的原稿会不会丢」的全部防线，逐条测。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./read.ts";
import { saveDocxFile } from "./write.ts";

let dir = "";
let backupDir = "";
let path = "";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const hashOf = (bytes: Uint8Array): string => sha256Hex(bytes);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-docx-save-"));
  backupDir = join(dir, "backups");
  path = join(dir, "paper.docx");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveDocxFile", () => {
  test("hash 匹配：写入新内容，回 saved + 新 hash + size", async () => {
    const original = bytesOf("v1");
    await writeFile(path, original);
    const next = bytesOf("v2-longer");
    const result = await saveDocxFile({
      path,
      expectedHash: hashOf(original),
      data: next,
      backupDir,
    });
    assert.equal(result.kind, "saved");
    assert.ok(result.kind === "saved");
    assert.equal(result.hash, hashOf(next));
    assert.equal(result.size, next.byteLength);
    assert.deepEqual([...(await readFile(path))], [...next]);
  });

  test("备份：上一版原样复制进备份目录，回 backupPath", async () => {
    const original = bytesOf("first version");
    await writeFile(path, original);
    const result = await saveDocxFile({
      path,
      expectedHash: hashOf(original),
      data: bytesOf("second"),
      backupDir,
      now: () => Date.UTC(2026, 9, 24, 8, 0, 0),
    });
    assert.ok(result.kind === "saved" && result.backupPath !== null);
    assert.ok(result.backupPath !== null);
    assert.deepEqual([...(await readFile(result.backupPath))], [...original]);
    assert.ok(result.backupPath.startsWith(backupDir));
  });

  test("磁盘被外部改过：回 conflict(changed)，磁盘内容一个字节都不动", async () => {
    const original = bytesOf("mine");
    await writeFile(path, original);
    const external = bytesOf("someone else edited this");
    await writeFile(path, external);
    const result = await saveDocxFile({
      path,
      expectedHash: hashOf(original),
      data: bytesOf("my save"),
      backupDir,
    });
    assert.equal(result.kind, "conflict");
    assert.deepEqual(result.kind === "conflict" ? result.reason : null, "changed");
    assert.deepEqual([...(await readFile(path))], [...external]);
  });

  test("文件在外部被删：回 conflict(missing)，不悄悄重建", async () => {
    const result = await saveDocxFile({
      path: join(dir, "gone.docx"),
      expectedHash: hashOf(bytesOf("x")),
      data: bytesOf("y"),
      backupDir,
    });
    assert.deepEqual(result.kind === "conflict" ? result.reason : null, "missing");
    await assert.rejects(stat(join(dir, "gone.docx")));
  });

  test("原子写：写完之后目录里没有临时文件残留", async () => {
    const original = bytesOf("v1");
    await writeFile(path, original);
    await saveDocxFile({ path, expectedHash: hashOf(original), data: bytesOf("v2"), backupDir });
    const left = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(left, []);
  });

  test("备份只保留最近 keepBackups 份", async () => {
    let clock = Date.UTC(2026, 0, 1);
    let current = bytesOf("v0");
    await writeFile(path, current);
    for (let i = 1; i <= 4; i += 1) {
      clock += 1000;
      const next = bytesOf(`v${i}`);
      const result = await saveDocxFile({
        path,
        expectedHash: hashOf(current),
        data: next,
        backupDir,
        keepBackups: 2,
        now: () => clock,
      });
      assert.equal(result.kind, "saved");
      current = next;
    }
    const perFile = join(backupDir, (await readdir(backupDir))[0]!);
    const backups = (await readdir(perFile)).sort();
    assert.equal(backups.length, 2);
    // 留下的是最新的两份（v2、v3 之前的磁盘内容，即 v2 与 v3）
    assert.deepEqual(
      await Promise.all(backups.map(async (name) => (await readFile(join(perFile, name))).toString())),
      ["v2", "v3"],
    );
  });

  test("同路径串行：两条并发保存，后一条按前一条写入后的 hash 判冲突", async () => {
    const original = bytesOf("v1");
    await writeFile(path, original);
    const first = saveDocxFile({ path, expectedHash: hashOf(original), data: bytesOf("v2"), backupDir });
    const second = saveDocxFile({ path, expectedHash: hashOf(original), data: bytesOf("v3"), backupDir });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.kind, "saved");
    assert.equal(b.kind, "conflict");
    assert.equal((await readFile(path)).toString(), "v2");
  });

  test("没有 backupDir 时不备份（backupPath 为 null）", async () => {
    const original = bytesOf("v1");
    await writeFile(path, original);
    const result = await saveDocxFile({ path, expectedHash: hashOf(original), data: bytesOf("v2") });
    assert.ok(result.kind === "saved");
    assert.equal(result.backupPath, null);
  });

  test("拒绝写超过上限的内容", async () => {
    const original = bytesOf("v1");
    await writeFile(path, original);
    await assert.rejects(
      saveDocxFile({ path, expectedHash: hashOf(original), data: new Uint8Array(51 * 1024 * 1024) }),
      /Refusing to write/,
    );
  });

  test("备份目录按文件分开：同目录两个 docx 各有各的备份", async () => {
    const other = join(dir, "other.docx");
    await writeFile(path, bytesOf("a1"));
    await writeFile(other, bytesOf("b1"));
    await saveDocxFile({ path, expectedHash: hashOf(bytesOf("a1")), data: bytesOf("a2"), backupDir });
    await saveDocxFile({ path: other, expectedHash: hashOf(bytesOf("b1")), data: bytesOf("b2"), backupDir });
    const dirs = await readdir(backupDir);
    assert.equal(dirs.length, 2);
    await mkdir(join(backupDir, dirs[0]!), { recursive: true });
  });
});
