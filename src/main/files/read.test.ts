/** readPreview 的账：文本 / 截断 / 图片 / 超限图片 / 二进制 / 无扩展名文本 / 目录被拒。 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_TEXT_LIMIT } from "../../shared/files.ts";
import { readPdfFile, readPreview } from "./read.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-files-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readPreview", () => {
  test("md 文本：整份读进 text，不截断", async () => {
    const path = join(dir, "notes.md");
    await writeFile(path, "# hello\n\nworld", "utf8");
    const result = await readPreview(path);
    assert.equal(result.kind, "text");
    assert.ok(result.kind === "text");
    assert.equal(result.text, "# hello\n\nworld");
    assert.equal(result.truncated, false);
    assert.equal(result.size, Buffer.byteLength("# hello\n\nworld"));
    assert.equal(typeof result.modifiedAt, "number");
  });

  test("超过 limits.text 时截断，truncated=true 且 size 是完整大小", async () => {
    const path = join(dir, "big.txt");
    await writeFile(path, "0123456789", "utf8");
    const result = await readPreview(path, { text: 5, image: 1024 });
    assert.equal(result.kind, "text");
    assert.ok(result.kind === "text");
    assert.equal(result.text, "01234");
    assert.equal(result.truncated, true);
    assert.equal(result.size, 10);
  });

  test("截断边界落在 3 字节汉字中间：退掉半个字符，末尾不留 U+FFFD", async () => {
    // 「汉」= E6 B1 89。限 5 字节："abc" + 汉的前 2 字节 → 只能退到 "abc"
    const path = join(dir, "cjk-cut.txt");
    await writeFile(path, "abc汉字", "utf8");
    const result = await readPreview(path, { text: 5, image: 1024 });
    assert.ok(result.kind === "text");
    assert.equal(result.text, "abc");
    assert.equal(result.text.includes("\uFFFD"), false);
    assert.equal(result.truncated, true);
    assert.equal(result.size, 9);
  });

  test("截断边界落在 2 字节字符中间：同样退掉，不产出替换字符", async () => {
    // "é" = C3 A9。限 3 字节："ab" + C3 → 退到 "ab"
    const path = join(dir, "latin2-cut.txt");
    await writeFile(path, "abéx", "utf8");
    const result = await readPreview(path, { text: 3, image: 1024 });
    assert.ok(result.kind === "text");
    assert.equal(result.text, "ab");
    assert.equal(result.truncated, true);
  });

  test("截断边界正好落在字符边界上：不多退、不缺字", async () => {
    // 「汉」占 3 字节，限 6 字节恰好是 "abc" + 汉 的完整边界
    const path = join(dir, "cjk-exact.txt");
    await writeFile(path, "abc汉字", "utf8");
    const result = await readPreview(path, { text: 6, image: 1024 });
    assert.ok(result.kind === "text");
    assert.equal(result.text, "abc汉");
    assert.equal(result.truncated, true);
  });

  test("默认上限（16 MB）边界落在汉字中间：真尺寸下也不出 U+FFFD", async () => {
    // 让读到的第 16 MB 个字节正好落在「汉」的第 3 个字节之前：
    // 'a' 铺到 limit - 2，后面接「汉字」，读到 limit 字节时只剩「汉」的前 2 字节
    const path = join(dir, "cjk-16mb.txt");
    const prefix = Buffer.alloc(PREVIEW_TEXT_LIMIT - 2, 0x61);
    await writeFile(path, Buffer.concat([prefix, Buffer.from("汉字", "utf8")]));
    const result = await readPreview(path);
    assert.ok(result.kind === "text");
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, PREVIEW_TEXT_LIMIT - 2);
    assert.equal(result.text, "a".repeat(PREVIEW_TEXT_LIMIT - 2));
    assert.equal(result.text.includes("\uFFFD"), false);
    assert.equal(result.size, PREVIEW_TEXT_LIMIT + 4);
  });

  test("图片：按扩展名读成 base64，mime 对应扩展名", async () => {
    const path = join(dir, "pixel.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path, bytes);
    const result = await readPreview(path);
    assert.equal(result.kind, "image");
    assert.ok(result.kind === "image");
    assert.equal(result.mime, "image/png");
    assert.equal(result.base64, bytes.toString("base64"));
    assert.equal(result.size, bytes.length);
  });

  test("图片超过 limits.image：不读内容，回 too-large", async () => {
    const path = join(dir, "big.png");
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await writeFile(path, bytes);
    const result = await readPreview(path, { text: 1024, image: 5 });
    assert.equal(result.kind, "too-large");
    assert.ok(result.kind === "too-large");
    assert.equal(result.limit, 5);
    assert.equal(result.size, bytes.length);
  });

  test("开头有 NUL 字节：判成二进制，不读内容", async () => {
    const path = join(dir, "data.bin");
    const bytes = Buffer.from([0x41, 0x42, 0x00, 0x43]);
    await writeFile(path, bytes);
    const result = await readPreview(path);
    assert.equal(result.kind, "binary");
    assert.equal(result.size, bytes.length);
  });

  test("无扩展名的文本（LICENSE）照样读成 text", async () => {
    const path = join(dir, "LICENSE");
    await writeFile(path, "MIT License", "utf8");
    const result = await readPreview(path);
    assert.equal(result.kind, "text");
    assert.ok(result.kind === "text");
    assert.equal(result.text, "MIT License");
  });

  test("目录被拒", async () => {
    const path = join(dir, "sub");
    await mkdir(path);
    await assert.rejects(() => readPreview(path), /Not a file/);
  });
});

describe("readPdfFile", () => {
  test("整份字节读回 Uint8Array，size 与盘上一致", async () => {
    const path = join(dir, "doc.pdf");
    await writeFile(path, Buffer.from("%PDF-1.4\nbody"));
    const result = await readPdfFile(path);
    assert.ok(result.kind === "pdf");
    assert.ok(result.data instanceof Uint8Array);
    assert.equal(Buffer.from(result.data).toString("latin1"), "%PDF-1.4\nbody");
    assert.equal(result.size, 13);
  });

  test("超过上限不读，回 too-large", async () => {
    const path = join(dir, "big.pdf");
    await writeFile(path, Buffer.alloc(32));
    const result = await readPdfFile(path, 16);
    assert.deepEqual({ kind: result.kind, size: result.size }, { kind: "too-large", size: 32 });
  });

  test("目录被拒", async () => {
    await mkdir(join(dir, "x.pdf"));
    await assert.rejects(readPdfFile(join(dir, "x.pdf")), /Not a file/);
  });
});
