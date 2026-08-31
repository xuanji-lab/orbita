import { beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextAtomic } from "./atomic-write.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTextAtomic", () => {
  test("正常路径：内容完整落盘，不留临时文件", async () => {
    const file = join(dir, "a.json");
    await writeTextAtomic(file, "hello\n");
    assert.equal(await readFile(file, "utf8"), "hello\n");
    assert.deepEqual(await readdir(dir), ["a.json"]);
  });

  test("并发写同一目标：落的是某一次的完整内容，无半截、无残留临时文件", async () => {
    // 随机后缀存在的理由就是这个场景——五个并发写不能互相踩掉对方的临时文件
    const file = join(dir, "a.json");
    const texts = ["一".repeat(10), "二".repeat(100), "三".repeat(1000), "四".repeat(50), "五".repeat(500)];
    await Promise.all(texts.map((text) => writeTextAtomic(file, text)));
    const final = await readFile(file, "utf8");
    assert.ok(texts.includes(final));
    assert.deepEqual(await readdir(dir), ["a.json"]);
  });

  test("非瞬时错误不无限重试：目标是目录时照原样抛（Windows 上走满三次退避后抛）", async () => {
    const asFile = join(dir, "occupied");
    await mkdir(asFile);
    await assert.rejects(writeTextAtomic(asFile, "x"));
    assert.deepEqual(await readdir(dir), ["occupied"]);
  });
});
