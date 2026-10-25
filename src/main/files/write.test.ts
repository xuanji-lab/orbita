/**
 * writeEditedFile 的账：正常写 / 冲突不写 / 强制写 / 超限 / 只改已有文件 / 同路径并发。
 * 冲突判定是这一层的核心：编辑器迟到的自动保存不能覆盖盘上更新过的内容。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, EDITOR_WRITE_LIMIT } from "../../shared/files.ts";
import { writeEditedFile } from "./write.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-files-write-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeEditedFile", () => {
  test("基线指纹对得上：写入、回新指纹与大小", async () => {
    const path = join(dir, "main.tex");
    await writeFile(path, "v1\n", "utf8");
    const result = await writeEditedFile(path, "v2\n", contentHash("v1\n"));
    assert.equal(result.kind, "written");
    assert.ok(result.kind === "written");
    assert.equal(await readFile(path, "utf8"), "v2\n");
    assert.equal(result.hash, contentHash("v2\n"));
    assert.equal(result.size, Buffer.byteLength("v2\n"));
    assert.equal(typeof result.modifiedAt, "number");
  });

  test("盘上被外部改过：回 conflict，一个字都不写，回的是盘上当前全文", async () => {
    const path = join(dir, "main.tex");
    await writeFile(path, "agent wrote this\n", "utf8");
    const result = await writeEditedFile(path, "my edit\n", contentHash("my baseline\n"));
    assert.equal(result.kind, "conflict");
    assert.ok(result.kind === "conflict");
    assert.equal(result.text, "agent wrote this\n");
    assert.equal(result.hash, contentHash("agent wrote this\n"));
    assert.equal(await readFile(path, "utf8"), "agent wrote this\n");
  });

  test("自身保存不算冲突：用上次写回的指纹再写一次，成功", async () => {
    const path = join(dir, "main.tex");
    await writeFile(path, "v1\n", "utf8");
    const first = await writeEditedFile(path, "v2\n", contentHash("v1\n"));
    assert.ok(first.kind === "written");
    const second = await writeEditedFile(path, "v3\n", first.hash);
    assert.equal(second.kind, "written");
    assert.equal(await readFile(path, "utf8"), "v3\n");
  });

  test("expectedHash=null（用户选「保留我的」）：跳过比对直接写", async () => {
    const path = join(dir, "main.tex");
    await writeFile(path, "theirs\n", "utf8");
    const result = await writeEditedFile(path, "mine\n", null);
    assert.equal(result.kind, "written");
    assert.equal(await readFile(path, "utf8"), "mine\n");
  });

  test("超过编辑器写盘上限：不写，回 too-large", async () => {
    const path = join(dir, "huge.tex");
    await writeFile(path, "small\n", "utf8");
    const text = "x".repeat(EDITOR_WRITE_LIMIT + 1);
    const result = await writeEditedFile(path, text, contentHash("small\n"));
    assert.equal(result.kind, "too-large");
    assert.ok(result.kind === "too-large");
    assert.equal(result.limit, EDITOR_WRITE_LIMIT);
    assert.equal(await readFile(path, "utf8"), "small\n");
  });

  test("只改已有文件：路径不存在 / 是目录都拒绝", async () => {
    await assert.rejects(() => writeEditedFile(join(dir, "missing.tex"), "x", null), /ENOENT/);
    const sub = join(dir, "folder");
    await mkdir(sub);
    await assert.rejects(() => writeEditedFile(sub, "x", null), /Not a file/);
  });

  test("同一路径的并发写排队：串行执行后两笔都落盘且无临时文件残留", async () => {
    const path = join(dir, "main.tex");
    await writeFile(path, "v0\n", "utf8");
    const base = contentHash("v0\n");
    const [a, b] = await Promise.all([
      writeEditedFile(path, "a\n", base),
      writeEditedFile(path, "b\n", base),
    ]);
    // 第一笔成功；第二笔的基线已被第一笔超过 → 冲突（这正是「不会互相覆盖」的意思）
    assert.equal(a.kind, "written");
    assert.equal(b.kind, "conflict");
    assert.equal(await readFile(path, "utf8"), "a\n");
    const left = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(left, []);
  });

  test("CRLF 文本原样写回（编辑器负责保留换行，这一层不转换）", async () => {
    const path = join(dir, "win.tex");
    await writeFile(path, "a\r\nb\r\n", "utf8");
    const result = await writeEditedFile(path, "a\r\nc\r\n", contentHash("a\r\nb\r\n"));
    assert.equal(result.kind, "written");
    assert.equal(await readFile(path, "utf8"), "a\r\nc\r\n");
    const stats = await stat(path);
    assert.ok(stats.size > 0);
  });
});
