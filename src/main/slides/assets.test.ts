import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeAssetName, saveAssetBytes } from "./assets.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PNG2 = Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from([0x83])]); // 内容不同、头相同

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-assets-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveAssetBytes", () => {
  it("复制进 <名字>.assets/，返回相对路径与尺寸", async () => {
    const saved = await saveAssetBytes(join(dir, "花园.slides.json"), "hawker.png", PNG);
    assert.equal(saved.src, "花园.assets/hawker.png");
    assert.deepEqual([saved.info.width, saved.info.height], [1, 1]);
    assert.deepEqual(await readdir(join(dir, "花园.assets")), ["hawker.png"]);
  });

  it("同名同内容复用，同名不同内容加摘要后缀，不覆盖", async () => {
    const deck = join(dir, "b.slides.json");
    const a = await saveAssetBytes(deck, "x.png", PNG);
    const again = await saveAssetBytes(deck, "x.png", PNG);
    assert.equal(again.src, a.src);
    const other = await saveAssetBytes(deck, "x.png", PNG2);
    assert.notEqual(other.src, a.src);
    assert.equal((await readdir(join(dir, "b.assets"))).length, 2);
  });

  it("路径分隔符 / .. 被洗掉，不会写出 assets 目录", async () => {
    const saved = await saveAssetBytes(join(dir, "c.slides.json"), "../../etc/../passwd.png", PNG);
    assert.ok(saved.src.startsWith("c.assets/"));
    assert.ok(!saved.src.includes(".."));
    assert.equal(safeAssetName("a b/c d.JPG", "jpeg"), "c-d.jpg");
  });

  it("不是图片 / 空文件 / 超大 → 拒绝", async () => {
    const deck = join(dir, "d.slides.json");
    await assert.rejects(() => saveAssetBytes(deck, "a.png", Buffer.from("hello world, not an image at all....")), /不是支持的图片/);
    await assert.rejects(() => saveAssetBytes(deck, "a.png", new Uint8Array(0)), /空的/);
    await assert.rejects(() => saveAssetBytes(deck, "a.png", { length: 40 * 1024 * 1024 } as unknown as Uint8Array), /太大/);
  });
});
